/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatSession } from '../src/history.ts';
import { chatMarkdown, initialsFor } from '../src/share.ts';

function session(turns: ChatSession['turns']): ChatSession {
	return { id: 's', title: 'Fix the date parser', createdAt: 0, updatedAt: 0, turns };
}

test('an empty chat has nothing to share', () => {
	assert.equal(chatMarkdown(session([])), undefined);
	assert.equal(chatMarkdown(session([{ id: 'a', role: 'assistant', text: '' }])), undefined);
});

test('a chat becomes Markdown with the title, both sides and the model', () => {
	const markdown = chatMarkdown(session([
		{ id: 'u', role: 'user', text: 'Why is March off by one?\nSee parseDate.', chips: ['dates.ts'], context: '<file>…whole file…</file>' },
		{ id: 'a', role: 'assistant', text: 'Months start at **0**.', modelName: 'qwen2.5-coder' },
	]));
	assert.equal(markdown, [
		'# Fix the date parser',
		'',
		'---',
		'',
		'**You**',
		'',
		'> Why is March off by one?',
		'> See parseDate.',
		'',
		'*Context: dates.ts*',
		'',
		'---',
		'',
		'**Companion** · qwen2.5-coder',
		'',
		'Months start at **0**.',
		'',
	].join('\n'));
	assert.ok(!markdown!.includes('whole file'), 'context blocks stay out');
});

test('agent turns list their steps and changes', () => {
	const markdown = chatMarkdown(session([
		{ id: 'u', role: 'user', text: 'Add a typecheck script' },
		{
			id: 'a', role: 'assistant', text: '', steps: [
				{ id: '1', kind: 'text', text: 'I will add it.' },
				{ id: '2', kind: 'tool', text: 'Read package.json', status: 'done' },
				{ id: '3', kind: 'tool', text: 'Run npm test', status: 'error' },
				{ id: '4', kind: 'text', text: 'Done.' },
			],
			changes: [{ path: 'package.json', added: 2, removed: 0, created: false }],
		},
	]))!;
	assert.ok(markdown.includes('I will add it.\n\n- ✓ Read package.json\n- ✗ Run npm test\n\nDone.'), markdown);
	assert.ok(markdown.includes('**Changed**\n\n- `package.json` +2 −0'), markdown);
});

test('initials come from the first and last word of a name', () => {
	assert.equal(initialsFor('Sandip Guchait'), 'SG');
	assert.equal(initialsFor('Ada King Lovelace'), 'AL');
	assert.equal(initialsFor('sandip'), 'S');
	assert.equal(initialsFor('sandip.guchait'), 'SG');
	assert.equal(initialsFor('  '), '');
});
