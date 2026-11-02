/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMarkdown, renderInline } from '../webview-src/markdown.ts';

const html = (source: string) => parseMarkdown(source).map(block => block.type === 'html' ? block.html : `[code:${block.language}]`).join('');

test('escapes raw HTML from the model', () => {
	assert.equal(html('<img src=x onerror=alert(1)> **hi**'), '<p>&lt;img src=x onerror=alert(1)&gt; <strong>hi</strong></p>');
	assert.equal(renderInline('`<script>`'), '<code>&lt;script&gt;</code>');
});

test('only renders http(s) links', () => {
	assert.equal(renderInline('[docs](https://example.com/a?b=1&c=2)'), '<a href="https://example.com/a?b=1&amp;c=2" title="https://example.com/a?b=1&amp;c=2">docs</a>');
	assert.equal(renderInline('[x](javascript:alert(1))'), '[x](javascript:alert(1))');
	assert.equal(renderInline('[x](https://e.com" onclick="y)'), '[x](https://e.com&quot; onclick=&quot;y)');
});

test('keeps formatting out of inline code and snake_case names', () => {
	assert.equal(renderInline('use `**not bold**` and my_var_name'), 'use <code>**not bold**</code> and my_var_name');
	assert.equal(renderInline('*em* and _em_ and ~~old~~'), '<em>em</em> and <em>em</em> and <del>old</del>');
});

test('splits code fences out, including an unfinished one while streaming', () => {
	const blocks = parseMarkdown('Here:\n```ts\nconst a = 1;\n```\nDone.\n```py\nprint(');
	assert.deepEqual(blocks, [
		{ type: 'html', html: '<p>Here:</p>' },
		{ type: 'code', language: 'ts', code: 'const a = 1;', complete: true },
		{ type: 'html', html: '<p>Done.</p>' },
		{ type: 'code', language: 'py', code: 'print(', complete: false },
	]);
});

test('renders headings, lists, quotes, rules and tables', () => {
	assert.equal(html('# Title\n- a\n- b\n\n3. c\n4. d\n> note\n\n---'), '<h3>Title</h3><ul><li>a</li><li>b</li></ul><ol start="3"><li>c</li><li>d</li></ol><blockquote>note</blockquote><hr>');
	assert.equal(html('| A | B |\n|---|:--:|\n| 1 | **2** |'), '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td><strong>2</strong></td></tr></tbody></table>');
});

test('joins paragraph lines with line breaks and never loops on odd input', () => {
	assert.equal(html('one\ntwo\n\nthree'), '<p>one<br>two</p><p>three</p>');
	for (const odd of ['***', '|', '1)', '- ', '>', '```', '#', '|a|\n|--|']) {
		assert.doesNotThrow(() => parseMarkdown(odd), odd);
	}
});
