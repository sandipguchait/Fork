/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { addModel } from './addModel.ts';
import { CHAT_VIEW_ID, ChatViewProvider } from './chatView.ts';
import { ChatHistory } from './history.ts';
import { manageModels } from './manageModels.ts';
import { ModelStore } from './modelStore.ts';

export function activate(context: vscode.ExtensionContext): void {
	// Model settings follow the user across workspaces; keys live in the OS keychain via SecretStorage.
	const store = new ModelStore(context.globalState, context.secrets);
	// Chats belong to the project they were about.
	const history = new ChatHistory(context.workspaceState);
	const chat = new ChatViewProvider(context.extensionUri, store, history);

	context.subscriptions.push(
		chat,
		vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, chat, { webviewOptions: { retainContextWhenHidden: true } }),

		vscode.commands.registerCommand('forkAi.openChat', () => chat.reveal()),
		vscode.commands.registerCommand('forkAi.newChat', () => chat.newChat()),
		vscode.commands.registerCommand('forkAi.addModel', () => addModel(store)),
		vscode.commands.registerCommand('forkAi.manageModels', () => store.list().length ? manageModels(store) : addModel(store)),

		vscode.commands.registerCommand('forkAi.addSelectionToChat', async () => {
			const editor = vscode.window.activeTextEditor;
			if (editor && !editor.selection.isEmpty) {
				chat.addSelection(editor);
			}
			await chat.reveal();
		}),

		vscode.commands.registerCommand('forkAi.addFileToChat', async (uri?: vscode.Uri) => {
			const target = uri ?? vscode.window.activeTextEditor?.document.uri;
			if (target) {
				await chat.addFile(target);
			} else {
				await chat.pickFile();
			}
			await chat.reveal();
		}),

		vscode.commands.registerCommand('forkAi.chatHistory', async () => {
			const sessions = history.list();
			if (!sessions.length) {
				void vscode.window.showInformationMessage('No saved chats in this workspace yet.');
				return;
			}
			const picked = await vscode.window.showQuickPick(
				sessions.map(session => ({
					label: session.title,
					description: new Date(session.updatedAt).toLocaleString(),
					detail: `${session.turns.filter(turn => turn.role === 'user').length} messages`,
					session,
				})),
				{ title: 'Chat history', placeHolder: 'Open a previous chat', matchOnDetail: true },
			);
			if (picked) {
				await chat.openSession(picked.session);
			}
		}),
	);
}

export function deactivate(): void {
	// Everything is disposed through context.subscriptions.
}
