/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

// "Where is X" eval for the codebase index, on the Fork (VS Code) source itself.
//
//   node fork/dev/eval-where-is.ts                 keyword search only, whole repo
//   node fork/dev/eval-where-is.ts --limits        as Fork indexes it by default: 15,000 files, 100 MB
//   FORK_EMBED_URL=http://localhost:11434/v1 FORK_EMBED_MODEL=nomic-embed-text \
//   node fork/dev/eval-where-is.ts --embed          hybrid: keyword + semantic (slow: embeds every chunk)
//
// FORK_EMBED_FORMAT (openai or gemini, default openai) and FORK_EMBED_KEY are optional.
// Each question passes when one of its files is among the first five distinct files returned.
// The "tuning" questions were used while adjusting the ranking; the "held-out" ones were written
// before any tuning and never adjusted, so they are the fairer measure.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createModelClient, type ApiFormat } from '../model-router/src/index.ts';
import { IgnoreRules } from '../../extensions/fork-ai/src/index/ignore.ts';
import { chunkFile } from '../../extensions/fork-ai/src/index/chunk.ts';
import { CodebaseIndex, compareForIndexing, normalize } from '../../extensions/fork-ai/src/index/search.ts';
import { documentText, embeddingPrefixes } from '../../extensions/fork-ai/src/index/snippets.ts';

const root = resolve(import.meta.dirname, '../..');
const MAX_BYTES = 512 * 1024;
const embedding = process.argv.includes('--embed');
const limits = process.argv.includes('--limits') ? { files: 15000, bytes: 100 * 1024 * 1024 } : { files: Infinity, bytes: Infinity };

const TUNING: [string, string[]][] = [
	['how does quick open score fuzzy matches against file names', ['src/vs/base/common/fuzzyScorer.ts']],
	['where are keyboard shortcuts resolved to commands when a key is pressed', ['src/vs/platform/keybinding/common/keybindingResolver.ts']],
	['where is the minimap drawn', ['src/vs/editor/browser/viewParts/minimap/minimap.ts']],
	['which algorithm computes the line diff between two versions of a file', ['src/vs/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.ts']],
	['where is the piece tree text buffer that stores the document', ['src/vs/editor/common/model/pieceTreeTextBuffer/pieceTreeBase.ts', 'src/vs/editor/common/model/pieceTreeTextBuffer/pieceTreeTextBuffer.ts']],
	['where are line breaks for word wrap computed', ['src/vs/editor/common/viewModel/monospaceLineBreaksComputer.ts', 'src/vs/editor/browser/view/domLineBreaksComputer.ts']],
	['where are settings from user and workspace configuration merged', ['src/vs/platform/configuration/common/configurationModels.ts', 'src/vs/workbench/services/configuration/common/configurationModels.ts']],
	['bracket pair colorization', ['src/vs/editor/common/model/bracketPairsTextModelPart/colorizedBracketPairsDecorationProvider.ts', 'src/vs/editor/common/model/bracketPairsTextModelPart/bracketPairsImpl.ts']],
	['where does the file watcher use parcel to watch folders', ['src/vs/platform/files/node/watcher/parcel/parcelWatcher.ts']],
	['how are links detected in the terminal output', ['src/vs/workbench/contrib/terminalContrib/links/browser/terminalLinkDetectorAdapter.ts', 'src/vs/workbench/contrib/terminalContrib/links/browser/terminalLinkManager.ts', 'src/vs/workbench/contrib/terminalContrib/links/browser/terminalLocalLinkDetector.ts', 'src/vs/workbench/contrib/terminalContrib/links/browser/terminalUriLinkDetector.ts', 'src/vs/workbench/contrib/terminalContrib/links/browser/terminalWordLinkDetector.ts', 'src/vs/workbench/contrib/terminalContrib/links/browser/terminalMultiLineLinkDetector.ts']],
];
const HELD_OUT: [string, string[]][] = [
	['where is the undo redo stack for text edits', ['src/vs/platform/undoRedo/common/undoRedoService.ts']],
	['how does find in the editor search for matches', ['src/vs/editor/contrib/find/browser/findModel.ts', 'src/vs/editor/contrib/find/browser/findWidget.ts']],
	['where are markdown files rendered to html for the preview', ['extensions/markdown-language-features/src/markdownEngine.ts']],
	['where does code folding compute ranges from indentation', ['src/vs/editor/contrib/folding/browser/indentRangeProvider.ts']],
	['where are color themes loaded', ['src/vs/workbench/services/themes/common/colorThemeData.ts', 'src/vs/workbench/services/themes/browser/workbenchThemeService.ts']],
	['how does add cursor below work for multiple cursors', ['src/vs/editor/contrib/multicursor/browser/multicursor.ts']],
	['where is sticky scroll implemented', ['src/vs/editor/contrib/stickyScroll/browser/stickyScrollController.ts', 'src/vs/editor/contrib/stickyScroll/browser/stickyScrollWidget.ts', 'src/vs/editor/contrib/stickyScroll/browser/stickyScrollProvider.ts']],
	['where is the git commit command', ['extensions/git/src/commands.ts']],
	['where are snippets expanded with tab stops and placeholders', ['src/vs/editor/contrib/snippet/browser/snippetSession.ts', 'src/vs/editor/contrib/snippet/browser/snippetParser.ts']],
	['how is a status bar entry rendered', ['src/vs/workbench/browser/parts/statusbar/statusbarPart.ts', 'src/vs/workbench/browser/parts/statusbar/statusbarItem.ts']],
];

const rules = new IgnoreRules();
try {
	rules.add(readFileSync(join(root, '.gitignore'), 'utf8').split('\n'));
} catch {
	// No .gitignore.
}

const index = new CodebaseIndex();
const t0 = performance.now();
const paths: string[] = [];
function walk(dir: string): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const abs = join(dir, entry.name);
		const rel = relative(root, abs).replace(/\\/g, '/');
		if (entry.isDirectory()) {
			if (!rules.ignores(rel + '/')) {
				walk(abs);
			}
		} else if (entry.isFile() && !rules.ignores(rel)) {
			paths.push(rel);
		}
	}
}
walk(root);
paths.sort(compareForIndexing);
let files = 0;
let bytes = 0;
for (const rel of paths) {
	if (files >= limits.files || bytes >= limits.bytes) {
		break;
	}
	const abs = join(root, rel);
	if (statSync(abs).size > MAX_BYTES) {
		continue;
	}
	const buffer = readFileSync(abs);
	if (buffer.subarray(0, 8000).includes(0)) {
		continue;
	}
	index.setFile(rel, buffer.toString('utf8'));
	files++;
	bytes += buffer.length;
}
console.log(`Indexed ${files} files (${(bytes / 1e6).toFixed(0)} MB), ${index.chunkCount} chunks in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

const client = embedding ? createModelClient({
	id: 'eval-embed',
	displayName: 'eval',
	apiFormat: (process.env.FORK_EMBED_FORMAT ?? 'openai') as ApiFormat,
	baseUrl: process.env.FORK_EMBED_URL ?? 'http://localhost:11434/v1',
	apiKey: process.env.FORK_EMBED_KEY,
	model: process.env.FORK_EMBED_MODEL ?? 'nomic-embed-text',
}) : undefined;

if (client) {
	// Embedded as the index service does it: path and text, with the model's task prefix, in batches.
	const t1 = performance.now();
	const model = process.env.FORK_EMBED_MODEL ?? 'nomic-embed-text';
	let batch: { path: string; position: number; text: string }[] = [];
	let done = 0;
	const flush = async () => {
		const vectors = await client.embed(batch.map(item => item.text));
		batch.forEach((item, i) => index.setVector(item.path, item.position, normalize(vectors[i])));
		done += batch.length;
		batch = [];
		process.stdout.write(`\rEmbedded ${done}/${index.chunkCount} chunks`);
	};
	for (const path of index.paths()) {
		const chunks = chunkFile(path, readFileSync(join(root, path), 'utf8'));
		for (let position = 0; position < chunks.length; position++) {
			batch.push({ path, position, text: documentText(model, path, chunks[position].text) });
			if (batch.length === 64) {
				await flush();
			}
		}
	}
	if (batch.length) {
		await flush();
	}
	console.log(`\rEmbedded ${done} chunks in ${((performance.now() - t1) / 1000).toFixed(0)} s`);
}

for (const [name, questions] of [['tuning', TUNING], ['held-out', HELD_OUT]] as const) {
	console.log(`\n${name}`);
	let hits = 0;
	for (const [question, expected] of questions) {
		const queryVector = client ? (await client.embed([embeddingPrefixes(process.env.FORK_EMBED_MODEL ?? 'nomic-embed-text').query + question]))[0] : undefined;
		const top = [...new Set(index.search(question, { limit: 10, queryVector }).map(hit => hit.chunk.path))].slice(0, 5);
		const rank = top.findIndex(path => expected.includes(path));
		hits += rank === -1 ? 0 : 1;
		console.log(`  ${rank === -1 ? 'miss ' : `hit ${rank + 1}`}  ${question}`);
		if (rank === -1 || process.env.VERBOSE) {
			top.forEach(path => console.log(`          ${path}`));
		}
	}
	console.log(`  hit@5: ${hits}/${questions.length}`);
}
console.log(`\nHeap: ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)} MB`);
