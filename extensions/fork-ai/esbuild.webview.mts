/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
// Bundles the chat webview into dist/chat.js.
import * as path from 'node:path';
import { run } from '../esbuild-webview-common.mts';

const srcDir = path.join(import.meta.dirname, 'webview-src');
const outDir = path.join(import.meta.dirname, 'dist');

run({
	entryPoints: {
		'chat': path.join(srcDir, 'main.ts'),
	},
	srcDir,
	outdir: outDir,
	additionalWatchPaths: [path.join(import.meta.dirname, 'src', 'protocol.ts')],
}, process.argv);
