/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';

// MCP server settings, in the "mcpServers" format Cursor and Claude Desktop use, so an existing
// mcp.json can be copied over as it is:
//   { "mcpServers": {
//       "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "${env:GITHUB_TOKEN}" } },
//       "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${env:DOCS_TOKEN}" } } } }

export type ConfigSource = 'user' | 'project';

interface BaseServer {
	/** The key in mcpServers. */
	readonly name: string;
	readonly source: ConfigSource;
	readonly disabled: boolean;
	/** Tools of this server that run without asking, by their MCP name. */
	readonly autoApprove: readonly string[];
	/** Per tool call; servers that do slow work (a browser, a build) may need more. */
	readonly timeoutMs: number;
}

export interface StdioServer extends BaseServer {
	readonly transport: 'stdio';
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	readonly cwd?: string;
}

export interface HttpServer extends BaseServer {
	/** "http": Streamable HTTP, falling back to the older SSE transport. "sse": the older one only. */
	readonly transport: 'http' | 'sse';
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
}

export type ServerConfig = StdioServer | HttpServer;

export interface ParsedConfig {
	readonly servers: ServerConfig[];
	/** Problems worth showing; a bad entry is skipped, the rest still load. */
	readonly errors: string[];
}

export interface Variables {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly workspaceFolder?: string;
	readonly userHome?: string;
}

export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

/** JSON with // and /* comments and trailing commas, as VS Code settings files allow. */
export function parseJsonc(text: string): unknown {
	let out = '';
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			out += c;
			if (c === '\\') {
				out += text[++i] ?? '';
			} else if (c === '"') {
				inString = false;
			}
		} else if (c === '"') {
			inString = true;
			out += c;
		} else if (c === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') {
				i++;
			}
			out += '\n';
		} else if (c === '/' && text[i + 1] === '*') {
			i += 2;
			while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
				i++;
			}
			i++;
		} else {
			out += c;
		}
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** ${env:NAME}, ${workspaceFolder} and ${userHome}; unknown variables are left as they are. */
export function interpolate(value: string, variables: Variables, missing?: Set<string>): string {
	return value.replace(/\$\{(env:([A-Za-z_][A-Za-z0-9_]*)|workspaceFolder|userHome)\}/g, (whole, _all, envName: string | undefined) => {
		if (envName) {
			const found = variables.env[envName];
			if (found === undefined) {
				missing?.add(envName);
				return '';
			}
			return found;
		}
		const found = whole === '${workspaceFolder}' ? variables.workspaceFolder : variables.userHome;
		return found ?? whole;
	});
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function stringMap(value: unknown, variables: Variables, missing: Set<string>): Record<string, string> {
	const out: Record<string, string> = {};
	if (isRecord(value)) {
		for (const [key, entry] of Object.entries(value)) {
			if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
				out[key] = interpolate(String(entry), variables, missing);
			}
		}
	}
	return out;
}

/** Reads one mcp.json. Variables are filled in here, so what starts is exactly what the user sees. */
export function parseMcpConfig(text: string, source: ConfigSource, variables: Variables): ParsedConfig {
	const errors: string[] = [];
	let json: unknown;
	try {
		json = text.trim() ? parseJsonc(text) : {};
	} catch (error) {
		return { servers: [], errors: [`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
	}
	const root = isRecord(json) ? (isRecord(json.mcpServers) ? json.mcpServers : isRecord(json.servers) ? json.servers : undefined) : undefined;
	if (!root) {
		return { servers: [], errors: isRecord(json) && !Object.keys(json).length ? [] : ['Expected an object with "mcpServers".'] };
	}
	const servers: ServerConfig[] = [];
	for (const [name, raw] of Object.entries(root)) {
		if (!isRecord(raw)) {
			errors.push(`${name}: expected an object.`);
			continue;
		}
		if (!/^[\w.@-]{1,64}$/.test(name)) {
			errors.push(`${name}: names may only use letters, digits, ".", "_", "-" and "@".`);
			continue;
		}
		const missing = new Set<string>();
		const base = {
			name,
			source,
			disabled: raw.disabled === true || raw.enabled === false,
			autoApprove: Array.isArray(raw.autoApprove) ? raw.autoApprove.filter((t): t is string => typeof t === 'string') : [],
			timeoutMs: typeof raw.timeout === 'number' && raw.timeout > 0 ? raw.timeout : DEFAULT_TOOL_TIMEOUT_MS,
		};
		const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : undefined;
		if (typeof raw.command === 'string' && raw.command.trim() && type !== 'http' && type !== 'sse') {
			const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string | number => typeof a === 'string' || typeof a === 'number').map(a => interpolate(String(a), variables, missing)) : [];
			servers.push({
				...base,
				transport: 'stdio',
				command: interpolate(raw.command.trim(), variables, missing),
				args,
				env: stringMap(raw.env, variables, missing),
				...(typeof raw.cwd === 'string' ? { cwd: interpolate(raw.cwd, variables, missing) } : {}),
			});
		} else if (typeof raw.url === 'string' || typeof raw.serverUrl === 'string') {
			const url = interpolate(String(raw.url ?? raw.serverUrl).trim(), variables, missing);
			let parsed: URL;
			try {
				parsed = new URL(url);
			} catch {
				errors.push(`${name}: "${url}" is not a URL.`);
				continue;
			}
			const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(parsed.hostname);
			if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
				errors.push(`${name}: use https:// (plain http:// is allowed only for localhost).`);
				continue;
			}
			servers.push({ ...base, transport: type === 'sse' ? 'sse' : 'http', url, headers: stringMap(raw.headers, variables, missing) });
		} else {
			errors.push(`${name}: needs a "command" (a local server) or a "url" (a remote one).`);
			continue;
		}
		if (missing.size) {
			errors.push(`${name}: environment variable${missing.size === 1 ? '' : 's'} ${[...missing].join(', ')} ${missing.size === 1 ? 'is' : 'are'} not set.`);
		}
	}
	return { servers, errors };
}

/**
 * What a project server will run, hashed: trusting a project server means trusting this exact
 * command, so a changed mcp.json (a new branch, a pulled commit) asks again.
 */
export function serverFingerprint(server: ServerConfig): string {
	const what = server.transport === 'stdio'
		? { command: server.command, args: server.args, env: Object.keys(server.env).sort(), cwd: server.cwd }
		: { url: server.url };
	return createHash('sha256').update(JSON.stringify(what)).digest('hex').slice(0, 16);
}

/** One line for lists and prompts: the command line, or the URL. */
export function describeServer(server: ServerConfig): string {
	return server.transport === 'stdio' ? [server.command, ...server.args].join(' ') : server.url;
}
