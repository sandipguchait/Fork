/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';
import * as vscode from 'vscode';
import type { ChatViewProvider } from './chatView.ts';
import { modelDetail } from './manageModels.ts';
import type { ModelStore } from './modelStore.ts';
import type { ChatMode } from './protocol.ts';
import { initialsFor } from './share.ts';

// What Meridian's workbench shows about the Companion: the title bar's model pill, Share and
// avatar (context keys plus the commands they run), the omnibar's Ask tab and the status bar's
// Ready. The workbench side is in src/vs/workbench/contrib/meridian.

/** Arguments of forkAi.askCompanion, the omnibar's Ask tab. */
export interface AskCompanionArgs {
	readonly text?: string;
	readonly withActiveFile?: boolean;
	readonly withCodebase?: boolean;
	readonly mode?: ChatMode;
}

function gitUserName(): Promise<string | undefined> {
	return new Promise(resolve => {
		try {
			execFile('git', ['config', '--get', 'user.name'], { timeout: 3000 }, (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined));
		} catch {
			resolve(undefined);
		}
	});
}

function osUserName(): string | undefined {
	try {
		return userInfo().username || undefined;
	} catch {
		return undefined;
	}
}

/** The user's name for the avatar and the welcome greeting: git's user.name, else the OS account. */
export async function userName(): Promise<string | undefined> {
	return (await gitUserName()) ?? osUserName();
}

async function pickChatModel(store: ModelStore): Promise<void> {
	type Item = vscode.QuickPickItem & { id?: string; action?: 'add' | 'manage' };
	const selected = store.chatModelId();
	const items: Item[] = store.chatModels().map(model => ({
		label: model.displayName,
		description: model.id === selected ? 'In use' : undefined,
		detail: modelDetail(model),
		id: model.id,
	}));
	if (items.length) {
		items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
	}
	items.push({ label: '$(add) Add a model…', action: 'add', alwaysShow: true });
	if (store.list().length) {
		items.push({ label: '$(settings-gear) Manage models…', action: 'manage', alwaysShow: true });
	}
	const picked = await vscode.window.showQuickPick(items, { title: 'Companion model', placeHolder: items.length > 2 ? 'Pick the model the Companion chats with' : 'Add a model for the Companion', matchOnDetail: true });
	if (picked?.id) {
		await store.setChatModel(picked.id);
	} else if (picked?.action === 'add') {
		await vscode.commands.executeCommand('forkAi.addModel');
	} else if (picked?.action === 'manage') {
		await vscode.commands.executeCommand('forkAi.manageModels');
	}
}

export function registerMeridian(store: ModelStore, chat: ChatViewProvider): vscode.Disposable {
	const disposables: vscode.Disposable[] = [];

	const updateModel = () => {
		const id = store.chatModelId();
		const model = id ? store.get(id) : undefined;
		void vscode.commands.executeCommand('setContext', 'forkAi.chatModelName', model?.displayName ?? '');
		updateStatus();
	};

	// "● Ready" on the left of the status bar: whether the Companion can take a message.
	const status = vscode.window.createStatusBarItem('forkAi.ready', vscode.StatusBarAlignment.Left, 1000);
	status.name = 'Companion';
	const updateStatus = () => {
		const id = store.chatModelId();
		if (!id || !store.get(id)) {
			status.text = '$(circle-large-outline) Add a model';
			status.tooltip = 'The Companion needs a model. Click to add one.';
			status.command = 'forkAi.addModel';
		} else if (chat.busy) {
			status.text = '$(loading~spin) Working';
			status.tooltip = 'The Companion is replying. Click to open it.';
			status.command = 'forkAi.openChat';
		} else {
			status.text = '$(circle-filled) Ready';
			status.tooltip = `The Companion is ready (${store.get(id)!.displayName}). Click to open it.`;
			status.command = 'forkAi.openChat';
		}
	};
	status.show();
	disposables.push(status, chat.onDidChangeBusy(updateStatus), store.onDidChange(updateModel));
	updateModel();

	void userName().then(name => {
		if (name) {
			void vscode.commands.executeCommand('setContext', 'meridian.userName', name);
			void vscode.commands.executeCommand('setContext', 'meridian.userInitials', initialsFor(name));
		}
	});

	disposables.push(
		vscode.commands.registerCommand('forkAi.pickChatModel', () => pickChatModel(store)),
		vscode.commands.registerCommand('forkAi.shareChat', async () => {
			const markdown = chat.markdown();
			if (!markdown) {
				void vscode.window.showInformationMessage('Nothing to share yet. Ask the Companion something first.');
				return;
			}
			await vscode.env.clipboard.writeText(markdown);
			void vscode.window.showInformationMessage('Copied this chat as Markdown.');
		}),
		vscode.commands.registerCommand('forkAi.askCompanion', (args?: AskCompanionArgs) => chat.ask(args ?? {})),
	);

	// Last: the title bar shows the model pill and Share once these commands exist.
	void vscode.commands.executeCommand('setContext', 'forkAi.ready', true);
	disposables.push({ dispose: () => void vscode.commands.executeCommand('setContext', 'forkAi.ready', false) });
	return vscode.Disposable.from(...disposables);
}
