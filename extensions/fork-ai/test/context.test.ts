/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMessages, MAX_FILE_CHARS, renderContext, truncate, type Attachment, type EditorContext } from '../src/context.ts';
import type { ChatTurn } from '../src/history.ts';

const editor: EditorContext = { path: 'src/app.ts', language: 'typescript', text: 'const a = 1;', selection: { startLine: 1, endLine: 1, text: 'a = 1' } };
const selection: Attachment = { id: 's', kind: 'selection', path: 'src/util.ts', language: 'typescript', text: 'export {}', startLine: 4, endLine: 9 };

test('renders the open file, its selection and attachments with chips', () => {
	const context = renderContext(editor, [selection]);
	assert.deepEqual(context?.chips, ['app.ts:1', 'util.ts:4-9']);
	assert.match(context!.text, /^<context>\n<file path="src\/app.ts" language="typescript" note="the file open in the editor">\nconst a = 1;\n<\/file>/);
	assert.match(context!.text, /<selection path="src\/app.ts" lines="1-1" note="selected in the editor">\na = 1\n<\/selection>/);
	assert.match(context!.text, /<selection path="src\/util.ts" lines="4-9">\nexport \{\}\n<\/selection>\n<\/context>$/);
});

test('does not send the open file twice when it is also attached', () => {
	const attached: Attachment = { id: 'f', kind: 'file', path: 'src/app.ts', language: 'typescript', text: 'const a = 1;' };
	const context = renderContext(editor, [attached]);
	assert.deepEqual(context?.chips, ['app.ts']);
	assert.equal(context!.text.match(/<file /g)?.length, 1);
});

test('returns nothing when there is no context, and truncates huge files', () => {
	assert.equal(renderContext(undefined, []), undefined);
	const big = 'x'.repeat(MAX_FILE_CHARS + 10);
	assert.match(truncate(big, MAX_FILE_CHARS), /\[10 more characters not shown\]$/);
	assert.match(renderContext(undefined, [{ id: 'b', kind: 'file', path: 'big.txt', language: 'plaintext', text: big }])!.text, /10 more characters/);
});

test('escapes quotes in paths', () => {
	assert.match(renderContext({ ...editor, path: 'we"ird.ts', selection: undefined }, [])!.text, /path="we&quot;ird.ts"/);
});

const turn = (role: 'user' | 'assistant', text: string, extra: Partial<ChatTurn> = {}): ChatTurn => ({ id: Math.random().toString(), role, text, ...extra });

test('puts each user turn\'s context in front of its text', () => {
	assert.deepEqual(buildMessages([turn('user', 'why?', { context: '<context>x</context>' }), turn('assistant', 'because'), turn('user', 'ok')]), [
		{ role: 'user', content: '<context>x</context>\n\nwhy?' },
		{ role: 'assistant', content: 'because' },
		{ role: 'user', content: 'ok' },
	]);
});

test('skips failed replies and merges the user turns around them', () => {
	assert.deepEqual(buildMessages([turn('user', 'one'), turn('assistant', '', { error: 'HTTP 500' }), turn('user', 'two')]), [
		{ role: 'user', content: 'one\n\ntwo' },
	]);
});

test('drops the oldest turns over budget but always keeps the newest message', () => {
	const turns = [turn('user', 'a'.repeat(50)), turn('assistant', 'b'.repeat(50)), turn('user', 'c'.repeat(50)), turn('assistant', 'd'.repeat(50)), turn('user', 'e'.repeat(50))];
	const first = (budget: number) => buildMessages(turns, budget).map(message => String(message.content)[0]);
	assert.deepEqual(first(150), ['c', 'd', 'e']);
	// 120 fits "d" and "e", but a conversation must open with a user message, so "d" goes too.
	assert.deepEqual(first(120), ['e']);
	assert.deepEqual(buildMessages([turn('user', 'z'.repeat(500))], 10).length, 1);
});
