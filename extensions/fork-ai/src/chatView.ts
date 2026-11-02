/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { createModelClient, ModelRouterError } from '../../../fork/model-router/src/index.ts';
import { readRules, restoreCheckpoint, runAgentTurn, summarizeChanges, withRules } from './agent/agentTurn.ts';
import type { ApprovalDecision } from './agent/workspaceTools.ts';
import { attachmentLabel, buildMessages, currentFileLabel, HISTORY_BUDGET_CHARS, renderContext, SYSTEM_PROMPT, type Attachment, type EditorContext } from './context.ts';
import { ChatHistory, newId, newSession, titleFor, type AgentStepRecord, type ChatSession, type ChatTurn } from './history.ts';
import { modelDetail } from './manageModels.ts';
import type { KeyValueStore, ModelStore } from './modelStore.ts';
import type { ChatMode, ChatState, ContextChip, FromWebview, ToWebview } from './protocol.ts';

export const CHAT_VIEW_ID = 'forkAi.chat';
const MAX_ATTACHED_FILE_BYTES = 512 * 1024;
const CHECKPOINT_SCHEME = 'fork-ai-checkpoint';
const MODE_KEY = 'forkAi.mode';
const ALLOWED_COMMANDS_KEY = 'forkAi.allowedCommands';

function nonce(): string {
	let text = '';
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return text;
}

function relativePath(uri: vscode.Uri): string {
	return uri.scheme === 'untitled' ? uri.path : vscode.workspace.asRelativePath(uri, false);
}

function errorText(error: unknown, local: boolean): string {
	if (error instanceof ModelRouterError) {
		if (error.kind === 'network' && local) {
			return `${error.message}\nIs the local model server (Ollama or LM Studio) running?`;
		}
		return error.message;
	}
	return error instanceof Error ? error.message : String(error);
}

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	private view: vscode.WebviewView | undefined;
	private session: ChatSession;
	private attachments: Attachment[] = [];
	private currentFileExcluded = false;
	private lastEditor: vscode.TextEditor | undefined;
	private abort: AbortController | undefined;
	private streamingTurnId: string | undefined;
	private stateTimer: ReturnType<typeof setTimeout> | undefined;
	private liveTimer: ReturnType<typeof setTimeout> | undefined;
	private mode: ChatMode;
	private readonly approvals = new Map<string, (decision: ApprovalDecision) => void>();
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly store: ModelStore,
		private readonly history: ChatHistory,
		private readonly workspaceState: KeyValueStore,
	) {
		this.session = history.current() ?? newSession();
		this.lastEditor = vscode.window.activeTextEditor;
		this.mode = workspaceState.get<ChatMode>(MODE_KEY) === 'agent' ? 'agent' : 'ask';
		this.disposables.push(
			// The left side of Review: a file as it was before the agent's turn.
			vscode.workspace.registerTextDocumentContentProvider(CHECKPOINT_SCHEME, {
				provideTextDocumentContent: uri => {
					const turn = this.session.turns.find(candidate => candidate.id === uri.query);
					return turn?.checkpoint?.[uri.path.replace(/^\//, '')] ?? '';
				},
			}),
			store.onDidChange(() => this.postState()),
			vscode.window.onDidChangeActiveTextEditor(editor => {
				if (editor) {
					this.lastEditor = editor;
					this.currentFileExcluded = false;
				}
				this.postStateSoon();
			}),
			vscode.window.onDidChangeTextEditorSelection(event => {
				if (event.textEditor === this.lastEditor) {
					this.postStateSoon();
				}
			}),
			vscode.workspace.onDidCloseTextDocument(document => {
				if (this.lastEditor?.document === document) {
					this.lastEditor = undefined;
					this.postStateSoon();
				}
			}),
		);
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist'), vscode.Uri.joinPath(this.extensionUri, 'media')],
		};
		view.webview.html = this.html(view.webview);
		view.webview.onDidReceiveMessage((message: FromWebview) => this.onMessage(message), undefined, this.disposables);
		view.onDidChangeVisibility(() => view.visible && this.postState(), undefined, this.disposables);
		view.onDidDispose(() => { this.view = undefined; }, undefined, this.disposables);
	}

	dispose(): void {
		this.abort?.abort();
		clearTimeout(this.stateTimer);
		clearTimeout(this.liveTimer);
		vscode.Disposable.from(...this.disposables).dispose();
	}

	// --- Public actions (commands) --------------------------------------------------------

	async reveal(): Promise<void> {
		await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
		this.post({ type: 'focusInput' });
	}

	async newChat(): Promise<void> {
		this.stop();
		this.session = newSession();
		this.attachments = [];
		this.currentFileExcluded = false;
		await this.history.setCurrent(undefined);
		this.postState();
		await this.reveal();
	}

	async openSession(session: ChatSession): Promise<void> {
		this.stop();
		this.session = session;
		this.attachments = [];
		await this.history.setCurrent(session.id);
		this.postState();
		await this.reveal();
	}

	addSelection(editor: vscode.TextEditor): void {
		const selection = editor.selection;
		if (selection.isEmpty) {
			return;
		}
		const text = editor.document.getText(selection);
		const startLine = selection.start.line + 1;
		const endLine = selection.end.character === 0 && selection.end.line > selection.start.line ? selection.end.line : selection.end.line + 1;
		this.attachments.push({
			id: newId('sel'),
			kind: 'selection',
			path: relativePath(editor.document.uri),
			language: editor.document.languageId,
			text,
			startLine,
			endLine,
		});
		this.postState();
	}

	async addFile(uri: vscode.Uri): Promise<void> {
		const path = relativePath(uri);
		if (this.attachments.some(attachment => attachment.kind === 'file' && attachment.path === path)) {
			return;
		}
		try {
			const stat = await vscode.workspace.fs.stat(uri);
			if (stat.size > MAX_ATTACHED_FILE_BYTES) {
				void vscode.window.showWarningMessage(`${path} is larger than 512 KB and was not added.`);
				return;
			}
			const document = await vscode.workspace.openTextDocument(uri);
			this.attachments.push({ id: newId('file'), kind: 'file', path, language: document.languageId, text: document.getText() });
			this.postState();
		} catch (error) {
			void vscode.window.showWarningMessage(`Could not add ${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async pickFile(): Promise<void> {
		const files = await vscode.workspace.findFiles('**/*', undefined, 5000);
		const items = files
			.map(uri => ({ label: vscode.workspace.asRelativePath(uri, false), uri }))
			.sort((a, b) => a.label.localeCompare(b.label));
		const picked = await vscode.window.showQuickPick(items, { title: 'Add file to chat', placeHolder: items.length ? 'Search files' : 'Open a folder to add its files', matchOnDescription: true });
		if (picked) {
			await this.addFile(picked.uri);
		}
		this.post({ type: 'focusInput' });
	}

	// --- Webview messages -------------------------------------------------------------------

	private async onMessage(message: FromWebview): Promise<void> {
		switch (message.type) {
			case 'ready':
				this.postState();
				break;
			case 'send':
				await this.send(message.text);
				break;
			case 'stop':
				this.stop();
				break;
			case 'selectModel':
				await this.store.setChatModel(message.id);
				break;
			case 'addModel':
				await vscode.commands.executeCommand('forkAi.addModel');
				break;
			case 'manageModels':
				await vscode.commands.executeCommand('forkAi.manageModels');
				break;
			case 'attachFile':
				await this.pickFile();
				break;
			case 'removeAttachment':
				this.attachments = this.attachments.filter(attachment => attachment.id !== message.id);
				this.postState();
				break;
			case 'toggleCurrentFile':
				this.currentFileExcluded = !this.currentFileExcluded;
				this.postState();
				break;
			case 'copyCode':
				await vscode.env.clipboard.writeText(message.code);
				break;
			case 'insertCode':
				await this.insertCode(message.code);
				break;
			case 'applyCode':
				await vscode.commands.executeCommand('forkAi.applyCode', message.code);
				break;
			case 'newChat':
				await this.newChat();
				break;
			case 'setMode':
				this.mode = message.mode === 'agent' ? 'agent' : 'ask';
				await this.workspaceState.update(MODE_KEY, this.mode);
				this.postState();
				break;
			case 'approve':
				this.approvals.get(message.stepId)?.(message.decision);
				break;
			case 'reviewChange':
				await this.reviewChange(message.turnId, message.path);
				break;
			case 'undoChanges':
				await this.undoChanges(message.turnId);
				break;
		}
	}

	private root(): vscode.Uri | undefined {
		return vscode.workspace.workspaceFolders?.[0]?.uri;
	}

	private async reviewChange(turnId: string, path: string): Promise<void> {
		const root = this.root();
		const turn = this.session.turns.find(candidate => candidate.id === turnId);
		if (!root || !turn) {
			return;
		}
		const current = vscode.Uri.joinPath(root, ...path.split('/'));
		if (!turn.checkpoint) {
			await vscode.window.showTextDocument(current);
			return;
		}
		const before = vscode.Uri.from({ scheme: CHECKPOINT_SCHEME, path: `/${path}`, query: turnId });
		await vscode.commands.executeCommand('vscode.diff', before, current, `${path} (before ↔ after the agent)`);
	}

	private async undoChanges(turnId: string): Promise<void> {
		const root = this.root();
		const turn = this.session.turns.find(candidate => candidate.id === turnId);
		if (!root || !turn?.checkpoint || turn.undone) {
			return;
		}
		const count = Object.keys(turn.checkpoint).length;
		const answer = await vscode.window.showWarningMessage(
			`Undo the agent's changes to ${count} file${count === 1 ? '' : 's'}?`,
			{ modal: true, detail: 'Each file goes back to how it was before this turn, including any edits you made since. Files the agent created go to the trash.' },
			'Undo Changes',
		);
		if (answer !== 'Undo Changes') {
			return;
		}
		const failed = await restoreCheckpoint(root, turn.checkpoint);
		if (failed.length) {
			void vscode.window.showErrorMessage(`Could not restore: ${failed.join(', ')}`);
		}
		turn.undone = true;
		turn.checkpoint = undefined;
		await this.history.save(this.session);
		this.postState();
	}

	private allowedCommands(): readonly string[] {
		return this.workspaceState.get<string[]>(ALLOWED_COMMANDS_KEY) ?? [];
	}

	private async allowAlways(command: string): Promise<void> {
		const allowed = new Set(this.allowedCommands());
		allowed.add(command);
		await this.workspaceState.update(ALLOWED_COMMANDS_KEY, [...allowed]);
	}

	private askApproval(step: AgentStepRecord, command: string, allowAlways: boolean): Promise<ApprovalDecision> {
		step.status = 'awaiting';
		step.approval = { command, allowAlways };
		this.postState();
		void this.reveal();
		return new Promise(resolve => {
			this.approvals.set(step.id, decision => {
				this.approvals.delete(step.id);
				step.status = 'running';
				step.approval = undefined;
				this.postState();
				resolve(decision === 'always' && !allowAlways ? 'run' : decision);
			});
		});
	}

	/** The editor chat actions (Insert, Apply) act on: the last text editor the user worked in. */
	targetEditor(): vscode.TextEditor | undefined {
		return this.lastEditor && !this.lastEditor.document.isClosed ? this.lastEditor : undefined;
	}

	private async insertCode(code: string): Promise<void> {
		const editor = this.lastEditor && !this.lastEditor.document.isClosed ? this.lastEditor : undefined;
		if (!editor) {
			const document = await vscode.workspace.openTextDocument({ content: code });
			await vscode.window.showTextDocument(document);
			return;
		}
		const shown = await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, selection: editor.selection, preserveFocus: false });
		await shown.edit(builder => builder.replace(shown.selection, code));
	}

	// --- Chat -------------------------------------------------------------------------------

	private stop(): void {
		this.abort?.abort();
		for (const resolve of [...this.approvals.values()]) {
			resolve('skip');
		}
	}

	private editorContext(): EditorContext | undefined {
		const editor = this.lastEditor;
		if (!editor || editor.document.isClosed || this.currentFileExcluded) {
			return undefined;
		}
		const document = editor.document;
		if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled' && document.uri.scheme !== 'vscode-remote') {
			return undefined;
		}
		const selection = editor.selection;
		const startLine = selection.start.line + 1;
		const endLine = selection.end.line + 1;
		return {
			path: relativePath(document.uri),
			language: document.languageId,
			text: document.getText(),
			selection: selection.isEmpty ? undefined : { startLine, endLine, text: document.getText(selection) },
		};
	}

	private async send(text: string): Promise<void> {
		if (this.abort) {
			return;
		}
		const modelId = this.store.chatModelId();
		const config = modelId ? await this.store.resolve(modelId) : undefined;
		if (!config) {
			await vscode.commands.executeCommand('forkAi.addModel');
			return;
		}

		const context = renderContext(this.editorContext(), this.attachments);
		const userTurn: ChatTurn = { id: newId('turn'), role: 'user', text, context: context?.text, chips: context?.chips };
		const reply: ChatTurn = { id: newId('turn'), role: 'assistant', text: '', modelName: config.displayName };
		if (!this.session.turns.length) {
			this.session.title = titleFor(text);
		}
		this.session.turns.push(userTurn, reply);
		this.session.updatedAt = Date.now();
		this.attachments = [];

		const abort = new AbortController();
		this.abort = abort;
		this.streamingTurnId = reply.id;
		this.postState();

		if (this.mode === 'agent') {
			await this.runAgent(config, reply, abort);
			return;
		}

		try {
			const client = createModelClient(config);
			const rules = await readRules(this.root());
			const stream = client.stream({ system: withRules(SYSTEM_PROMPT, rules), messages: buildMessages(this.session.turns.slice(0, -1)), signal: abort.signal });
			for await (const event of stream) {
				if (event.type === 'text') {
					reply.text += event.text;
					this.post({ type: 'delta', turnId: reply.id, text: event.text });
				} else if (event.type === 'done' && event.stopReason === 'max_tokens') {
					reply.text += '\n\n*[The reply hit the model\'s output limit.]*';
				}
			}
		} catch (error) {
			if (!(error instanceof ModelRouterError && error.kind === 'aborted')) {
				const local = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(config.baseUrl);
				reply.error = errorText(error, local);
			}
		} finally {
			this.abort = undefined;
			this.streamingTurnId = undefined;
			this.session.updatedAt = Date.now();
			await this.history.save(this.session);
			this.postState();
		}
	}

	private async runAgent(config: Awaited<ReturnType<ModelStore['resolve']>> & object, reply: ChatTurn, abort: AbortController): Promise<void> {
		const root = this.root();
		try {
			if (!root) {
				reply.error = 'Open a folder to use the agent: it works on the files in your project.';
				return;
			}
			reply.steps = [];
			reply.checkpoint = {};
			await runAgentTurn({
				config,
				root,
				reply,
				messages: buildMessages(this.session.turns.slice(0, -1), HISTORY_BUDGET_CHARS, { includeTools: true }),
				signal: abort.signal,
				allowedCommands: () => this.allowedCommands(),
				allowAlways: command => this.allowAlways(command),
				askApproval: (step, command, allowAlways) => this.askApproval(step, command, allowAlways),
				onUpdate: () => this.postStateLive(),
			});
		} catch (error) {
			if (!(error instanceof ModelRouterError && error.kind === 'aborted')) {
				const local = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(config.baseUrl);
				reply.error = errorText(error, local);
			}
		} finally {
			if (root && reply.checkpoint) {
				reply.changes = await summarizeChanges(root, reply.checkpoint);
			}
			this.abort = undefined;
			this.streamingTurnId = undefined;
			this.session.updatedAt = Date.now();
			await this.history.save(this.session);
			this.postState();
		}
	}

	// --- State ------------------------------------------------------------------------------

	private state(): ChatState {
		const editor = this.lastEditor && !this.lastEditor.document.isClosed ? this.lastEditor : undefined;
		let currentFile: ContextChip | undefined;
		if (editor) {
			const selection = editor.selection;
			const context: EditorContext = {
				path: relativePath(editor.document.uri),
				language: editor.document.languageId,
				text: '',
				selection: selection.isEmpty ? undefined : { startLine: selection.start.line + 1, endLine: selection.end.line + 1, text: '' },
			};
			currentFile = {
				id: 'current',
				kind: 'current',
				label: currentFileLabel(context),
				title: this.currentFileExcluded ? 'Not sent with your message. Click to include it.' : `${context.path} is sent with your message. Click to leave it out.`,
			};
		}
		return {
			models: this.store.list().map(model => ({ id: model.id, name: model.displayName, detail: modelDetail(model) })),
			selectedModelId: this.store.chatModelId(),
			turns: this.session.turns.map(turn => ({
				id: turn.id,
				role: turn.role,
				text: turn.text,
				chips: turn.chips,
				error: turn.error,
				modelName: turn.modelName,
				steps: turn.steps?.map(step => ({ id: step.id, kind: step.kind, text: step.text, status: step.status, detail: step.detail, approval: step.approval })),
				changes: turn.changes,
				canUndo: Boolean(turn.checkpoint && turn.changes?.length) && !turn.undone,
				undone: turn.undone,
			})),
			currentFile,
			currentFileExcluded: this.currentFileExcluded,
			attachments: this.attachments.map(attachment => ({ id: attachment.id, kind: attachment.kind, label: attachmentLabel(attachment), title: attachment.path })),
			busy: Boolean(this.abort),
			streamingTurnId: this.streamingTurnId,
			mode: this.mode,
			agentWarning: this.agentWarning(),
		};
	}

	private agentWarning(): string | undefined {
		if (this.mode !== 'agent') {
			return undefined;
		}
		if (!this.root()) {
			return 'Open a folder to use the agent.';
		}
		const modelId = this.store.chatModelId();
		const model = modelId ? this.store.get(modelId) : undefined;
		if (model?.toolCalling === false) {
			return `${model.displayName} did not pass the tool-calling test, so it may not work as an agent. Pick another model, or retest it in Manage Models.`;
		}
		return undefined;
	}

	private post(message: ToWebview): void {
		void this.view?.webview.postMessage(message);
	}

	/** Agent steps change many times a second while streaming; send at most every 80 ms. */
	private postStateLive(): void {
		if (!this.liveTimer) {
			this.liveTimer = setTimeout(() => {
				this.liveTimer = undefined;
				this.postState();
			}, 80);
		}
	}

	private postState(): void {
		clearTimeout(this.stateTimer);
		this.stateTimer = undefined;
		if (this.view?.visible) {
			this.post({ type: 'state', state: this.state() });
		}
	}

	/** Editor focus and selection change often; batch those updates. */
	private postStateSoon(): void {
		if (!this.stateTimer) {
			this.stateTimer = setTimeout(() => this.postState(), 250);
		}
	}

	private html(webview: vscode.Webview): string {
		const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'chat.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.css'));
		const scriptNonce = nonce();
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; script-src 'nonce-${scriptNonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${style}">
	<title>Fork AI Chat</title>
</head>
<body>
	<script type="module" nonce="${scriptNonce}" src="${script}"></script>
</body>
</html>`;
	}
}
