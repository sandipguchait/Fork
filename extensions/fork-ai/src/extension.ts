/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { addModel } from './addModel.ts';
import { CHAT_VIEW_ID, ChatViewProvider } from './chatView.ts';
import { ChatHistory } from './history.ts';
import { InlineEditController } from './inlineEdit.ts';
import { CodebaseIndexService } from './index/service.ts';
import { chooseEmbeddingModel, createIndexStatusBar, showIndexMenu } from './index/statusBar.ts';
import { manageModels } from './manageModels.ts';
import { McpManager, PROJECT_CONFIG, USER_CONFIG } from './mcp/manager.ts';
import { registerMeridian } from './meridian.ts';
import { openMcpConfig, showMcpServers } from './mcp/panel.ts';
import { ModelStore } from './modelStore.ts';

export function activate(context: vscode.ExtensionContext): void {
	// Model settings follow the user across workspaces; keys live in the OS keychain via SecretStorage.
	const store = new ModelStore(context.globalState, context.secrets);
	// Chats belong to the project they were about.
	const history = new ChatHistory(context.workspaceState);
	// The codebase index: kept in memory, embeddings cached in this workspace's storage.
	const codebase = new CodebaseIndexService(context.storageUri, store);
	// MCP servers from ~/.fork/mcp.json and .fork/mcp.json; their tools join Agent mode.
	const mcpOutput = vscode.window.createOutputChannel('Companion: MCP');
	const mcp = new McpManager(context.workspaceState, mcpOutput);
	const chat = new ChatViewProvider(context.extensionUri, store, history, context.workspaceState, codebase, mcp);
	const inlineEdit = new InlineEditController(store);

	context.subscriptions.push(
		mcpOutput,
		mcp,
		vscode.commands.registerCommand('forkAi.mcpServers', () => showMcpServers(mcp, mcpOutput)),
		vscode.commands.registerCommand('forkAi.editUserMcp', () => openMcpConfig(USER_CONFIG())),
		vscode.commands.registerCommand('forkAi.editProjectMcp', async () => {
			const root = vscode.workspace.workspaceFolders?.[0]?.uri;
			if (root) {
				await openMcpConfig(PROJECT_CONFIG(root));
			} else {
				void vscode.window.showInformationMessage('Open a folder to give it its own MCP servers. ~/.fork/mcp.json works for every project.');
			}
		}),
		vscode.commands.registerCommand('forkAi.reloadMcp', () => mcp.reload()),
		codebase,
		createIndexStatusBar(codebase),
		chat,
		inlineEdit,
		vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, chat, { webviewOptions: { retainContextWhenHidden: true } }),
		// Meridian's title bar, omnibar and status bar.
		registerMeridian(store, chat),

		vscode.commands.registerCommand('forkAi.openChat', () => chat.reveal()),
		vscode.commands.registerCommand('forkAi.newChat', () => chat.newChat()),
		// Meridian's welcome passes { kind: 'key' } (Bring my own key) or { kind: 'local' } (Local model).
		vscode.commands.registerCommand('forkAi.addModel', (args?: { kind?: 'key' | 'local' }) => addModel(store, 'chat', args?.kind === 'key' || args?.kind === 'local' ? args.kind : 'any')),
		vscode.commands.registerCommand('forkAi.manageModels', () => store.list().length ? manageModels(store) : addModel(store)),
		vscode.commands.registerCommand('forkAi.chooseEmbeddingModel', () => chooseEmbeddingModel(store)),
		vscode.commands.registerCommand('forkAi.reindex', () => codebase.rebuild()),
		vscode.commands.registerCommand('forkAi.indexMenu', () => showIndexMenu(codebase, store)),
		vscode.commands.registerCommand('forkAi.addCodebaseToChat', async () => {
			chat.addCodebase();
			await chat.reveal();
		}),
		vscode.commands.registerCommand('forkAi.editForkignore', async () => {
			const root = vscode.workspace.workspaceFolders?.[0]?.uri;
			if (!root) {
				return;
			}
			const uri = vscode.Uri.joinPath(root, '.forkignore');
			try {
				await vscode.workspace.fs.stat(uri);
			} catch {
				await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode('# Files the Companion leaves out of the codebase index, in .gitignore syntax.\n# .gitignore is followed too.\n\n'));
			}
			await vscode.window.showTextDocument(uri);
		}),

		vscode.commands.registerCommand('forkAi.inlineEdit', async () => {
			const editor = vscode.window.activeTextEditor;
			if (editor) {
				await inlineEdit.edit(editor);
			}
		}),
		vscode.commands.registerCommand('forkAi.applyCode', async (code: string) => {
			const editor = chat.targetEditor();
			if (!editor) {
				void vscode.window.showInformationMessage('Open the file to apply this code to, then press Apply again.');
				return;
			}
			const shown = await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, selection: editor.selection });
			await inlineEdit.applyCode(shown, code);
		}),
		vscode.commands.registerCommand('forkAi.acceptEdit', (uri: vscode.Uri, id: number) => inlineEdit.resolveHunk(uri, id, 'accept')),
		vscode.commands.registerCommand('forkAi.rejectEdit', (uri: vscode.Uri, id: number) => inlineEdit.resolveHunk(uri, id, 'reject')),
		vscode.commands.registerCommand('forkAi.acceptAllEdits', () => inlineEdit.resolveAll(undefined, 'accept')),
		vscode.commands.registerCommand('forkAi.rejectAllEdits', () => inlineEdit.resolveAll(undefined, 'reject')),
		vscode.commands.registerCommand('forkAi.cancelEdit', () => inlineEdit.cancel()),

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

	codebase.start();
	void mcp.reload();
}

export function deactivate(): void {
	// Everything is disposed through context.subscriptions.
}
