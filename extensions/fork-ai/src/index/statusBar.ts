/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { addModel } from '../addModel.ts';
import { modelDetail } from '../manageModels.ts';
import type { ModelStore } from '../modelStore.ts';
import type { CodebaseIndexService, IndexStatus } from './service.ts';

const count = (n: number) => n.toLocaleString('en-US');

export function statusText(status: IndexStatus): { text: string; tooltip: string } {
	if (status.state === 'scanning') {
		return {
			text: status.totalFiles ? `$(sync~spin) Indexing ${count(status.files)}/${count(status.totalFiles)}` : '$(sync~spin) Indexing…',
			tooltip: 'Fork is indexing this folder for codebase search. Chat and the agent can already use what is indexed.',
		};
	}
	const lines = [`Codebase index: ${count(status.files)} files, ${count(status.chunks)} chunks${status.truncated ? '. The file or size limit left some files out (Settings: forkAi.index).' : '.'}`];
	let suffix = '';
	if (status.embedModel) {
		const percent = status.chunks ? Math.floor(100 * status.embeddedChunks / status.chunks) : 100;
		if (status.embedError) {
			suffix = ' $(warning)';
			lines.push(`Semantic search with ${status.embedModel} is paused: ${status.embedError}`);
		} else if (percent < 100) {
			suffix = ` · ${percent}%`;
			lines.push(`Embedding with ${status.embedModel}: ${count(status.embeddedChunks)} of ${count(status.chunks)} chunks. Keyword search works meanwhile.`);
		} else {
			lines.push(`Semantic search with ${status.embedModel}.`);
		}
	} else {
		lines.push('Keyword search. Add an embedding model for search by meaning.');
	}
	lines.push('Click for options.');
	return { text: `$(database) ${count(status.files)}${suffix}`, tooltip: lines.join('\n') };
}

export function createIndexStatusBar(service: CodebaseIndexService): vscode.Disposable {
	const item = vscode.window.createStatusBarItem('forkAi.index', vscode.StatusBarAlignment.Right, 100);
	item.name = 'Fork AI Codebase Index';
	item.command = 'forkAi.indexMenu';
	const update = () => {
		const status = service.status();
		if (status.state === 'off' || status.state === 'no-folder') {
			item.hide();
			return;
		}
		const { text, tooltip } = statusText(status);
		item.text = text;
		item.tooltip = tooltip;
		item.show();
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const listener = service.onDidChangeStatus(() => {
		if (!timer) {
			timer = setTimeout(() => {
				timer = undefined;
				update();
			}, 200);
		}
	});
	update();
	return { dispose: () => { clearTimeout(timer); listener.dispose(); item.dispose(); } };
}

/** Fork AI: Choose Embedding Model. Keyword search needs none; an embedding model adds search by meaning. */
export async function chooseEmbeddingModel(store: ModelStore): Promise<void> {
	type Item = vscode.QuickPickItem & { id?: string; action?: 'none' | 'add' };
	const current = store.embedModelId();
	const items: Item[] = [
		{ label: `${current ? '' : '$(check) '}Keywords only`, detail: 'Free and instant. Finds code by its names and words.', action: 'none' },
		...store.list().filter(model => model.embeddingDims).map((model): Item => ({
			label: `${model.id === current ? '$(check) ' : ''}${model.displayName}`,
			description: `${model.embeddingDims} dimensions`,
			detail: modelDetail(model),
			id: model.id,
		})),
		{ label: '', kind: vscode.QuickPickItemKind.Separator },
		{ label: '$(add) Add embedding model…', detail: 'Ollama with nomic-embed-text is free and keeps your code on this computer. Cloud models send your code to that provider.', action: 'add' },
	];
	const picked = await vscode.window.showQuickPick(items, { title: 'Codebase search: embedding model', placeHolder: 'An embedding model adds search by meaning on top of keywords' });
	if (!picked) {
		return;
	}
	if (picked.action === 'add') {
		await addModel(store, 'embedding');
	} else {
		await store.setEmbedModel(picked.id);
	}
}

export async function showIndexMenu(service: CodebaseIndexService, store: ModelStore): Promise<void> {
	const status = service.status();
	type Item = vscode.QuickPickItem & { run: () => unknown };
	const items: Item[] = [
		{ label: '$(refresh) Reindex', detail: 'Scan the folder again. Embeddings already made are reused.', run: () => vscode.commands.executeCommand('forkAi.reindex') },
		{ label: '$(symbol-misc) Choose embedding model…', description: status.embedModel ?? 'keywords only', run: () => chooseEmbeddingModel(store) },
	];
	if (status.embedError) {
		items.unshift({ label: '$(debug-restart) Resume semantic search', detail: status.embedError, run: () => service.retryEmbeddings() });
	}
	items.push(
		{ label: '$(exclude) Edit .forkignore', detail: 'Leave files out of the index, in .gitignore syntax. .gitignore is followed too.', run: () => vscode.commands.executeCommand('forkAi.editForkignore') },
		{ label: '$(circle-slash) Turn off indexing', detail: 'For this workspace. Turn it back on in Settings: Fork AI › Index: Enabled.', run: () => vscode.workspace.getConfiguration('forkAi.index').update('enabled', false, vscode.ConfigurationTarget.Workspace) },
	);
	const picked = await vscode.window.showQuickPick(items, { title: statusText(status).tooltip.split('\n')[0] });
	await picked?.run();
}
