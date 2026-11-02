/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { combine, diffLines, resolve } from '../src/diff.ts';
import { baseIndent, buildEditMessages, CONTEXT_LINES, extractCode, reindent } from '../src/editPrompt.ts';

const lines = (text: string) => text === '' ? [] : text.split('\n');

test('diff keeps unchanged lines and finds the edits', () => {
	const ops = diffLines(lines('a\nb\nc\nd'), lines('a\nB\nc\nd\ne'));
	assert.deepEqual(ops.map(op => `${op.type[0]}${op.line}`), ['ea', 'rb', 'aB', 'ec', 'ed', 'ae']);
	assert.deepEqual(diffLines([], []), []);
	assert.deepEqual(diffLines(['x'], []).map(op => op.type), ['removed']);
	assert.deepEqual(diffLines([], ['x']).map(op => op.type), ['added']);
});

test('combine shows each change as old lines then new lines', () => {
	const layout = combine(lines('a\nb\nc\nd'), lines('a\nB1\nB2\nc\ne'));
	assert.deepEqual(layout.lines, ['a', 'b', 'B1', 'B2', 'c', 'd', 'e']);
	assert.deepEqual(layout.hunks, [{ offset: 1, removed: 1, added: 2 }, { offset: 5, removed: 1, added: 1 }]);
});

test('accepting everything gives the new code, rejecting everything the old', () => {
	const cases: [string, string][] = [
		['a\nb\nc', 'a\nx\nc'],
		['', 'new\nlines'],
		['old\nlines', ''],
		['function f() {\n\treturn 1;\n}', 'function f(): number {\n\t// one\n\treturn 1;\n}\n\nf();'],
		['a\na\na\nb', 'b\na\na\na'],
	];
	for (const [before, after] of cases) {
		const layout = combine(lines(before), lines(after));
		assert.deepEqual(resolve(layout, () => 'accept'), lines(after), `accept ${JSON.stringify(after)}`);
		assert.deepEqual(resolve(layout, () => 'reject'), lines(before), `reject ${JSON.stringify(before)}`);
	}
});

test('accepting some changes keeps the others as they were', () => {
	const layout = combine(lines('one\ntwo\nthree\nfour'), lines('ONE\ntwo\nthree\nFOUR'));
	assert.equal(layout.hunks.length, 2);
	assert.deepEqual(resolve(layout, (_hunk, index) => index === 0 ? 'accept' : 'reject'), ['ONE', 'two', 'three', 'four']);
});

test('diff handles a large file quickly', () => {
	const before = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
	const after = before.map((line, i) => i % 100 === 0 ? `${line} changed` : line);
	const started = Date.now();
	const layout = combine(before, after);
	assert.equal(layout.hunks.length, 30);
	assert.ok(Date.now() - started < 2000);
});

test('the edit prompt marks the selection and trims long context', () => {
	const before = Array.from({ length: CONTEXT_LINES + 50 }, (_, i) => `b${i}`);
	const [message] = buildEditMessages({ path: 'src/a.ts', language: 'typescript', before, selected: ['x = 1'], after: ['y'], instruction: 'rename x' });
	const content = String(message.content);
	assert.match(content, /^<file path="src\/a.ts" language="typescript">\n…\nb50\n/);
	assert.match(content, /b249\n<selection>\nx = 1\n<\/selection>\ny\n<\/file>\n\nInstruction: rename x$/);
	assert.doesNotMatch(content, /\nb49\n/);
});

test('extracts code from fenced, unfinished and bare replies', () => {
	assert.equal(extractCode('Here you go:\n```ts\nconst a = 1;\nconst b = 2;\n```\nDone'), 'const a = 1;\nconst b = 2;');
	assert.equal(extractCode('```python\nprint(1)\nprint('), 'print(1)\nprint(');
	assert.equal(extractCode('\nconst a = 1;\n\n'), 'const a = 1;');
	assert.equal(extractCode('```\n<selection>\nx\n</selection>\n```'), 'x');
	assert.equal(extractCode('```js\n  indented\n```'), '  indented');
	assert.equal(extractCode('```\n```'), '');
});

test('puts back indentation the model dropped, and leaves good output alone', () => {
	assert.equal(baseIndent(['\t\tif (a) {', '', '\t\t\tb();', '\t\t}']), '\t\t');
	assert.deepEqual(reindent(['\t\tif (a) {', '\t\t}'], ['if (a) {', '\tb();', '', '}']), ['\t\tif (a) {', '\t\t\tb();', '', '\t\t}']);
	assert.deepEqual(reindent(['\tx'], ['\ty']), ['\ty']);
	assert.deepEqual(reindent(['x'], ['  y']), ['  y']);
	assert.deepEqual(reindent(['    x'], ['\ty']), ['\ty'], 'mixed tabs and spaces are left as they are');
});
