/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectHttp, headerValue, LineSplitter, McpClient, McpError, modernHeaders, type FetchFn, type JsonRpcMessage, type Transport } from '../src/mcp/client.ts';
import { describeServer, interpolate, parseJsonc, parseMcpConfig, serverFingerprint, type StdioServer } from '../src/mcp/config.ts';
import { formatToolResult, MAX_RESULT_CHARS, summarizeArguments, toolName } from '../src/mcp/naming.ts';

const vars = { env: { GITHUB_TOKEN: 'ghp_1', HOME: '/Users/me' }, workspaceFolder: '/work', userHome: '/Users/me' };

test('mcp.json in the Cursor format, with comments and variables', () => {
	const text = `{
		// GitHub, from npm
		"mcpServers": {
			"github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "\${env:GITHUB_TOKEN}" }, "autoApprove": ["get_issue"] },
			"files": { "command": "npx", "args": ["@modelcontextprotocol/server-filesystem", "\${workspaceFolder}"], "disabled": true, },
			"docs": { "url": "https://docs.example.com/mcp", "headers": { "Authorization": "Bearer \${env:DOCS_TOKEN}" }, "timeout": 5000 },
			"old": { "type": "sse", "url": "http://localhost:3001/sse" },
			"plain": { "url": "http://example.com/mcp" },
			"bad name!": { "command": "x" },
			"nothing": { "args": [] }
		}
	}`;
	const { servers, errors } = parseMcpConfig(text, 'project', vars);
	assert.deepEqual(servers.map(s => [s.name, s.transport, s.disabled]), [['github', 'stdio', false], ['files', 'stdio', true], ['docs', 'http', false], ['old', 'sse', false]]);
	const github = servers[0] as StdioServer;
	assert.deepEqual(github.env, { GITHUB_TOKEN: 'ghp_1' });
	assert.deepEqual(github.autoApprove, ['get_issue']);
	assert.deepEqual((servers[1] as StdioServer).args, ['@modelcontextprotocol/server-filesystem', '/work']);
	assert.equal(servers[2].timeoutMs, 5000);
	assert.deepEqual(errors, [
		'docs: environment variable DOCS_TOKEN is not set.',
		'plain: use https:// (plain http:// is allowed only for localhost).',
		'bad name!: names may only use letters, digits, ".", "_", "-" and "@".',
		'nothing: needs a "command" (a local server) or a "url" (a remote one).',
	]);
	assert.equal(describeServer(github), 'npx -y @modelcontextprotocol/server-github');

	assert.deepEqual(parseMcpConfig('', 'user', vars), { servers: [], errors: [] });
	assert.deepEqual(parseMcpConfig('{}', 'user', vars), { servers: [], errors: [] });
	assert.match(parseMcpConfig('{ nope', 'user', vars).errors[0], /^Not valid JSON/);
	assert.deepEqual(parseMcpConfig('{"servers": {"a": {"command": "x"}}}', 'user', vars).servers.map(s => s.name), ['a'], 'VS Code\'s "servers" key works too');
});

test('JSONC keeps comment-like text inside strings', () => {
	assert.deepEqual(parseJsonc('{"url": "https://a.b/c//d", "x": "/* no */", /* yes */ "y": [1,],}'), { url: 'https://a.b/c//d', x: '/* no */', y: [1] });
	assert.equal(interpolate('${env:NOPE}-${userHome}-${other}', vars), '-/Users/me-${other}');
});

test('trusting a project server means trusting its exact command', () => {
	const [a] = parseMcpConfig('{"mcpServers":{"a":{"command":"npx","args":["one"],"env":{"K":"secret1"}}}}', 'project', vars).servers;
	const [sameButOtherSecret] = parseMcpConfig('{"mcpServers":{"a":{"command":"npx","args":["one"],"env":{"K":"secret2"}}}}', 'project', vars).servers;
	const [changed] = parseMcpConfig('{"mcpServers":{"a":{"command":"npx","args":["two"]}}}', 'project', vars).servers;
	assert.equal(serverFingerprint(a), serverFingerprint(sameButOtherSecret), 'secret values are not part of it');
	assert.notEqual(serverFingerprint(a), serverFingerprint(changed));
});

test('tool names fit provider rules and stay unique', () => {
	assert.equal(toolName('github', 'create_issue'), 'mcp__github__create_issue');
	assert.equal(toolName('my server', 'do.thing/now'), 'mcp__my_server__do_thing_now');
	const long = toolName('a-very-long-server-name-for-testing', 'an_equally_long_tool_name_that_goes_on_and_on');
	assert.ok(long.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(long));
	assert.notEqual(long, toolName('a-very-long-server-name-for-testing', 'an_equally_long_tool_name_that_goes_on_and_on_2'));
	assert.equal(summarizeArguments({ path: 'a.ts', n: 2 }), '{ "path": "a.ts", "n": 2 }');
});

test('tool results become text for the model', () => {
	assert.deepEqual(formatToolResult({ content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }), { content: 'one\ntwo', isError: false });
	assert.match(formatToolResult({ content: [{ type: 'image', data: 'A'.repeat(4096), mimeType: 'image/png' }] }).content, /^\[image \(image\/png, 3 KB\) not shown/);
	assert.equal(formatToolResult({ content: [{ type: 'resource', resource: { uri: 'file:///a', text: 'hi' } }] }).content, '[resource file:///a]\nhi');
	assert.equal(formatToolResult({ content: [], structuredContent: { ok: 1 } }).content, '{\n  "ok": 1\n}');
	assert.deepEqual(formatToolResult({ isError: true }), { content: 'The tool failed without saying why.', isError: true });
	assert.match(formatToolResult({ content: [{ type: 'text', text: 'x'.repeat(MAX_RESULT_CHARS + 10) }] }).content, /… \[10 more characters cut\]$/);
});

test('lines split across chunks', () => {
	const lines = new LineSplitter();
	assert.deepEqual(lines.push('{"a":1}\n{"b"'), ['{"a":1}']);
	assert.deepEqual(lines.push(':2}\r\n\n'), ['{"b":2}']);
});

/** A server in memory: answers like a real one and records what the client sent. */
function fakeServer(options: { tools?: number; pageSize?: number; slow?: boolean } = {}) {
	const sent: JsonRpcMessage[] = [];
	let deliver: (message: JsonRpcMessage) => void = () => { };
	let close: (error?: Error) => void = () => { };
	const tools = Array.from({ length: options.tools ?? 3 }, (_, i) => ({ name: `tool${i}`, inputSchema: { type: 'object' } }));
	const transport: Transport = {
		async start(onMessage, onClose) { deliver = onMessage; close = onClose; },
		async close() { close(); },
		async send(message) {
			sent.push(message);
			const reply = (result: unknown) => queueMicrotask(() => deliver({ jsonrpc: '2.0', id: message.id, result }));
			switch (message.method) {
				case 'initialize': return reply({ protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fake', version: '1' } });
				case 'tools/list': {
					const size = options.pageSize ?? tools.length;
					const start = Number((message.params as { cursor?: string }).cursor ?? 0);
					return reply({ tools: tools.slice(start, start + size), ...(start + size < tools.length ? { nextCursor: String(start + size) } : {}) });
				}
				case 'tools/call': {
					const { name, arguments: args } = message.params as { name: string; arguments: Record<string, unknown> };
					if (options.slow) {
						return; // Never answers.
					}
					if (name === 'fail') {
						return queueMicrotask(() => deliver({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Unknown tool: fail' } }));
					}
					return reply({ content: [{ type: 'text', text: `${name}(${JSON.stringify(args)})` }] });
				}
			}
		},
	};
	return { transport, sent, deliver: (m: JsonRpcMessage) => deliver(m), close: (e?: Error) => close(e) };
}

test('the client initializes, pages through tools and calls one', async () => {
	const server = fakeServer({ tools: 5, pageSize: 2 });
	const client = new McpClient(server.transport, { clientVersion: '0.5.0' });
	await client.connect();
	assert.deepEqual(client.serverInfo, { name: 'fake', version: '1' });
	assert.deepEqual(server.sent[0].params, { protocolVersion: '2025-06-18', capabilities: { roots: { listChanged: false } }, clientInfo: { name: 'Fork', version: '0.5.0' } });
	assert.equal(server.sent[1].method, 'notifications/initialized');
	assert.equal(server.sent[1].id, undefined);
	assert.deepEqual((await client.listTools()).map(t => t.name), ['tool0', 'tool1', 'tool2', 'tool3', 'tool4']);
	assert.deepEqual(await client.callTool('tool1', { a: 1 }, 1000), { content: [{ type: 'text', text: 'tool1({"a":1})' }] });
	await assert.rejects(client.callTool('fail', {}, 1000), (error: McpError) => error.message === 'Unknown tool: fail' && error.code === -32602);
});

test('the client answers server requests and hears tool changes', async () => {
	const server = fakeServer();
	let changed = 0;
	const client = new McpClient(server.transport, { roots: () => [{ uri: 'file:///work', name: 'work' }], onToolsChanged: () => changed++ });
	await client.connect();
	server.deliver({ jsonrpc: '2.0', id: 'p1', method: 'ping' });
	server.deliver({ jsonrpc: '2.0', id: 'r1', method: 'roots/list' });
	server.deliver({ jsonrpc: '2.0', id: 's1', method: 'sampling/createMessage', params: {} });
	server.deliver({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
	await new Promise(r => setTimeout(r, 10));
	assert.deepEqual(server.sent.filter(m => m.id === 'p1')[0].result, {});
	assert.deepEqual(server.sent.filter(m => m.id === 'r1')[0].result, { roots: [{ uri: 'file:///work', name: 'work' }] });
	assert.equal(server.sent.filter(m => m.id === 's1')[0].error?.code, -32601);
	assert.equal(changed, 1);
});

test('calls time out or are cancelled, and the server is told', async () => {
	const server = fakeServer({ slow: true });
	const client = new McpClient(server.transport);
	await client.connect();
	await assert.rejects(client.callTool('x', {}, 30), /tools\/call timed out/);
	const abort = new AbortController();
	const call = client.callTool('x', {}, 10_000, abort.signal);
	abort.abort();
	await assert.rejects(call, /Cancelled/);
	const cancels = server.sent.filter(m => m.method === 'notifications/cancelled');
	assert.equal(cancels.length, 2);
	assert.deepEqual(cancels.map(m => (m.params as { reason: string }).reason), ['Timed out.', 'Cancelled by the user.']);
});

test('a server that stops fails pending calls and reports it', async () => {
	const server = fakeServer({ slow: true });
	let closedWith: Error | undefined;
	const client = new McpClient(server.transport, { onClose: error => { closedWith = error; } });
	await client.connect();
	const call = client.callTool('x', {}, 10_000);
	server.close(new McpError('The server exited with code 1.'));
	await assert.rejects(call, /exited with code 1/);
	assert.match(closedWith!.message, /exited with code 1/);
	assert.ok(client.isClosed);
	await assert.rejects(client.listTools(), /not connected/);
});

/** Streamable HTTP and legacy SSE servers, as fetch functions. */
function httpServer(kind: 'json' | 'sse' | 'legacy') {
	const posts: { url: string; headers: Record<string, string>; body: JsonRpcMessage }[] = [];
	let legacyStream: ReadableStreamDefaultController<Uint8Array> | undefined;
	const encoder = new TextEncoder();
	const answer = (message: JsonRpcMessage): unknown => {
		switch (message.method) {
			case 'initialize': return { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: kind } };
			case 'tools/list': return { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] };
			case 'tools/call': return { content: [{ type: 'text', text: 'echoed' }] };
			default: return undefined;
		}
	};
	const fetchFn: FetchFn = async (url, init) => {
		const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
		if (kind === 'legacy') {
			if (init.method === 'GET' && url.endsWith('/sse')) {
				return new Response(new ReadableStream({ start(controller) { legacyStream = controller; controller.enqueue(encoder.encode('event: endpoint\ndata: /messages?session=abc\n\n')); } }), { headers: { 'content-type': 'text/event-stream' } });
			}
			if (init.method === 'POST' && url.includes('/messages?session=abc')) {
				const body = JSON.parse(String(init.body));
				posts.push({ url, headers, body });
				const result = answer(body);
				if (body.id !== undefined) {
					legacyStream!.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`));
				}
				return new Response(null, { status: 202 });
			}
			return new Response('Method Not Allowed', { status: 405 });
		}
		if (init.method === 'GET') {
			return new Response(null, { status: 405 });
		}
		if (init.method === 'DELETE') {
			return new Response(null, { status: 200 });
		}
		const body = JSON.parse(String(init.body));
		posts.push({ url, headers, body });
		if (body.id === undefined) {
			return new Response(null, { status: 202 });
		}
		const reply = JSON.stringify({ jsonrpc: '2.0', id: body.id, result: answer(body) });
		const session = { 'mcp-session-id': 'sess-1' };
		return kind === 'json'
			? new Response(reply, { headers: { 'content-type': 'application/json', ...session } })
			: new Response(`event: message\ndata: ${reply}\n\n`, { headers: { 'content-type': 'text/event-stream', ...session } });
	};
	return { fetchFn, posts };
}

for (const kind of ['json', 'sse'] as const) {
	test(`Streamable HTTP with ${kind === 'json' ? 'JSON' : 'event-stream'} replies keeps the session`, async () => {
		const { fetchFn, posts } = httpServer(kind);
		const { client, transport } = await connectHttp('https://mcp.example.com/mcp', { authorization: 'Bearer t' }, {}, 'http', fetchFn);
		assert.equal(transport, 'streamable-http');
		assert.deepEqual((await client.listTools()).map(t => t.name), ['echo']);
		assert.deepEqual(await client.callTool('echo', {}, 1000), { content: [{ type: 'text', text: 'echoed' }] });
		assert.equal(posts[0].headers['mcp-session-id'], undefined);
		assert.equal(posts[0].headers.accept, 'application/json, text/event-stream');
		assert.equal(posts[0].headers.authorization, 'Bearer t');
		assert.equal(posts.at(-1)!.headers['mcp-session-id'], 'sess-1');
		assert.equal(posts.at(-1)!.headers['mcp-protocol-version'], '2025-03-26');
		await client.close();
	});
}

test('an SSE-only server is reached through the older transport', async () => {
	const { fetchFn, posts } = httpServer('legacy');
	const { client, transport } = await connectHttp('http://localhost:3001/sse', {}, {}, 'http', fetchFn);
	assert.equal(transport, 'sse');
	assert.deepEqual((await client.listTools()).map(t => t.name), ['echo']);
	assert.ok(posts.every(post => post.url === 'http://localhost:3001/messages?session=abc'));
	await client.close();
});

test('HTTP errors say what to check', async () => {
	const fetchFn: FetchFn = async () => new Response('bad token', { status: 401 });
	await assert.rejects(connectHttp('https://mcp.example.com/mcp', {}, {}, 'http', fetchFn), /HTTP 401: bad token Check the token in "headers"\./);
});

test('a server that only speaks 2026-07-28 is reached through server/discover', async () => {
	const sent: JsonRpcMessage[] = [];
	let deliver: (message: JsonRpcMessage) => void = () => { };
	const transport: Transport = {
		async start(onMessage) { deliver = onMessage; },
		async close() { },
		async send(message) {
			sent.push(message);
			const reply = (body: Partial<JsonRpcMessage>) => queueMicrotask(() => deliver({ jsonrpc: '2.0', id: message.id, ...body }));
			switch (message.method) {
				case 'initialize': return reply({ error: { code: -32601, message: 'Method not found: initialize' } });
				case 'server/discover': return reply({ result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'modern', version: '2' } } } });
				case 'tools/list': return reply({ result: { tools: [{ name: 'ask', inputSchema: {} }], ttlMs: 60000, cacheScope: 'public', resultType: 'complete' } });
				case 'tools/call': return reply({ result: (message.params as { name: string }).name === 'ask' ? { resultType: 'input_required', inputRequests: {} } : { content: [{ type: 'text', text: 'ok' }], resultType: 'complete' } });
			}
		},
	};
	const client = new McpClient(transport, { clientVersion: '0.5.0' });
	await client.connect();
	assert.equal(client.era, 'modern');
	assert.equal(transport.protocolVersion, '2026-07-28');
	assert.deepEqual(client.serverInfo, { name: 'modern', version: '2' });
	assert.deepEqual((await client.listTools()).map(t => t.name), ['ask']);
	const list = sent.find(m => m.method === 'tools/list')!;
	assert.deepEqual((list.params as { _meta: unknown })._meta, {
		'io.modelcontextprotocol/protocolVersion': '2026-07-28',
		'io.modelcontextprotocol/clientCapabilities': {},
		'io.modelcontextprotocol/clientInfo': { name: 'Fork', version: '0.5.0' },
	});
	assert.ok(!sent.some(m => m.method === 'notifications/initialized'));
	assert.deepEqual(await client.callTool('run', {}, 1000), { content: [{ type: 'text', text: 'ok' }], resultType: 'complete' });
	await assert.rejects(client.callTool('ask', {}, 1000), /asked for more input/);

	assert.deepEqual(modernHeaders({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } }), { 'mcp-method': 'tools/call', 'mcp-name': 'echo' });
	assert.deepEqual(modernHeaders({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), { 'mcp-method': 'tools/list' });
	assert.equal(headerValue('café'), '=?base64?Y2Fmw6k=?=');
});
