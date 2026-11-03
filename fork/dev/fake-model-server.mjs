/*---------------------------------------------------------------------------------------------
 *  Fork dev tools. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

// A fake OpenAI-compatible model for trying Fork without an API key.
//   node fork/dev/fake-model-server.mjs [port]      (default port 11999)
// In Fork: Add Model → Custom endpoint → http://127.0.0.1:11999/v1 → OpenAI-compatible → no key → fake-coder.
//
// Chat replies stream a short Markdown answer with a code block. Inline edits (Cmd+I) and Apply get a
// predictable two-part change to the selected code, so the red/green review has something to show.
// Agent mode runs a scripted fix of parseDate in fork/dev/sample-project, tests included.
// Embeddings: model fake-embed on /v1/embeddings returns word-hash vectors, so codebase search can be
// tried with an "embedding model" (Choose Embedding Model → Custom endpoint → same URL → fake-embed).

import http from 'node:http';

const port = Number(process.argv[2] ?? process.env.PORT ?? 11999);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function lastUserText(messages) {
	const user = [...(messages ?? [])].reverse().find(message => message.role === 'user');
	return typeof user?.content === 'string' ? user.content : '';
}

function commentPrefix(language) {
	return /python|shell|bash|yaml|ruby|perl|r$|toml|dockerfile|makefile/i.test(language) ? '#' : '//';
}

/** Adds a comment above the selection and marks its last line: two separate changes to review. */
function fakeEdit(prompt) {
	const selection = /<selection>\n([\s\S]*?)\n<\/selection>/.exec(prompt)?.[1] ?? '';
	const language = /language="([^"]*)"/.exec(prompt)?.[1] ?? '';
	const instruction = (/\nInstruction: ([^\n]*)/.exec(prompt)?.[1] ?? 'edit').replace(/^Apply this change.*$/, 'apply from chat');
	const lines = selection.split('\n');
	const indent = /^[ \t]*/.exec(lines.find(line => line.trim()) ?? '')[0];
	const prefix = commentPrefix(language);
	const out = [`${indent}${prefix} Fork AI test edit: ${instruction.slice(0, 60)}`, ...lines];
	if (lines.length > 2) {
		const last = out.length - 1;
		out[last] = `${out[last]} ${prefix} reviewed`;
	}
	return '```\n' + out.join('\n') + '\n```';
}

function fakeChat(prompt) {
	const file = /<file path="([^"]+)"/.exec(prompt)?.[1];
	const question = prompt.split('\n\n').pop()?.trim() || 'your question';
	return [
		`This is **Fork's fake test model**, so the answer is canned, but streaming, Markdown and code blocks are real.`,
		'',
		file ? `I received \`${file}\` as context, and you asked: _${question.slice(0, 80)}_` : `You asked: _${question.slice(0, 80)}_ (no file was attached).`,
		'',
		'Try the buttons on this block:',
		'',
		'```ts',
		'export function greet(name: string): string {',
		'\treturn `Hello, ${name}!`;',
		'}',
		'```',
		'',
		'1. **Copy** puts it on the clipboard',
		'2. **Insert** replaces the selection in your editor',
		'3. **Apply** opens the red/green review',
	].join('\n');
}

/**
 * Agent mode: a scripted run on the sample project. It searches, reads src/dates.ts, fixes the month in
 * parseDate, runs the tests (which asks you to approve) and sums up. It decides its next move from the
 * tool results it has seen since your last message.
 */
function fakeAgentStep(messages) {
	const lastUser = messages.map(message => message.role).lastIndexOf('user');
	const seen = messages.slice(lastUser + 1).filter(message => message.role === 'tool');
	const text = content => ({ choices: [{ delta: { content } }] });
	const calls = list => ({ choices: [{ delta: { tool_calls: list.map(([name, args], index) => ({ index, id: `fake_${seen.length}_${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) }, finish_reason: 'tool_calls' }] });
	const stop = { choices: [{ delta: {}, finish_reason: 'stop' }] };
	const dates = seen.find(message => /\tconst \[year, month, day\]/.test(String(message.content)));
	if (seen.length === 0) {
		return [text('I\'ll look for `parseDate` and read the file first. '), calls([['search', { query: 'parseDate' }], ['read_file', { path: 'src/dates.ts' }]])];
	}
	if (seen.length === 2) {
		if (!dates || !/new Date\(year, month, day\)/.test(String(dates.content))) {
			return [text('This is the fake test model; it only knows how to fix `parseDate` in the sample project, and that code looks different here. Nothing was changed.'), stop];
		}
		return [text('Months in JavaScript dates start at 0, so the month needs `- 1`. '), calls([['edit_file', { path: 'src/dates.ts', old_text: 'return new Date(year, month, day);', new_text: 'return new Date(year, month - 1, day);' }]])];
	}
	if (seen.length === 3) {
		return [text('Now the tests. '), calls([['run_command', { command: 'node --test' }]])];
	}
	const passed = /Exit code: 0/.test(String(seen[seen.length - 1]?.content));
	return [text(passed
		? 'Fixed `parseDate` in `src/dates.ts`: it now subtracts 1 from the month, and `node --test` passes.\n\nThis run came from **Fork\'s fake test model**. Use **Undo all** below to put the bug back and try again.'
		: 'I changed `parseDate`, but the tests did not pass (or did not run). Check the output above; **Undo all** puts the file back.'), stop];
}

/** Words that mean the same thing here share a slot, so the fake embeddings match a little by meaning. */
const SYNONYMS = new Map(Object.entries({ signin: 'login', authenticate: 'login', auth: 'login', password: 'login', calendar: 'date', day: 'date', month: 'date', year: 'date', greeting: 'greet', hello: 'greet', welcome: 'greet' }));
const DIMS = 256;

/** A deterministic bag-of-words vector: each word (identifiers split) adds to a hashed slot. */
function fakeEmbedding(text) {
	const vector = new Array(DIMS).fill(0);
	const words = text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 1);
	for (const raw of words) {
		const singular = raw.replace(/s$/, '');
		const word = SYNONYMS.get(singular) ?? singular;
		let hash = 2166136261;
		for (const char of word) {
			hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
		}
		vector[Math.abs(hash) % DIMS] += 1;
	}
	return vector;
}

const server = http.createServer((req, res) => {
	let body = '';
	req.on('data', chunk => { body += chunk; });
	req.on('end', async () => {
		console.log(new Date().toISOString(), req.method, req.url);
		if (req.method === 'GET' && req.url?.endsWith('/models')) {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-coder', object: 'model' }, { id: 'fake-embed', object: 'model' }] }));
			return;
		}
		if (req.method === 'POST' && req.url?.endsWith('/embeddings')) {
			const request = JSON.parse(body || '{}');
			if (!/embed/.test(String(request.model))) {
				res.writeHead(400, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ error: { message: `${request.model} does not support embeddings` } }));
				return;
			}
			const inputs = Array.isArray(request.input) ? request.input : [request.input];
			await sleep(20);
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ object: 'list', model: request.model, data: inputs.map((input, index) => ({ object: 'embedding', index, embedding: fakeEmbedding(String(input)) })) }));
			return;
		}
		if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
			res.writeHead(404, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: { message: `No route for ${req.method} ${req.url}` } }));
			return;
		}
		let request;
		try {
			request = JSON.parse(body);
		} catch {
			res.writeHead(400, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: { message: 'Body is not JSON' } }));
			return;
		}
		res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
		const send = chunk => res.write(`data: ${JSON.stringify(chunk)}\n\n`);

		const toolNames = (request.tools ?? []).map(tool => tool.function.name);
		if (toolNames.length && !toolNames.includes('read_file')) {
			// The connection test: call whatever tool it offers.
			send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: toolNames[0], arguments: '{"status":"ok"}' } }] }, finish_reason: 'tool_calls' }] });
			res.end('data: [DONE]\n\n');
			return;
		}
		if (toolNames.includes('read_file')) {
			await sleep(300);
			for (const chunk of fakeAgentStep(request.messages ?? [])) {
				send(chunk);
				await sleep(40);
			}
			res.end('data: [DONE]\n\n');
			return;
		}

		const prompt = lastUserText(request.messages);
		const isEdit = prompt.includes('<selection>');
		const text = isEdit ? fakeEdit(prompt) : fakeChat(prompt);
		await sleep(isEdit ? 600 : 300);
		for (const piece of text.match(/[\s\S]{1,12}/g) ?? []) {
			if (res.destroyed) {
				return;
			}
			send({ choices: [{ delta: { content: piece } }] });
			await sleep(isEdit ? 5 : 25);
		}
		send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: Math.round(prompt.length / 4), completion_tokens: Math.round(text.length / 4) } });
		res.end('data: [DONE]\n\n');
	});
});

server.listen(port, '127.0.0.1', () => {
	console.log(`Fake model ready at http://127.0.0.1:${port}/v1 (model: fake-coder)`);
});
