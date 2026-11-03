/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'node:os';
import * as vscode from 'vscode';
import type { ToolDefinition } from '../../../../fork/model-router/src/index.ts';
import type { KeyValueStore } from '../modelStore.ts';
import { connectHttp, McpClient, StdioTransport, type McpTool } from './client.ts';
import { describeServer, parseMcpConfig, serverFingerprint, type ServerConfig } from './config.ts';
import { describeMcpCall, formatToolResult, MCP_PREFIX, toolName } from './naming.ts';

export const USER_CONFIG = () => vscode.Uri.joinPath(vscode.Uri.file(os.homedir()), '.fork', 'mcp.json');
export const PROJECT_CONFIG = (root: vscode.Uri) => vscode.Uri.joinPath(root, '.fork', 'mcp.json');

const TRUSTED_KEY = 'forkAi.mcp.trusted';
const DISABLED_KEY = 'forkAi.mcp.disabled';
const ALLOWED_TOOLS_KEY = 'forkAi.mcp.allowedTools';
const MAX_DESCRIPTION = 1024;
const MAX_INSTRUCTIONS = 1000;
const RESTART_DELAYS_MS = [1000, 5000, 15000];

export type ServerStatus = 'starting' | 'ready' | 'error' | 'stopped' | 'disabled' | 'untrusted';

export interface ServerState {
	readonly config: ServerConfig;
	status: ServerStatus;
	error?: string;
	tools: McpTool[];
	/** "stdio", "streamable-http" or "sse", and the protocol era, once connected. */
	transport?: string;
	era?: 'legacy' | 'modern';
	serverName?: string;
	instructions?: string;
	client?: McpClient;
	restarts: number;
}

export interface McpToolEntry {
	readonly definition: ToolDefinition;
	readonly server: string;
	readonly tool: McpTool;
}

const decoder = new TextDecoder();
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Starts the MCP servers in ~/.fork/mcp.json and the project's .fork/mcp.json, keeps their tool
 * lists, and runs tool calls for the agent. Project servers start only once the user trusts them.
 */
export class McpManager implements vscode.Disposable {
	private states = new Map<string, ServerState>();
	private configErrors: string[] = [];
	private generation = 0;
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.emitter.event;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly output: vscode.OutputChannel;
	private readonly workspaceState: KeyValueStore;
	private reloadTimer: ReturnType<typeof setTimeout> | undefined;
	private askedTrust = new Set<string>();

	constructor(workspaceState: KeyValueStore, output: vscode.OutputChannel) {
		this.workspaceState = workspaceState;
		this.output = output;
		this.disposables.push(this.emitter);
		const watch = (pattern: vscode.GlobPattern) => {
			const watcher = vscode.workspace.createFileSystemWatcher(pattern);
			const reload = () => this.reloadSoon();
			watcher.onDidChange(reload);
			watcher.onDidCreate(reload);
			watcher.onDidDelete(reload);
			this.disposables.push(watcher);
		};
		watch(new vscode.RelativePattern(vscode.Uri.joinPath(vscode.Uri.file(os.homedir()), '.fork'), 'mcp.json'));
		const root = this.root();
		if (root) {
			watch(new vscode.RelativePattern(root, '.fork/mcp.json'));
		}
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration(event => event.affectsConfiguration('forkAi.mcp') && this.reloadSoon()),
			vscode.workspace.onDidGrantWorkspaceTrust?.(() => this.reloadSoon()) ?? { dispose() { } },
		);
	}

	dispose(): void {
		this.generation++;
		clearTimeout(this.reloadTimer);
		for (const state of this.states.values()) {
			void state.client?.close();
		}
		vscode.Disposable.from(...this.disposables).dispose();
	}

	private root(): vscode.Uri | undefined {
		return vscode.workspace.workspaceFolders?.[0]?.uri;
	}

	private log(server: string, text: string): void {
		for (const line of text.replace(/\n$/, '').split('\n')) {
			this.output.appendLine(`[${server}] ${line}`);
		}
	}

	servers(): ServerState[] {
		return [...this.states.values()];
	}

	errors(): readonly string[] {
		return this.configErrors;
	}

	enabled(): boolean {
		return vscode.workspace.getConfiguration('forkAi.mcp').get<boolean>('enabled', true);
	}

	private reloadSoon(): void {
		clearTimeout(this.reloadTimer);
		this.reloadTimer = setTimeout(() => void this.reload(), 300);
	}

	private async readConfig(uri: vscode.Uri, source: 'user' | 'project'): Promise<ServerConfig[]> {
		let text: string;
		try {
			text = decoder.decode(await vscode.workspace.fs.readFile(uri));
		} catch {
			return [];
		}
		const parsed = parseMcpConfig(text, source, { env: process.env, workspaceFolder: this.root()?.fsPath, userHome: os.homedir() });
		const label = source === 'user' ? '~/.fork/mcp.json' : '.fork/mcp.json';
		this.configErrors.push(...parsed.errors.map(error => `${label}: ${error}`));
		for (const error of parsed.errors) {
			this.output.appendLine(`[config] ${label}: ${error}`);
		}
		return parsed.servers;
	}

	/** Reads both config files again and restarts what changed. */
	async reload(): Promise<void> {
		const generation = ++this.generation;
		this.configErrors = [];
		const configs = new Map<string, ServerConfig>();
		if (this.enabled()) {
			for (const server of await this.readConfig(USER_CONFIG(), 'user')) {
				configs.set(server.name, server);
			}
			const root = this.root();
			if (root) {
				// A project server of the same name wins over the user's.
				for (const server of await this.readConfig(PROJECT_CONFIG(root), 'project')) {
					configs.set(server.name, server);
				}
			}
		}
		if (generation !== this.generation) {
			return;
		}
		// Keep servers whose config did not change; stop the rest.
		const next = new Map<string, ServerState>();
		for (const [name, config] of configs) {
			const old = this.states.get(name);
			if (old && JSON.stringify(old.config) === JSON.stringify(config) && old.status !== 'untrusted' && old.status !== 'disabled') {
				next.set(name, old);
				this.states.delete(name);
			} else {
				next.set(name, { config, status: 'stopped', tools: [], restarts: 0 });
			}
		}
		for (const state of this.states.values()) {
			void state.client?.close();
		}
		this.states = next;
		this.fire();
		const untrusted: ServerState[] = [];
		for (const state of this.states.values()) {
			if (state.status === 'ready' || state.status === 'starting') {
				continue;
			}
			if (this.isDisabled(state.config)) {
				state.status = 'disabled';
			} else if (!this.isTrusted(state.config)) {
				state.status = 'untrusted';
				untrusted.push(state);
			} else {
				void this.startServer(state);
			}
		}
		this.fire();
		if (untrusted.length) {
			void this.askTrust(untrusted);
		}
	}

	// --- Trust and enablement -----------------------------------------------------------------

	private isTrusted(config: ServerConfig): boolean {
		if (config.source === 'user') {
			return true;
		}
		if (!vscode.workspace.isTrusted) {
			return false;
		}
		const trusted = this.workspaceState.get<Record<string, string>>(TRUSTED_KEY) ?? {};
		return trusted[config.name] === serverFingerprint(config);
	}

	private isDisabled(config: ServerConfig): boolean {
		return config.disabled || (this.workspaceState.get<string[]>(DISABLED_KEY) ?? []).includes(config.name);
	}

	/** Project servers run commands from the repository, so the user says yes to each exact command first. */
	private async askTrust(states: ServerState[]): Promise<void> {
		const fresh = states.filter(state => !this.askedTrust.has(`${state.config.name}:${serverFingerprint(state.config)}`));
		if (!fresh.length) {
			return;
		}
		fresh.forEach(state => this.askedTrust.add(`${state.config.name}:${serverFingerprint(state.config)}`));
		if (!vscode.workspace.isTrusted) {
			void vscode.window.showInformationMessage('This project has MCP servers in .fork/mcp.json. Trust the workspace to be able to start them.');
			return;
		}
		const lines = fresh.map(state => `${state.config.name}: ${describeServer(state.config)}${state.config.autoApprove.length ? ` (runs ${state.config.autoApprove.join(', ')} without asking)` : ''}`);
		const choice = await vscode.window.showWarningMessage(
			`This project's .fork/mcp.json wants to start ${fresh.length === 1 ? 'an MCP server' : `${fresh.length} MCP servers`}. Start ${fresh.length === 1 ? 'it' : 'them'}?`,
			{ modal: true, detail: `${lines.join('\n')}\n\nLocal servers run as programs on your computer. Only start servers you recognize. Fork asks again if the command changes.` },
			'Start',
		);
		if (choice === 'Start') {
			await this.trust(fresh.map(state => state.config.name));
		}
	}

	async trust(names: readonly string[]): Promise<void> {
		const trusted = { ...(this.workspaceState.get<Record<string, string>>(TRUSTED_KEY) ?? {}) };
		for (const name of names) {
			const state = this.states.get(name);
			if (state) {
				trusted[name] = serverFingerprint(state.config);
			}
		}
		await this.workspaceState.update(TRUSTED_KEY, trusted);
		for (const name of names) {
			const state = this.states.get(name);
			if (state && state.status === 'untrusted' && !this.isDisabled(state.config)) {
				void this.startServer(state);
			}
		}
	}

	async setEnabled(name: string, enabled: boolean): Promise<void> {
		const disabled = new Set(this.workspaceState.get<string[]>(DISABLED_KEY) ?? []);
		if (enabled) {
			disabled.delete(name);
		} else {
			disabled.add(name);
		}
		await this.workspaceState.update(DISABLED_KEY, [...disabled]);
		const state = this.states.get(name);
		if (!state) {
			return;
		}
		if (!enabled) {
			await state.client?.close();
			state.client = undefined;
			state.tools = [];
			state.status = 'disabled';
			this.fire();
		} else if (state.config.disabled) {
			void vscode.window.showInformationMessage(`${name} is turned off in its mcp.json ("disabled": true).`);
		} else if (!this.isTrusted(state.config)) {
			state.status = 'untrusted';
			this.askedTrust.clear();
			await this.askTrust([state]);
		} else {
			void this.startServer(state);
		}
	}

	async restart(name: string): Promise<void> {
		const state = this.states.get(name);
		if (!state || state.status === 'disabled' || state.status === 'untrusted') {
			return;
		}
		state.restarts = 0;
		await state.client?.close();
		state.client = undefined;
		await this.startServer(state);
	}

	// --- Running servers ----------------------------------------------------------------------

	private async startServer(state: ServerState): Promise<void> {
		const generation = this.generation;
		const { config } = state;
		state.status = 'starting';
		state.error = undefined;
		this.fire();
		this.output.appendLine(`[${config.name}] starting: ${describeServer(config)}`);
		const root = this.root();
		let client: McpClient | undefined;
		const options = {
			clientVersion: '0.5.0',
			roots: () => root ? [{ uri: root.toString(), name: vscode.workspace.name ?? 'workspace' }] : [],
			onToolsChanged: () => void this.refreshTools(state),
			onLog: (text: string) => this.log(config.name, text),
			onClose: (error?: Error) => this.closed(state, client, error),
		};
		try {
			if (config.transport === 'stdio') {
				client = new McpClient(new StdioTransport({
					command: config.command,
					args: config.args,
					env: config.env,
					cwd: config.cwd ?? root?.fsPath ?? os.homedir(),
					onStderr: text => this.log(config.name, text),
				}), options);
				await client.connect();
				state.transport = 'stdio';
			} else {
				const connected = await connectHttp(config.url, config.headers, options, config.transport);
				client = connected.client;
				state.transport = connected.transport;
			}
			if (generation !== this.generation || this.states.get(config.name) !== state) {
				await client.close();
				return;
			}
			state.client = client;
			state.era = client.era;
			state.serverName = client.serverInfo?.name;
			state.instructions = client.instructions;
			state.tools = await client.listTools();
			state.status = 'ready';
			this.output.appendLine(`[${config.name}] ready: ${state.tools.length} tools over ${state.transport}${client.era === 'modern' ? ' (MCP 2026-07-28)' : ''}`);
		} catch (error) {
			await client?.close().catch(() => undefined);
			state.client = undefined;
			state.status = 'error';
			state.error = messageOf(error);
			this.output.appendLine(`[${config.name}] failed: ${state.error}`);
		}
		this.fire();
	}

	private closed(state: ServerState, client: McpClient | undefined, error?: Error): void {
		if (state.client !== client || state.status !== 'ready') {
			return;
		}
		state.client = undefined;
		state.tools = [];
		state.status = 'error';
		state.error = error?.message ?? 'The server stopped.';
		this.output.appendLine(`[${state.config.name}] stopped: ${state.error}`);
		this.fire();
		// Crashed servers come back a few times, further apart each time.
		const delay = RESTART_DELAYS_MS[state.restarts];
		if (delay !== undefined) {
			state.restarts++;
			const generation = this.generation;
			setTimeout(() => {
				if (generation === this.generation && this.states.get(state.config.name) === state && state.status === 'error') {
					void this.startServer(state);
				}
			}, delay);
		}
	}

	private async refreshTools(state: ServerState): Promise<void> {
		try {
			if (state.client) {
				state.tools = await state.client.listTools();
				this.fire();
			}
		} catch (error) {
			this.output.appendLine(`[${state.config.name}] could not refresh tools: ${messageOf(error)}`);
		}
	}

	// --- Tools for the agent ------------------------------------------------------------------

	/** Every tool of every running server, named so providers accept them and they never collide. */
	agentTools(): McpToolEntry[] {
		const entries: McpToolEntry[] = [];
		const used = new Set<string>();
		for (const state of this.states.values()) {
			if (state.status !== 'ready') {
				continue;
			}
			for (const tool of state.tools) {
				let name = toolName(state.config.name, tool.name);
				for (let n = 2; used.has(name); n++) {
					name = toolName(state.config.name, `${tool.name}_${n}`);
				}
				used.add(name);
				const description = `[MCP server ${state.config.name}] ${tool.description ?? tool.title ?? tool.annotations?.title ?? tool.name}`;
				const schema = tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : {};
				entries.push({
					definition: {
						name,
						description: description.length > MAX_DESCRIPTION ? description.slice(0, MAX_DESCRIPTION - 1) + '…' : description,
						inputSchema: { type: 'object', properties: {}, ...schema },
					},
					server: state.config.name,
					tool,
				});
			}
		}
		return entries;
	}

	/** Notes from the running servers for the agent's instructions, short. */
	instructions(): string {
		const parts: string[] = [];
		for (const state of this.states.values()) {
			if (state.status === 'ready' && state.tools.length && state.instructions?.trim()) {
				const text = state.instructions.trim();
				parts.push(`${state.config.name}: ${text.length > MAX_INSTRUCTIONS ? text.slice(0, MAX_INSTRUCTIONS) + '…' : text}`);
			}
		}
		return parts.join('\n\n');
	}

	/** Looks a model-facing tool name up, from a list made at the start of the turn. */
	resolve(name: string, entries: readonly McpToolEntry[]): McpToolEntry | undefined {
		return name.startsWith(MCP_PREFIX) ? entries.find(entry => entry.definition.name === name) : undefined;
	}

	describe(entry: McpToolEntry): string {
		return describeMcpCall(entry.server, entry.tool.annotations?.title ?? entry.tool.title ?? entry.tool.name);
	}

	/** Whether a call runs without asking: listed in autoApprove, or the user chose Always allow. */
	isAllowed(entry: McpToolEntry): boolean {
		const state = this.states.get(entry.server);
		if (state?.config.autoApprove.includes(entry.tool.name)) {
			return true;
		}
		return (this.workspaceState.get<string[]>(ALLOWED_TOOLS_KEY) ?? []).includes(`${entry.server}/${entry.tool.name}`);
	}

	async allowAlways(entry: McpToolEntry): Promise<void> {
		const allowed = new Set(this.workspaceState.get<string[]>(ALLOWED_TOOLS_KEY) ?? []);
		allowed.add(`${entry.server}/${entry.tool.name}`);
		await this.workspaceState.update(ALLOWED_TOOLS_KEY, [...allowed]);
	}

	async call(entry: McpToolEntry, args: Record<string, unknown>, signal: AbortSignal): Promise<{ content: string; isError: boolean }> {
		const state = this.states.get(entry.server);
		if (!state?.client || state.status !== 'ready') {
			return { content: `The MCP server ${entry.server} is not running${state?.error ? `: ${state.error}` : ''}.`, isError: true };
		}
		try {
			return formatToolResult(await state.client.callTool(entry.tool.name, args, state.config.timeoutMs, signal));
		} catch (error) {
			return { content: `${entry.server} could not run ${entry.tool.name}: ${messageOf(error)}`, isError: true };
		}
	}

	private fire(): void {
		this.emitter.fire();
	}
}
