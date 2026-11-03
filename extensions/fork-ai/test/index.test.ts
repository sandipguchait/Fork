/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkFile, MAX_LINES } from '../src/index/chunk.ts';
import { IgnoreRules } from '../src/index/ignore.ts';
import { CodebaseIndex, fuse, isSecondaryPath } from '../src/index/search.ts';
import { documentText, embeddingPrefixes, formatForAgent, MAX_SNIPPET_LINES, renderCodebaseBlock, sliceLines, takeCodebaseMention, type Snippet } from '../src/index/snippets.ts';
import { pathTerms, queryTerms, splitIdentifier, stem, tokenize } from '../src/index/tokenize.ts';
import { contentHash, decodeVectorCache, encodeVectorCache } from '../src/index/vectorCache.ts';

test('identifiers split on case, digits and separators', () => {
	assert.deepEqual(splitIdentifier('parseDateTime_v2'), ['parse', 'date', 'time', 'v2']);
	assert.deepEqual(splitIdentifier('HTTPServerError'), ['http', 'server', 'error']);
	assert.deepEqual(splitIdentifier('MAX_CHUNK_CHARS'), ['max', 'chunk', 'chars']);
	assert.deepEqual(splitIdentifier('x'), ['x']);
});

test('tokenize drops stopwords, stems words and keeps whole identifiers', () => {
	assert.deepEqual(tokenize('Where is the date parsing?'), ['date', 'pars']);
	assert.deepEqual(tokenize('export function parseDate(input: string)'), ['pars', 'date', 'parsdate', 'input']);
	for (const word of ['parse', 'parser', 'parsing', 'parsed', 'parses']) {
		assert.equal(stem(word), 'pars', word);
	}
	assert.equal(stem('matches'), 'match');
	assert.equal(stem('entries'), 'entry');
	assert.equal(stem('class'), 'class');
	assert.equal(stem('status'), 'status');
	assert.equal(stem('user'), 'user', 'short words stay whole');
	assert.deepEqual(pathTerms('src/vs/base/common/fuzzyScorer.ts'), ['src', 'vs', 'base', 'common', 'fuzzy', 'scor', 'fuzzyscor']);
	assert.deepEqual(queryTerms('status bar entry'), ['status', 'bar', 'entry', 'statusbar', 'barentry']);
});

test('chunks follow top-level declarations and pack small ones together', () => {
	const small = 'import x from "y";\n\nexport function a() {\n\treturn 1;\n}\n\nexport function b() {\n\treturn 2;\n}\n';
	const chunks = chunkFile('a.ts', small);
	assert.equal(chunks.length, 1, 'small file is one chunk');
	assert.deepEqual([chunks[0].startLine, chunks[0].endLine], [1, 9]);

	const fn = (name: string, lines: number) => [`export function ${name}() {`, ...Array.from({ length: lines }, (_, i) => `\tconst v${i} = ${i};`), '}'].join('\n');
	const big = [fn('first', 40), fn('second', 40), fn('third', 40)].join('\n');
	const parts = chunkFile('b.ts', big);
	assert.equal(parts.length, 3, 'each 42-line function is its own chunk');
	assert.match(parts[1].text, /^export function second/);
	assert.deepEqual([parts[1].startLine, parts[1].endLine], [43, 84]);

	const huge = fn('huge', 300);
	const windows = chunkFile('c.ts', huge);
	assert.ok(windows.length >= 3, 'a long function is cut into windows');
	assert.ok(windows.every(w => w.endLine - w.startLine + 1 <= MAX_LINES));
	assert.ok(windows[1].startLine <= windows[0].endLine, 'windows overlap');
	assert.equal(windows.at(-1)!.endLine, 302);

	assert.deepEqual(chunkFile('empty.ts', ''), []);
	assert.equal(chunkFile('long-line.min.js', 'x'.repeat(10000)).length, 1, 'one long line still makes one chunk');
});

test('ignore rules follow .gitignore semantics', () => {
	const rules = new IgnoreRules();
	assert.ok(rules.ignores('node_modules/'));
	assert.ok(rules.ignores('packages/a/node_modules/lib/index.js'));
	assert.ok(rules.ignores('assets/logo.png'));
	assert.ok(!rules.ignores('src/index.ts'));

	rules.add(['# comment', '', '*.log', '!keep.log', '/secret.txt', 'tmp/', 'docs/**/*.draft.md', 'gen?.ts']);
	assert.ok(rules.ignores('server.log'));
	assert.ok(rules.ignores('logs/server.log'));
	assert.ok(!rules.ignores('keep.log'), 'negation re-includes');
	assert.ok(rules.ignores('secret.txt'));
	assert.ok(!rules.ignores('nested/secret.txt'), 'a leading slash anchors to the root');
	assert.ok(rules.ignores('tmp/'));
	assert.ok(rules.ignores('tmp/a.ts'));
	assert.ok(!rules.ignores('tmp'), 'a directory-only rule does not match a file');
	assert.ok(rules.ignores('docs/a/b/x.draft.md'));
	assert.ok(rules.ignores('docs/x.draft.md'));
	assert.ok(rules.ignores('gen1.ts'));
	assert.ok(!rules.ignores('gen12.ts'));

	rules.add(['*.ts', '!keep.ts'], 'packages/legacy');
	assert.ok(rules.ignores('packages/legacy/src/a.ts'), 'nested ignore files apply below their folder');
	assert.ok(!rules.ignores('packages/legacy/keep.ts'));
	assert.ok(!rules.ignores('packages/current/a.ts'));
});

test('BM25 ranks the defining file first and path words count', () => {
	const index = new CodebaseIndex();
	index.setFile('src/dates.ts', 'export function parseDate(input: string): Date {\n\treturn new Date(input);\n}\n');
	index.setFile('src/math.ts', 'export function add(a: number, b: number) {\n\treturn a + b;\n}\n');
	index.setFile('src/app.ts', 'import { parseDate } from "./dates";\nconsole.log(add(1, 2));\n');
	index.setFile('src/scroll/smoothScrolling.ts', 'export class Animator {\n\tstep() {}\n}\n');

	const hits = index.search('where do we parse dates');
	assert.equal(hits[0].chunk.path, 'src/dates.ts');
	assert.deepEqual(hits[0].via, ['keyword']);
	assert.equal(index.search('smooth scroll')[0].chunk.path, 'src/scroll/smoothScrolling.ts', 'found by its path alone');
	assert.deepEqual(index.search('the'), [], 'stopwords only');
	assert.deepEqual(index.search('parse', { pathPrefixes: ['src/app'] }).map(h => h.chunk.path), ['src/app.ts']);
});

test('files can be replaced and removed', () => {
	const index = new CodebaseIndex();
	index.setFile('a.ts', 'const alpha = 1;');
	index.setFile('b.ts', 'const beta = 2;');
	assert.equal(index.search('alpha')[0].chunk.path, 'a.ts');
	index.setFile('a.ts', 'const gamma = 3;');
	assert.deepEqual(index.search('alpha'), []);
	assert.equal(index.search('gamma')[0].chunk.path, 'a.ts');
	index.removeFile('a.ts');
	assert.deepEqual(index.search('gamma'), []);
	assert.equal(index.fileCount, 1);
	assert.equal(index.chunkCount, 1);
	assert.deepEqual(index.paths(), ['b.ts']);
});

test('one file cannot take more than two places', () => {
	const index = new CodebaseIndex();
	const fn = (i: number) => [`export function widget${i}() {`, ...Array.from({ length: 50 }, () => '\twidget();'), '}'].join('\n');
	index.setFile('big.ts', [1, 2, 3, 4].map(fn).join('\n'));
	index.setFile('small.ts', 'export const widget = 1;');
	const paths = index.search('widget').map(h => h.chunk.path);
	assert.deepEqual(paths.filter(p => p === 'big.ts').length, 2);
	assert.ok(paths.includes('small.ts'));
});

test('hybrid search fuses keyword and semantic rankings', () => {
	assert.deepEqual([...fuse([[1, 2], [2, 3]]).entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id), [2, 1, 3]);

	const index = new CodebaseIndex();
	index.setFile('auth.ts', 'export function login(user) { checkPassword(user); }');
	index.setFile('cache.ts', 'export function remember(key) { store.set(key); }');
	index.setFile('notes.md', '# Login notes\nThe login page.');
	assert.deepEqual(index.missingVectors('auth.ts'), [0]);
	index.setVectors('auth.ts', [[1, 0, 0]]);
	index.setVectors('cache.ts', [[0, 1, 0]]);
	index.setVectors('notes.md', [[0, 0, 1]]);
	assert.equal(index.embeddedCount, 3);
	assert.deepEqual(index.missingVectors('auth.ts'), []);

	// "sign in" shares no words with the code; the vector finds it.
	const semanticOnly = index.search('sign in', { queryVector: [0.9, 0.1, 0] });
	assert.equal(semanticOnly[0].chunk.path, 'auth.ts');
	assert.deepEqual(semanticOnly[0].via, ['semantic']);

	// Found by both beats found by one.
	const both = index.search('login', { queryVector: [1, 0.2, 0] });
	assert.equal(both[0].chunk.path, 'auth.ts');
	assert.deepEqual(both[0].via, ['keyword', 'semantic']);

	index.clearVectors();
	assert.equal(index.embeddedCount, 0);
	assert.deepEqual(index.missingVectors('auth.ts'), [0]);
});

test('tests and fixtures rank below the code they test', () => {
	assert.ok(isSecondaryPath('src/vs/base/test/common/filters.test.ts'));
	assert.ok(isSecondaryPath('src/app.spec.tsx'));
	assert.ok(isSecondaryPath('syntaxes/markdown.tmLanguage.json'));
	assert.ok(!isSecondaryPath('src/vs/base/common/filters.ts'));
	assert.ok(!isSecondaryPath('src/latest/feature.ts'), '"test" inside a word does not count');

	const index = new CodebaseIndex();
	index.setFile('src/cart.test.ts', 'test("checkout total", () => { expect(checkoutTotal(cart)).toBe(3); });');
	index.setFile('src/cart.ts', 'export function checkoutTotal(cart) { return cart.items.length; }');
	assert.equal(index.search('checkout total')[0].chunk.path, 'src/cart.ts');
});

test('search results carry positions, not text', () => {
	const index = new CodebaseIndex();
	const chunks = index.setFile('a.ts', 'export const alpha = 1;\n');
	assert.equal(chunks[0].text, 'export const alpha = 1;', 'setFile returns text for embedding');
	assert.deepEqual(index.search('alpha')[0].chunk, { path: 'a.ts', startLine: 1, endLine: 1 });
});

const snippet = (path: string, startLine: number, lines: string[]): Snippet => ({ path, startLine, endLine: startLine + lines.length - 1, text: lines.join('\n'), via: ['keyword'] });

test('agent results number lines, cut long snippets and respect the budget', () => {
	const result = formatForAgent('parse date', [snippet('src/dates.ts', 3, ['export function parseDate() {', '}'])], '6 files indexed.');
	assert.equal(result, '1 snippet for "parse date", best first. 6 files indexed.\n\n## src/dates.ts:3-4\n3\texport function parseDate() {\n4\t}');
	assert.match(formatForAgent('x', [], 'Index ready.'), /^No indexed code matches "x". Index ready. Try other words/);

	const long = snippet('big.ts', 1, Array.from({ length: 200 }, (_, i) => `line ${i + 1}`));
	const cut = formatForAgent('big', [long], '');
	assert.match(cut, new RegExp(`## big.ts:1-${MAX_SNIPPET_LINES}\n`));
	assert.match(cut, /… 120 more lines. Use read_file to see them.$/);

	const many = Array.from({ length: 10 }, (_, i) => snippet(`f${i}.ts`, 1, ['x'.repeat(500)]));
	const budgeted = formatForAgent('x', many, '', 1600);
	assert.match(budgeted, /^3 snippets for "x", best first. 7 more not shown.\n/);
});

test('chat context block and @codebase', () => {
	const block = renderCodebaseBlock('where "dates" are', [snippet('src/dates.ts', 1, ['a', 'b'])])!;
	assert.equal(block.count, 1);
	assert.equal(block.text, '<codebase query="where &quot;dates&quot; are" note="the parts of the project that best match the question, found by search; other relevant code may exist">\n<snippet path="src/dates.ts" lines="1-2">\na\nb\n</snippet>\n</codebase>');
	assert.equal(renderCodebaseBlock('q', []), undefined);

	assert.deepEqual(takeCodebaseMention('@codebase where is login?'), { mentioned: true, query: 'where is login?' });
	assert.deepEqual(takeCodebaseMention('how does auth work @Codebase'), { mentioned: true, query: 'how does auth work' });
	assert.deepEqual(takeCodebaseMention('mail me@codebase.com'), { mentioned: false, query: 'mail me@codebase.com' });
	assert.equal(sliceLines('a\nb\nc\nd', 2, 3), 'b\nc');
});

test('embedding prefixes follow the model', () => {
	assert.deepEqual(embeddingPrefixes('nomic-embed-text'), { document: 'search_document: ', query: 'search_query: ' });
	assert.deepEqual(embeddingPrefixes('intfloat/multilingual-e5-large'), { document: 'passage: ', query: 'query: ' });
	assert.deepEqual(embeddingPrefixes('text-embedding-3-small'), { document: '', query: '' });
	assert.equal(documentText('nomic-embed-text:latest', 'src/a.ts', 'code'), 'search_document: src/a.ts\ncode');
});

test('the vector cache round-trips and rejects foreign or cut files', () => {
	const a = contentHash('a');
	const b = contentHash('b');
	assert.match(a, /^[0-9a-f]{40}$/);
	const vectors = new Map([[a, Float32Array.from([0.5, -0.25, 1])], [b, Float32Array.from([0, 1, 0])], ['not-a-hash', Float32Array.from([1, 1, 1])]]);
	const bytes = encodeVectorCache('nomic-embed-text', vectors);
	const decoded = decodeVectorCache(bytes)!;
	assert.equal(decoded.model, 'nomic-embed-text');
	assert.equal(decoded.dims, 3);
	assert.deepEqual([...decoded.vectors.keys()], [a, b]);
	assert.deepEqual([...decoded.vectors.get(a)!], [0.5, -0.25, 1]);
	assert.equal(decodeVectorCache(bytes.slice(0, bytes.length - 4)), undefined, 'cut short');
	assert.equal(decodeVectorCache(new TextEncoder().encode('hello world')), undefined, 'not a cache');
	assert.equal(decodeVectorCache(encodeVectorCache('m', new Map()))!.vectors.size, 0);
});
