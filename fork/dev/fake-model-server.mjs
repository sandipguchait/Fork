/*---------------------------------------------------------------------------------------------
 *  Fork dev tools. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

// A fake OpenAI-compatible model for trying Fork without an API key.
//   node fork/dev/fake-model-server.mjs [port]      (default port 11999)
// In Fork: Add Model → Custom endpoint → http://127.0.0.1:11999/v1 → OpenAI-compatible → no key → fake-coder.
//
// Chat replies stream a short Markdown answer with a code block. Inline edits (Cmd+I) and Apply get a
// predictable two-part change to the selected code, so the red/green review has something to show.

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

const server = http.createServer((req, res) => {
	let body = '';
	req.on('data', chunk => { body += chunk; });
	req.on('end', async () => {
		console.log(new Date().toISOString(), req.method, req.url);
		if (req.method === 'GET' && req.url?.endsWith('/models')) {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-coder', object: 'model' }] }));
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

		if (request.tools?.length) {
			const tool = request.tools[0].function.name;
			send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: tool, arguments: '{"status":"ok"}' } }] }, finish_reason: 'tool_calls' }] });
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
