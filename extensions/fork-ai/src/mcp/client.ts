/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcess } from 'node:child_process';
import { readSse } from '../../../../fork/model-router/src/sse.ts';
import type { McpToolResult } from './naming.ts';

// A small Model Context Protocol client: JSON-RPC 2.0 over a local process (stdio) or HTTP
// (Streamable HTTP, with the older HTTP+SSE transport as a fallback). It lists tools and calls
// them; it answers ping and roots/list, and declines sampling and elicitation.
//
// Two protocol eras: servers today accept the 2025 initialize handshake, which Fork tries first.
// A server that only speaks the stateless 2026-07-28 revision turns initialize down as unknown;
// Fork then asks server/discover and sends the protocol version and capabilities with every
// request instead (in _meta, and as MCP-Protocol-Version / Mcp-Method / Mcp-Name over HTTP).

export const PROTOCOL_VERSION = '2025-06-18';
export const MODERN_PROTOCOL_VERSION = '2026-07-28';
const KNOWN_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const META = 'io.modelcontextprotocol/';
const INIT_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS = 30_000;

type Id = number | string;
export interface JsonRpcMessage {
	readonly jsonrpc: '2.0';
	readonly id?: Id;
	readonly method?: string;
	readonly params?: unknown;
	readonly result?: unknown;
	readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export interface McpTool {
	readonly name: string;
	readonly title?: string;
	readonly description?: string;
	readonly inputSchema: Record<string, unknown>;
	readonly annotations?: { readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean; readonly title?: string };
}

export class McpError extends Error {
	readonly code?: number;
	readonly status?: number;
	constructor(message: string, code?: number, status?: number) {
		super(message);
		this.name = 'McpError';
		this.code = code;
		this.status = status;
	}
}

export interface Transport {
	/** Starts the connection; messages from the server arrive through onMessage. */
	start(onMessage: (message: JsonRpcMessage) => void, onClose: (error?: Error) => void): Promise<void>;
	send(message: JsonRpcMessage): Promise<void>;
	close(): Promise<void>;
	/** Set after initialize, for transports that send it on every request. */
	protocolVersion?: string;
}

// --- stdio --------------------------------------------------------------------------------------

/** Splits a byte stream into lines; a line may arrive in pieces. */
export class LineSplitter {
	private buffer = '';
	push(chunk: string): string[] {
		this.buffer += chunk;
		const lines = this.buffer.split('\n');
		this.buffer = lines.pop() ?? '';
		return lines.map(line => line.replace(/\r$/, '')).filter(line => line.trim());
	}
}

export interface StdioOptions {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	readonly cwd?: string;
	readonly onStderr?: (text: string) => void;
}

export class StdioTransport implements Transport {
	private child: ChildProcess | undefined;
	private readonly options: StdioOptions;
	protocolVersion?: string;
	constructor(options: StdioOptions) {
		this.options = options;
	}

	start(onMessage: (message: JsonRpcMessage) => void, onClose: (error?: Error) => void): Promise<void> {
		return new Promise((resolve, reject) => {
			const windows = process.platform === 'win32';
			let child: ChildProcess;
			try {
				// On Windows, npx and friends are .cmd files that need a shell.
				child = spawn(this.options.command, [...this.options.args], {
					cwd: this.options.cwd,
					env: { ...process.env, ...this.options.env },
					stdio: ['pipe', 'pipe', 'pipe'],
					shell: windows,
					windowsHide: true,
				});
			} catch (error) {
				reject(error);
				return;
			}
			this.child = child;
			const lines = new LineSplitter();
			child.stdout!.setEncoding('utf8');
			child.stdout!.on('data', (chunk: string) => {
				for (const line of lines.push(chunk)) {
					try {
						onMessage(JSON.parse(line));
					} catch {
						this.options.onStderr?.(`[not JSON on stdout] ${line}\n`);
					}
				}
			});
			child.stderr!.setEncoding('utf8');
			child.stderr!.on('data', (chunk: string) => this.options.onStderr?.(chunk));
			let started = false;
			child.once('spawn', () => {
				started = true;
				resolve();
			});
			child.once('error', error => {
				if (!started) {
					reject(new McpError((error as NodeJS.ErrnoException).code === 'ENOENT' ? `Command not found: ${this.options.command}. Is it installed and on your PATH?` : error.message));
				} else {
					onClose(error);
				}
			});
			child.once('exit', (code, signal) => {
				this.child = undefined;
				onClose(code === 0 || signal === 'SIGTERM' ? undefined : new McpError(`The server exited${code !== null ? ` with code ${code}` : ` on ${signal}`}.`));
			});
			child.stdin!.on('error', () => { /* Reported through exit. */ });
		});
	}

	async send(message: JsonRpcMessage): Promise<void> {
		if (!this.child?.stdin?.writable) {
			throw new McpError('The server is not running.');
		}
		this.child.stdin.write(JSON.stringify(message) + '\n');
	}

	async close(): Promise<void> {
		const child = this.child;
		if (!child) {
			return;
		}
		child.stdin?.end();
		child.kill('SIGTERM');
		// A server that ignores SIGTERM is killed after a moment.
		setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill('SIGKILL');
			}
		}, 2000).unref?.();
	}
}

// --- HTTP ---------------------------------------------------------------------------------------

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

interface HttpOptions {
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly fetch?: FetchFn;
}

function httpError(status: number, body: string): McpError {
	const hint = status === 401 || status === 403 ? ' Check the token in "headers".' : '';
	let code: number | undefined;
	try {
		code = JSON.parse(body)?.error?.code;
	} catch {
		code = undefined;
	}
	return new McpError(`HTTP ${status}${body ? `: ${body.slice(0, 300)}` : ''}${hint}`, typeof code === 'number' ? code : undefined, status);
}

/** Header values must be ASCII; anything else travels as the spec's base64 sentinel. */
export function headerValue(value: string): string {
	return /^[\x20-\x7e]*$/.test(value) ? value : `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** The 2026-07-28 per-request headers: the method, and the tool, resource or prompt it names. */
export function modernHeaders(message: JsonRpcMessage): Record<string, string> {
	if (!message.method) {
		return {};
	}
	const params = (message.params ?? {}) as { name?: unknown; uri?: unknown };
	const target = message.method === 'tools/call' || message.method === 'prompts/get' ? params.name : message.method === 'resources/read' ? params.uri : undefined;
	return { 'mcp-method': message.method, ...(typeof target === 'string' ? { 'mcp-name': headerValue(target) } : {}) };
}

/** Streamable HTTP: every message is a POST; replies come back as JSON or as an SSE stream. */
export class StreamableHttpTransport implements Transport {
	private sessionId: string | undefined;
	private onMessage: ((message: JsonRpcMessage) => void) | undefined;
	private onClose: ((error?: Error) => void) | undefined;
	private readonly abort = new AbortController();
	private readonly options: HttpOptions;
	protocolVersion?: string;
	constructor(options: HttpOptions) {
		this.options = options;
	}

	private get fetch(): FetchFn {
		return this.options.fetch ?? ((url, init) => fetch(url, init));
	}

	private headers(): Record<string, string> {
		return {
			...this.options.headers,
			...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
			...(this.protocolVersion ? { 'mcp-protocol-version': this.protocolVersion } : {}),
		};
	}

	async start(onMessage: (message: JsonRpcMessage) => void, onClose: (error?: Error) => void): Promise<void> {
		this.onMessage = onMessage;
		this.onClose = onClose;
	}

	async send(message: JsonRpcMessage): Promise<void> {
		let response: Response;
		try {
			response = await this.fetch(this.options.url, {
				method: 'POST',
				headers: {
					...this.headers(),
					...(this.protocolVersion === MODERN_PROTOCOL_VERSION ? modernHeaders(message) : {}),
					'content-type': 'application/json',
					accept: 'application/json, text/event-stream',
				},
				body: JSON.stringify(message),
				signal: this.abort.signal,
			});
		} catch (error) {
			throw new McpError(`Could not reach ${new URL(this.options.url).host}: ${error instanceof Error ? error.message : String(error)}`);
		}
		const session = response.headers.get('mcp-session-id');
		if (session) {
			this.sessionId = session;
		}
		if (response.status === 404 && this.sessionId && message.method !== 'initialize') {
			this.onClose?.(new McpError('The server ended the session.'));
			throw new McpError('The server ended the session.', undefined, 404);
		}
		if (!response.ok) {
			throw httpError(response.status, await response.text().catch(() => ''));
		}
		if (response.status === 202 || !response.body) {
			return;
		}
		const type = response.headers.get('content-type') ?? '';
		if (type.includes('text/event-stream')) {
			// Read the stream in the background; the reply to this request is among its events.
			void (async () => {
				try {
					for await (const event of readSse(response.body!)) {
						if (event.data && (!event.event || event.event === 'message')) {
							this.deliver(event.data);
						}
					}
				} catch {
					// A cut stream fails the pending request through its timeout.
				}
			})();
		} else if (type.includes('application/json')) {
			this.deliver(await response.text());
		}
	}

	private deliver(data: string): void {
		try {
			const parsed = JSON.parse(data);
			for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
				this.onMessage?.(message);
			}
		} catch {
			// Not JSON-RPC; ignore.
		}
	}

	/** Opens the optional GET stream that carries server notifications such as tools/list_changed. */
	async listen(): Promise<void> {
		try {
			const response = await this.fetch(this.options.url, { method: 'GET', headers: { ...this.headers(), accept: 'text/event-stream' }, signal: this.abort.signal });
			if (!response.ok || !response.body || !(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
				await response.body?.cancel().catch(() => undefined);
				return;
			}
			for await (const event of readSse(response.body)) {
				if (event.data) {
					this.deliver(event.data);
				}
			}
		} catch {
			// Optional; servers may not offer it.
		}
	}

	async close(): Promise<void> {
		if (this.sessionId) {
			await this.fetch(this.options.url, { method: 'DELETE', headers: this.headers() }).catch(() => undefined);
		}
		this.abort.abort();
	}
}

/** The older HTTP+SSE transport: a GET stream names the URL to POST messages to. */
export class LegacySseTransport implements Transport {
	private endpoint: string | undefined;
	private readonly abort = new AbortController();
	private readonly options: HttpOptions;
	protocolVersion?: string;
	constructor(options: HttpOptions) {
		this.options = options;
	}

	private get fetch(): FetchFn {
		return this.options.fetch ?? ((url, init) => fetch(url, init));
	}

	start(onMessage: (message: JsonRpcMessage) => void, onClose: (error?: Error) => void): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new McpError('The SSE server did not send its message endpoint.')), INIT_TIMEOUT_MS);
			void (async () => {
				let response: Response;
				try {
					response = await this.fetch(this.options.url, { method: 'GET', headers: { ...this.options.headers, accept: 'text/event-stream' }, signal: this.abort.signal });
				} catch (error) {
					clearTimeout(timer);
					reject(new McpError(`Could not reach ${new URL(this.options.url).host}: ${error instanceof Error ? error.message : String(error)}`));
					return;
				}
				if (!response.ok || !response.body) {
					clearTimeout(timer);
					reject(httpError(response.status, await response.text().catch(() => '')));
					return;
				}
				try {
					for await (const event of readSse(response.body)) {
						if (event.event === 'endpoint') {
							this.endpoint = new URL(event.data.trim(), this.options.url).toString();
							clearTimeout(timer);
							resolve();
						} else if (event.data) {
							try {
								onMessage(JSON.parse(event.data));
							} catch {
								// Not JSON-RPC; ignore.
							}
						}
					}
					onClose(new McpError('The server closed the event stream.'));
				} catch (error) {
					if (!this.abort.signal.aborted) {
						onClose(error instanceof Error ? error : new Error(String(error)));
					}
				}
			})();
		});
	}

	async send(message: JsonRpcMessage): Promise<void> {
		if (!this.endpoint) {
			throw new McpError('Not connected.');
		}
		const response = await this.fetch(this.endpoint, {
			method: 'POST',
			headers: { ...this.options.headers, 'content-type': 'application/json' },
			body: JSON.stringify(message),
			signal: this.abort.signal,
		});
		if (!response.ok) {
			throw httpError(response.status, await response.text().catch(() => ''));
		}
		await response.body?.cancel().catch(() => undefined);
	}

	async close(): Promise<void> {
		this.abort.abort();
	}
}

// --- The client ---------------------------------------------------------------------------------

export interface ClientOptions {
	/** Folders offered to the server through roots/list. */
	readonly roots?: () => readonly { uri: string; name: string }[];
	readonly onToolsChanged?: () => void;
	readonly onClose?: (error?: Error) => void;
	readonly onLog?: (text: string) => void;
	readonly clientVersion?: string;
	/** Skip the 2025 handshake and speak 2026-07-28 straight away (for servers known to be modern). */
	readonly modern?: boolean;
}

interface Pending {
	resolve(result: unknown): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

export class McpClient {
	private nextId = 1;
	private readonly pending = new Map<Id, Pending>();
	private closed = false;
	serverInfo: { name?: string; version?: string } | undefined;
	instructions: string | undefined;
	capabilities: Record<string, unknown> = {};
	/** Which protocol era the server speaks, once connected. */
	era: 'legacy' | 'modern' = 'legacy';
	private readonly transport: Transport;
	private readonly options: ClientOptions;

	constructor(transport: Transport, options: ClientOptions = {}) {
		this.transport = transport;
		this.options = options;
	}

	private clientInfo() {
		return { name: 'Fork', version: this.options.clientVersion ?? '0' };
	}

	/** Connects: the initialize handshake, or server/discover for a server that only speaks 2026-07-28. */
	async connect(): Promise<void> {
		await this.transport.start(message => this.handle(message), error => this.closedBy(error));
		if (this.options.modern) {
			await this.discover();
			return;
		}
		try {
			await this.initialize();
		} catch (error) {
			if (!isUnknownHandshake(error) || this.closed) {
				throw error;
			}
			await this.discover();
		}
	}

	private async discover(): Promise<void> {
		this.era = 'modern';
		this.transport.protocolVersion = MODERN_PROTOCOL_VERSION;
		const result = await this.request('server/discover', {}, INIT_TIMEOUT_MS) as { supportedVersions?: string[]; capabilities?: Record<string, unknown>; instructions?: string; _meta?: Record<string, unknown> };
		if (!result?.supportedVersions?.includes(MODERN_PROTOCOL_VERSION)) {
			throw new McpError(`The server speaks MCP ${result?.supportedVersions?.join(', ') || 'versions Fork does not know'}; Fork speaks ${PROTOCOL_VERSION} and ${MODERN_PROTOCOL_VERSION}.`);
		}
		this.capabilities = result.capabilities ?? {};
		this.instructions = result.instructions;
		this.serverInfo = result._meta?.[`${META}serverInfo`] as { name?: string; version?: string } | undefined;
	}

	private async initialize(): Promise<void> {
		const result = await this.request('initialize', {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: { roots: { listChanged: false } },
			clientInfo: this.clientInfo(),
		}, INIT_TIMEOUT_MS) as { protocolVersion?: string; capabilities?: Record<string, unknown>; serverInfo?: { name?: string; version?: string }; instructions?: string };
		const version = result?.protocolVersion;
		if (version && !KNOWN_VERSIONS.includes(version)) {
			this.options.onLog?.(`Server speaks MCP ${version}; Fork asked for ${PROTOCOL_VERSION}. Trying anyway.\n`);
		}
		this.transport.protocolVersion = version ?? PROTOCOL_VERSION;
		this.capabilities = result?.capabilities ?? {};
		this.serverInfo = result?.serverInfo;
		this.instructions = result?.instructions;
		await this.notify('notifications/initialized');
		if (this.transport instanceof StreamableHttpTransport) {
			void this.transport.listen();
		}
	}

	async listTools(): Promise<McpTool[]> {
		const tools: McpTool[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 50; page++) {
			const result = await this.request('tools/list', cursor ? { cursor } : {}, LIST_TIMEOUT_MS) as { tools?: McpTool[]; nextCursor?: string };
			tools.push(...(result?.tools ?? []).filter(tool => tool && typeof tool.name === 'string'));
			cursor = result?.nextCursor;
			if (!cursor) {
				break;
			}
		}
		return tools;
	}

	async callTool(name: string, args: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<McpToolResult> {
		const result = await this.request('tools/call', { name, arguments: args }, timeoutMs, signal) as McpToolResult & { resultType?: string };
		if (result?.resultType === 'input_required') {
			throw new McpError(`${name} asked for more input (such as a confirmation or a model call), which Fork cannot provide yet.`);
		}
		return result;
	}

	async close(): Promise<void> {
		this.closed = true;
		this.failAll(new McpError('The connection was closed.'));
		await this.transport.close();
	}

	get isClosed(): boolean {
		return this.closed;
	}

	private request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
		if (this.closed) {
			return Promise.reject(new McpError('The server is not connected.'));
		}
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(pending.timer);
				this.pending.delete(id);
				signal?.removeEventListener('abort', onAbort);
			};
			const onAbort = () => {
				cleanup();
				void this.notify('notifications/cancelled', { requestId: id, reason: 'Cancelled by the user.' }).catch(() => undefined);
				reject(new McpError('Cancelled.', -32800));
			};
			const pending: Pending = {
				resolve: value => { cleanup(); resolve(value); },
				reject: error => { cleanup(); reject(error); },
				timer: setTimeout(() => {
					cleanup();
					void this.notify('notifications/cancelled', { requestId: id, reason: 'Timed out.' }).catch(() => undefined);
					reject(new McpError(`${method} timed out after ${Math.round(timeoutMs / 1000)} s.`));
				}, timeoutMs),
			};
			if (signal?.aborted) {
				clearTimeout(pending.timer);
				reject(new McpError('Cancelled.', -32800));
				return;
			}
			signal?.addEventListener('abort', onAbort, { once: true });
			this.pending.set(id, pending);
			this.transport.send({ jsonrpc: '2.0', id, method, params: this.withMeta(params) }).catch(error => pending.reject(error instanceof Error ? error : new Error(String(error))));
		});
	}

	/** In the 2026-07-28 era every request carries the version, capabilities and client name. */
	private withMeta(params: unknown): unknown {
		if (this.era !== 'modern') {
			return params;
		}
		const base = (params ?? {}) as Record<string, unknown>;
		return {
			...base,
			_meta: {
				...(base._meta as Record<string, unknown> | undefined),
				[`${META}protocolVersion`]: MODERN_PROTOCOL_VERSION,
				[`${META}clientCapabilities`]: {},
				[`${META}clientInfo`]: this.clientInfo(),
			},
		};
	}

	private notify(method: string, params?: unknown): Promise<void> {
		const withMeta = this.withMeta(params);
		return this.transport.send({ jsonrpc: '2.0', method, ...(withMeta !== undefined ? { params: withMeta } : {}) });
	}

	private respond(id: Id, result: unknown): void {
		void this.transport.send({ jsonrpc: '2.0', id, result }).catch(() => undefined);
	}

	private respondError(id: Id, code: number, message: string): void {
		void this.transport.send({ jsonrpc: '2.0', id, error: { code, message } }).catch(() => undefined);
	}

	private handle(message: JsonRpcMessage): void {
		if (message.method && message.id !== undefined) {
			// A request from the server.
			switch (message.method) {
				case 'ping':
					this.respond(message.id, {});
					break;
				case 'roots/list':
					this.respond(message.id, { roots: this.options.roots?.() ?? [] });
					break;
				default:
					this.respondError(message.id, -32601, `Fork does not support ${message.method}.`);
			}
			return;
		}
		if (message.method) {
			if (message.method === 'notifications/tools/list_changed') {
				this.options.onToolsChanged?.();
			} else if (message.method === 'notifications/message') {
				const params = message.params as { level?: string; data?: unknown } | undefined;
				this.options.onLog?.(`[${params?.level ?? 'log'}] ${typeof params?.data === 'string' ? params.data : JSON.stringify(params?.data)}\n`);
			}
			return;
		}
		if (message.id === undefined) {
			return;
		}
		const pending = this.pending.get(message.id);
		if (!pending) {
			return;
		}
		if (message.error) {
			pending.reject(new McpError(message.error.message || `Error ${message.error.code}`, message.error.code));
		} else {
			pending.resolve(message.result);
		}
	}

	private failAll(error: Error): void {
		for (const pending of [...this.pending.values()]) {
			pending.reject(error);
		}
	}

	private closedBy(error?: Error): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.failAll(error ?? new McpError('The server stopped.'));
		this.options.onClose?.(error);
	}
}

/** The ways a server says it does not know the 2025 handshake: method not found, or unsupported version. */
function isUnknownHandshake(error: unknown): boolean {
	return error instanceof McpError && (error.code === -32601 || error.code === -32022 || (error.status === 400 && /protocol version|-32022|initialize/i.test(error.message)));
}

/**
 * Connects to an HTTP server: Streamable HTTP first, then the older SSE transport when the server
 * turns the first POST down the way SSE-only servers do (400, 404 or 405).
 */
export async function connectHttp(url: string, headers: Readonly<Record<string, string>>, options: ClientOptions, mode: 'http' | 'sse', fetchFn?: FetchFn): Promise<{ client: McpClient; transport: 'streamable-http' | 'sse' }> {
	if (mode === 'http') {
		const client = new McpClient(new StreamableHttpTransport({ url, headers, fetch: fetchFn }), options);
		try {
			await client.connect();
			return { client, transport: 'streamable-http' };
		} catch (error) {
			await client.close().catch(() => undefined);
			if (!(error instanceof McpError && error.status && [400, 404, 405].includes(error.status))) {
				throw error;
			}
		}
	}
	const client = new McpClient(new LegacySseTransport({ url, headers, fetch: fetchFn }), options);
	await client.connect();
	return { client, transport: 'sse' };
}
