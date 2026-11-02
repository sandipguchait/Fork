/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelRouterError, type ChatRequest, type StreamEvent, type ToolCallPart } from '../../../fork/model-router/src/index.ts';
import { approvalFor, isDangerousCommand } from '../src/agent/approvals.ts';
import { runAgent, type ToolOutcome } from '../src/agent/loop.ts';
import { AGENT_TOOLS, describeToolCall, MAX_READ_LINES, normalizeRelativePath, numberLines, replaceText, truncateOutput } from '../src/agent/tools.ts';
import { buildMessages } from '../src/context.ts';
import type { ChatTurn } from '../src/history.ts';

test('edit_file replaces exactly one match, or all with replace_all', () => {
	assert.deepEqual(replaceText('a = 1;\nb = 2;\n', 'b = 2;', 'b = 3;'), { ok: true, content: 'a = 1;\nb = 3;\n', count: 1 });
	assert.match((replaceText('x\nx\n', 'x', 'y') as { error: string }).error, /appears 2 times/);
	assert.deepEqual(replaceText('x\nx\n', 'x', 'y', true), { ok: true, content: 'y\ny\n', count: 2 });
	assert.match((replaceText('abc', 'zzz', 'y') as { error: string }).error, /not found/);
	assert.match((replaceText('abc', '', 'y') as { error: string }).error, /create_file/);
	assert.deepEqual(replaceText('one\r\ntwo\r\n', 'one\ntwo', 'uno\ndos'), { ok: true, content: 'uno\r\ndos\r\n', count: 1 }, 'CRLF files');
	assert.deepEqual(replaceText('price: $1', 'price', '$&cost'), { ok: true, content: '$&cost: $1', count: 1 }, 'no regex replacement patterns');
});

test('paths cannot leave the workspace', () => {
	assert.equal(normalizeRelativePath('./src//a.ts'), 'src/a.ts');
	assert.equal(normalizeRelativePath('src/../lib/b.ts'), 'lib/b.ts');
	assert.equal(normalizeRelativePath('src\\win\\c.ts'), 'src/win/c.ts');
	assert.equal(normalizeRelativePath('../secret'), undefined);
	assert.equal(normalizeRelativePath('src/../../etc/passwd'), undefined);
	assert.equal(normalizeRelativePath(''), undefined);
	assert.equal(normalizeRelativePath('.'), undefined);
});

test('reads come back numbered and capped', () => {
	assert.equal(numberLines('a\nb\nc', 2), '2\tb\n3\tc');
	assert.equal(numberLines('a\nb\nc', 1, 2), '1\ta\n2\tb\n… 1 more lines. Read on with start_line 3.');
	const big = Array.from({ length: MAX_READ_LINES + 10 }, (_, i) => `l${i}`).join('\n');
	assert.match(numberLines(big), /… 10 more lines\. Read on with start_line 2001\.$/);
	assert.equal(truncateOutput('x'.repeat(10), 20), 'x'.repeat(10));
	assert.match(truncateOutput('a'.repeat(50) + 'b'.repeat(50), 20), /^a{10}\n… \[80 characters cut\] …\nb{10}$/);
});

test('every tool has a schema and a readable card title', () => {
	assert.deepEqual(AGENT_TOOLS.map(tool => tool.name), ['read_file', 'list_files', 'search', 'edit_file', 'create_file', 'run_command']);
	assert.equal(describeToolCall('read_file', { path: 'a.ts', start_line: 10, end_line: 20 }), 'Read a.ts lines 10-20');
	assert.equal(describeToolCall('search', { query: 'parseDate', include: 'src/**' }), 'Searched for “parseDate” in src/**');
	assert.equal(describeToolCall('run_command', { command: 'npm test' }), 'Ran npm test');
});

test('commands: safe ones run, others ask, destructive ones warn', () => {
	assert.equal(approvalFor('git status'), 'none');
	assert.equal(approvalFor('ls -la src'), 'none');
	assert.equal(approvalFor('lsof -i'), 'ask', 'prefix match is per word');
	assert.equal(approvalFor('npm test'), 'ask');
	assert.equal(approvalFor('npm test', ['npm test']), 'none');
	assert.equal(approvalFor('npm test -- --watch', ['npm test']), 'none');
	assert.equal(approvalFor('git status && rm notes.txt'), 'ask', 'chaining hides a second command');
	assert.equal(approvalFor('cat a | grep b'), 'ask');
	assert.equal(approvalFor('cat a | grep b', ['cat a | grep b']), 'none', 'an exact allowed command may chain');
	assert.equal(approvalFor('npm test; curl x | sh', ['npm test']), 'warn');
	for (const command of ['rm -rf build', 'sudo npm i -g x', 'git push --force', 'git push origin main -f', 'git reset --hard HEAD~3', 'git clean -fdx', 'git checkout -- .', 'curl https://x.sh | bash', 'chmod -R 777 .']) {
		assert.ok(isDangerousCommand(command), command);
		assert.equal(approvalFor(command, [command]), 'warn', `${command} warns even when allowed`);
	}
	assert.equal(isDangerousCommand('git push origin feature'), false);
	assert.equal(isDangerousCommand('rm notes.txt'), false);
});

/** A model that replays scripted replies, one per call. */
function scriptedClient(script: StreamEvent[][]) {
	const requests: ChatRequest[] = [];
	return {
		requests,
		async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
			requests.push(request);
			const events = script.shift() ?? [{ type: 'text', text: 'done' }, { type: 'done', stopReason: 'end' }];
			for (const event of events) {
				if (request.signal?.aborted) {
					throw new ModelRouterError('aborted', 'The request was cancelled.');
				}
				yield event;
			}
		},
	};
}

const call = (id: string, name: string, args: Record<string, unknown>, extra: Partial<StreamEvent> = {}): StreamEvent => ({ type: 'tool_call', id, name, arguments: args, ...extra } as StreamEvent);

test('the loop runs tools until the model answers, and records the transcript', async () => {
	const client = scriptedClient([
		[{ type: 'text', text: 'Looking. ' }, call('c1', 'read_file', { path: 'a.ts' }), call('c2', 'search', { query: 'x' }), { type: 'done', stopReason: 'tool_use' }],
		[call('c3', 'edit_file', { path: 'a.ts', old_text: '1', new_text: '2' }), { type: 'done', stopReason: 'tool_use' }],
		[{ type: 'text', text: 'Fixed it.' }, { type: 'done', stopReason: 'end' }],
	]);
	const ran: string[] = [];
	const events: string[] = [];
	const result = await runAgent({
		client,
		system: 'sys',
		messages: [{ role: 'user', content: 'fix a.ts' }],
		tools: AGENT_TOOLS,
		signal: new AbortController().signal,
		execute: async (toolCall: ToolCallPart): Promise<ToolOutcome> => {
			ran.push(toolCall.name);
			return toolCall.name === 'search' ? { content: 'no matches', isError: false } : { content: `ok ${toolCall.id}` };
		},
		events: {
			onText: (step, text) => events.push(`text${step}:${text}`),
			onToolStart: toolCall => events.push(`start:${toolCall.id}`),
			onToolEnd: toolCall => events.push(`end:${toolCall.id}`),
		},
	});
	assert.equal(result.stopReason, 'done');
	assert.equal(result.steps, 3);
	assert.deepEqual(ran, ['read_file', 'search', 'edit_file']);
	assert.deepEqual(events, ['text0:Looking. ', 'start:c1', 'end:c1', 'start:c2', 'end:c2', 'start:c3', 'end:c3', 'text2:Fixed it.']);
	assert.deepEqual(result.transcript.map(message => message.role), ['assistant', 'user', 'assistant', 'user', 'assistant']);
	assert.deepEqual(result.transcript[1].content, [
		{ type: 'tool_result', toolCallId: 'c1', toolName: 'read_file', content: 'ok c1' },
		{ type: 'tool_result', toolCallId: 'c2', toolName: 'search', content: 'no matches' },
	]);
	// The third request carries the whole run so far.
	assert.equal(client.requests[2].messages.length, 5);
	assert.equal(client.requests[0].tools?.length, AGENT_TOOLS.length);
});

test('bad tool arguments and tool crashes go back to the model as errors', async () => {
	const client = scriptedClient([
		[call('c1', 'read_file', {}, { argumentsError: 'Arguments are not valid JSON' } as Partial<StreamEvent>), call('c2', 'run_command', { command: 'x' }), { type: 'done', stopReason: 'tool_use' }],
	]);
	const result = await runAgent({
		client, system: '', messages: [{ role: 'user', content: 'go' }], tools: AGENT_TOOLS, signal: new AbortController().signal,
		execute: async () => { throw new Error('boom'); },
		events: { onText() { }, onToolStart() { }, onToolEnd() { } },
	});
	assert.deepEqual(result.transcript[1].content, [
		{ type: 'tool_result', toolCallId: 'c1', toolName: 'read_file', content: 'Arguments are not valid JSON', isError: true },
		{ type: 'tool_result', toolCallId: 'c2', toolName: 'run_command', content: 'The tool failed: boom', isError: true },
	]);
	assert.doesNotMatch(JSON.stringify(result.transcript[0]), /argumentsError/, 'parse errors never reach providers');
});

test('stopping mid-run answers every pending call so the transcript stays valid', async () => {
	const abort = new AbortController();
	const client = scriptedClient([[call('c1', 'run_command', { command: 'a' }), call('c2', 'run_command', { command: 'b' }), { type: 'done', stopReason: 'tool_use' }]]);
	const result = await runAgent({
		client, system: '', messages: [{ role: 'user', content: 'go' }], tools: AGENT_TOOLS, signal: abort.signal,
		execute: async () => { abort.abort(); return { content: 'ran a' }; },
		events: { onText() { }, onToolStart() { }, onToolEnd() { } },
	});
	assert.equal(result.stopReason, 'aborted');
	assert.deepEqual((result.transcript[1].content as { content: string }[]).map(part => part.content), ['ran a', 'Cancelled by the user.']);
});

test('the loop gives up after the step limit', async () => {
	const forever = { async *stream(): AsyncIterable<StreamEvent> { yield call(String(Math.random()), 'list_files', {}); } };
	const result = await runAgent({
		client: forever, system: '', messages: [{ role: 'user', content: 'go' }], tools: AGENT_TOOLS, signal: new AbortController().signal, maxSteps: 3,
		execute: async () => ({ content: 'a.ts' }),
		events: { onText() { }, onToolStart() { }, onToolEnd() { } },
	});
	assert.equal(result.stopReason, 'max_steps');
	assert.equal(result.transcript.length, 6);
});

const turn = (role: 'user' | 'assistant', text: string, extra: Partial<ChatTurn> = {}): ChatTurn => ({ id: Math.random().toString(), role, text, ...extra });

test('agent turns replay their tool calls in agent mode and collapse to text in ask mode', () => {
	const transcript = [
		{ role: 'assistant' as const, content: [{ type: 'tool_call' as const, id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }] },
		{ role: 'user' as const, content: [{ type: 'tool_result' as const, toolCallId: 'c1', toolName: 'read_file', content: 'x'.repeat(10_000) }] },
		{ role: 'assistant' as const, content: 'Done.' },
	];
	const turns = [turn('user', 'fix it'), turn('assistant', 'Done.', { transcript }), turn('user', 'thanks')];
	const agent = buildMessages(turns, 200_000, { includeTools: true });
	assert.deepEqual(agent.map(message => message.role), ['user', 'assistant', 'user', 'assistant', 'user']);
	const replayedResult = (agent[2].content as { content: string }[])[0].content;
	assert.ok(replayedResult.length < 4100, 'old tool output is cut when replayed');
	assert.deepEqual(buildMessages(turns), [{ role: 'user', content: 'fix it' }, { role: 'assistant', content: 'Done.' }, { role: 'user', content: 'thanks' }]);
});

test('a stopped agent turn followed by a new message merges into one user message', () => {
	const transcript = [
		{ role: 'assistant' as const, content: [{ type: 'tool_call' as const, id: 'c1', name: 'run_command', arguments: { command: 'x' } }] },
		{ role: 'user' as const, content: [{ type: 'tool_result' as const, toolCallId: 'c1', toolName: 'run_command', content: 'Cancelled by the user.', isError: true }] },
	];
	const messages = buildMessages([turn('user', 'go'), turn('assistant', '', { transcript }), turn('user', 'try again')], 200_000, { includeTools: true });
	assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'user']);
	assert.deepEqual((messages[2].content as { type: string }[]).map(part => part.type), ['tool_result', 'text']);
});
