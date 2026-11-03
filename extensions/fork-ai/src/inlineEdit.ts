/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { createModelClient, ModelRouterError, type ModelConfig } from '../../../fork/model-router/src/index.ts';
import { combine } from './diff.ts';
import { buildEditMessages, EDIT_SYSTEM_PROMPT, extractCode, reindent } from './editPrompt.ts';
import type { ModelStore } from './modelStore.ts';

/** Above this, Apply asks for a selection instead of rewriting the whole file. */
export const MAX_APPLY_LINES = 2000;

interface TrackedHunk {
	readonly id: number;
	/** Absolute line of the hunk's first (removed) line. */
	start: number;
	readonly removed: number;
	readonly added: number;
}

interface ReviewSession {
	readonly document: vscode.TextDocument;
	readonly modelName: string;
	/** What the user asked for, shown on the edit's card. */
	readonly instruction: string;
	hunks: TrackedHunk[];
}

interface PendingEdit {
	readonly abort: AbortController;
	readonly startLine: number;
	readonly endLine: number;
}

export interface EditOptions {
	/** Skip the prompt and use this instruction. */
	readonly instruction?: string;
	/** Edit the whole document rather than the selection or current line. */
	readonly wholeFile?: boolean;
}

const isMac = process.platform === 'darwin';
const ACCEPT_KEYS = isMac ? '⌘⏎' : 'Ctrl+Enter';
const REJECT_KEYS = isMac ? '⌘⌫' : 'Ctrl+Backspace';

const APPLY_INSTRUCTION = 'Apply this change, suggested in chat, to the selected code.';

/** The instruction on one short line, for the edit's card. */
export function editTitle(instruction: string): string {
	if (instruction.startsWith(APPLY_INSTRUCTION)) {
		return 'Apply code from chat';
	}
	const line = instruction.replace(/\s+/g, ' ').trim();
	return line.length > 56 ? `${line.slice(0, 55).trimEnd()}…` : line;
}

/** Lines [start, start + count) as a range that also removes their line breaks. */
export function linesRange(document: vscode.TextDocument, start: number, count: number): vscode.Range {
	const end = start + count;
	if (end < document.lineCount) {
		return new vscode.Range(start, 0, end, 0);
	}
	const last = document.lineCount - 1;
	if (start > 0) {
		return new vscode.Range(start - 1, document.lineAt(start - 1).text.length, last, document.lineAt(last).text.length);
	}
	return new vscode.Range(0, 0, last, document.lineAt(last).text.length);
}

/**
 * Cmd+I inline edits. The model's change is written into the document as the old lines (red)
 * followed by the new lines (green); accepting a change deletes its red lines, rejecting deletes
 * its green lines. Every step is an ordinary edit, so undo works as usual.
 */
export class InlineEditController implements vscode.CodeLensProvider, vscode.Disposable {
	private readonly sessions = new Map<string, ReviewSession>();
	private readonly pending = new Map<string, PendingEdit>();
	private applying = 0;
	private nextId = 1;
	private readonly codeLensChanged = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this.codeLensChanged.event;

	private readonly removedDecoration = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
		overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
		overviewRulerLane: vscode.OverviewRulerLane.Left,
	});
	private readonly addedDecoration = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
		overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
		overviewRulerLane: vscode.OverviewRulerLane.Left,
	});
	private readonly pendingDecoration = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
	});
	private readonly pendingLabel = vscode.window.createTextEditorDecorationType({
		after: { contentText: '  Companion is editing… Esc to cancel', color: new vscode.ThemeColor('descriptionForeground'), fontStyle: 'italic' },
	});

	private readonly acceptAllItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
	private readonly rejectAllItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 999);
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly store: ModelStore) {
		this.acceptAllItem.command = 'forkAi.acceptAllEdits';
		this.rejectAllItem.command = 'forkAi.rejectAllEdits';
		this.rejectAllItem.text = '$(close) Reject all';
		this.rejectAllItem.tooltip = `Reject all Companion changes in this file (${REJECT_KEYS})`;
		this.disposables.push(
			vscode.languages.registerCodeLensProvider({ scheme: '*' }, this),
			vscode.workspace.onDidChangeTextDocument(event => this.onDocumentChanged(event)),
			vscode.workspace.onDidCloseTextDocument(document => {
				const key = document.uri.toString();
				this.sessions.delete(key);
				this.pending.get(key)?.abort.abort();
				this.refresh();
			}),
			vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
			vscode.window.onDidChangeVisibleTextEditors(() => this.decorate()),
		);
	}

	dispose(): void {
		for (const pending of this.pending.values()) {
			pending.abort.abort();
		}
		vscode.Disposable.from(
			...this.disposables, this.codeLensChanged, this.removedDecoration, this.addedDecoration,
			this.pendingDecoration, this.pendingLabel, this.acceptAllItem, this.rejectAllItem,
		).dispose();
	}

	// --- Starting an edit -------------------------------------------------------------------

	async edit(editor: vscode.TextEditor, options: EditOptions = {}): Promise<void> {
		const document = editor.document;
		const key = document.uri.toString();
		if (this.pending.has(key)) {
			return;
		}
		if (this.sessions.has(key)) {
			const choice = await vscode.window.showInformationMessage('Accept or reject the Companion changes in this file first.', 'Accept All', 'Reject All');
			if (choice === 'Accept All') {
				await this.resolveAll(document, 'accept');
			} else if (choice === 'Reject All') {
				await this.resolveAll(document, 'reject');
			}
			return;
		}

		const modelId = this.store.editModelId();
		const config = modelId ? await this.store.resolve(modelId) : undefined;
		if (!config) {
			await vscode.commands.executeCommand('forkAi.addModel');
			return;
		}

		const { startLine, endLine } = this.targetLines(editor, options.wholeFile === true);
		const hasSelection = !editor.selection.isEmpty || options.wholeFile === true;
		const instruction = options.instruction ?? await vscode.window.showInputBox({
			title: `Edit with Companion · ${config.displayName}`,
			prompt: hasSelection ? 'Describe the change to the selected code.' : 'Describe the code to write, or the change to make on this line.',
			placeHolder: 'e.g. add error handling, convert to async/await, write a function that parses dates',
			ignoreFocusOut: true,
		});
		if (!instruction?.trim()) {
			return;
		}

		await this.run(editor, config, startLine, endLine, instruction.trim());
	}

	/** Chat's Apply button: works on the selection, or the whole file when nothing is selected. */
	async applyCode(editor: vscode.TextEditor, code: string): Promise<void> {
		const wholeFile = editor.selection.isEmpty;
		if (wholeFile && editor.document.lineCount > MAX_APPLY_LINES) {
			void vscode.window.showInformationMessage(`This file has more than ${MAX_APPLY_LINES} lines. Select the part to change, then press Apply again.`);
			return;
		}
		const instruction = [
			APPLY_INSTRUCTION,
			'Return the complete selected code with the change applied. Keep every other line exactly as it is, and never abbreviate with comments like "rest of code unchanged".',
			'',
			'```',
			code,
			'```',
		].join('\n');
		await this.edit(editor, { instruction, wholeFile });
	}

	private targetLines(editor: vscode.TextEditor, wholeFile: boolean): { startLine: number; endLine: number } {
		if (wholeFile) {
			return { startLine: 0, endLine: editor.document.lineCount - 1 };
		}
		const selection = editor.selection;
		if (selection.isEmpty) {
			return { startLine: selection.active.line, endLine: selection.active.line };
		}
		// A selection ending at column 0 does not include that line.
		const endLine = selection.end.character === 0 && selection.end.line > selection.start.line ? selection.end.line - 1 : selection.end.line;
		return { startLine: selection.start.line, endLine };
	}

	private async run(editor: vscode.TextEditor, config: ModelConfig, startLine: number, endLine: number, instruction: string): Promise<void> {
		const document = editor.document;
		const key = document.uri.toString();
		const lines = (from: number, to: number) => {
			const out: string[] = [];
			for (let line = from; line <= to; line++) {
				out.push(document.lineAt(line).text);
			}
			return out;
		};
		const original = lines(startLine, endLine);
		const messages = buildEditMessages({
			path: vscode.workspace.asRelativePath(document.uri, false),
			language: document.languageId,
			before: lines(0, startLine - 1),
			selected: original,
			after: lines(endLine + 1, document.lineCount - 1),
			instruction,
		});

		const abort = new AbortController();
		this.pending.set(key, { abort, startLine, endLine });
		this.refresh();

		let reply: string;
		try {
			reply = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Window, title: `Companion: editing with ${config.displayName}` },
				async () => (await createModelClient(config).complete({ system: EDIT_SYSTEM_PROMPT, messages, signal: abort.signal })).text,
			);
		} catch (error) {
			if (!(error instanceof ModelRouterError && error.kind === 'aborted')) {
				const message = error instanceof Error ? error.message : String(error);
				void vscode.window.showErrorMessage(`The Companion could not edit: ${message}`, 'Manage Models').then(choice => {
					if (choice) {
						void vscode.commands.executeCommand('forkAi.manageModels');
					}
				});
			}
			return;
		} finally {
			this.pending.delete(key);
			this.refresh();
		}

		if (document.isClosed) {
			return;
		}
		if (endLine >= document.lineCount || lines(startLine, endLine).join('\n') !== original.join('\n')) {
			void vscode.window.showWarningMessage('The code changed while the Companion was working, so the edit was not applied. Try again.');
			return;
		}

		const code = extractCode(reply);
		const updated = reindent(original, code === '' ? [] : code.split('\n'));
		const layout = combine(original, updated);
		if (!layout.hunks.length) {
			void vscode.window.showInformationMessage('The Companion suggested no changes.');
			return;
		}

		const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
		const edit = new vscode.WorkspaceEdit();
		edit.replace(document.uri, new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length), layout.lines.join(eol));
		if (!await this.applyEdit(edit)) {
			void vscode.window.showWarningMessage('The Companion could not write the edit to the file.');
			return;
		}

		this.sessions.set(key, {
			document,
			modelName: config.displayName,
			instruction,
			hunks: layout.hunks.map(hunk => ({ id: this.nextId++, start: startLine + hunk.offset, removed: hunk.removed, added: hunk.added })),
		});
		this.refresh();
		const first = startLine + layout.hunks[0].offset;
		const visible = vscode.window.visibleTextEditors.find(candidate => candidate.document === document);
		visible?.revealRange(new vscode.Range(first, 0, first, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
	}

	cancel(document?: vscode.TextDocument): void {
		const key = (document ?? vscode.window.activeTextEditor?.document)?.uri.toString();
		if (key) {
			this.pending.get(key)?.abort.abort();
		}
	}

	// --- Review -----------------------------------------------------------------------------

	hasReview(document: vscode.TextDocument): boolean {
		return this.sessions.has(document.uri.toString());
	}

	async resolveHunk(uri: vscode.Uri, id: number, decision: 'accept' | 'reject'): Promise<void> {
		const session = this.sessions.get(uri.toString());
		const index = session?.hunks.findIndex(hunk => hunk.id === id) ?? -1;
		if (!session || index === -1) {
			return;
		}
		const hunk = session.hunks[index];
		// Accepting drops the old (red) lines; rejecting drops the new (green) lines.
		const from = decision === 'accept' ? hunk.start : hunk.start + hunk.removed;
		const count = decision === 'accept' ? hunk.removed : hunk.added;
		if (count) {
			const edit = new vscode.WorkspaceEdit();
			edit.delete(uri, linesRange(session.document, from, count));
			if (!await this.applyEdit(edit)) {
				return;
			}
		}
		session.hunks.splice(index, 1);
		for (const later of session.hunks) {
			if (later.start > hunk.start) {
				later.start -= count;
			}
		}
		this.endIfDone(session);
		this.refresh();
	}

	async resolveAll(document: vscode.TextDocument | undefined, decision: 'accept' | 'reject'): Promise<void> {
		const target = document ?? vscode.window.activeTextEditor?.document;
		const session = target && this.sessions.get(target.uri.toString());
		if (!session) {
			return;
		}
		const edit = new vscode.WorkspaceEdit();
		for (const hunk of session.hunks) {
			const from = decision === 'accept' ? hunk.start : hunk.start + hunk.removed;
			const count = decision === 'accept' ? hunk.removed : hunk.added;
			if (count) {
				edit.delete(session.document.uri, linesRange(session.document, from, count));
			}
		}
		if (await this.applyEdit(edit)) {
			session.hunks = [];
			this.endIfDone(session);
			this.refresh();
		}
	}

	private endIfDone(session: ReviewSession): void {
		if (!session.hunks.length) {
			this.sessions.delete(session.document.uri.toString());
		}
	}

	private async applyEdit(edit: vscode.WorkspaceEdit): Promise<boolean> {
		this.applying++;
		try {
			return await vscode.workspace.applyEdit(edit);
		} finally {
			this.applying--;
		}
	}

	/**
	 * Keeps hunk positions right while the user edits elsewhere in the file. Typing inside a
	 * change ends tracking of that change and leaves its lines as they are. Undoing the whole
	 * edit therefore ends the review cleanly.
	 */
	private onDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
		if (this.applying || !event.contentChanges.length) {
			return;
		}
		const session = this.sessions.get(event.document.uri.toString());
		if (!session) {
			return;
		}
		const changes = [...event.contentChanges].sort((a, b) => b.range.start.line - a.range.start.line);
		for (const change of changes) {
			const startLine = change.range.start.line;
			const endLine = change.range.end.line;
			const delta = (change.text.match(/\n/g)?.length ?? 0) - (endLine - startLine);
			session.hunks = session.hunks.filter(hunk => {
				const last = hunk.start + hunk.removed + hunk.added - 1;
				if (endLine < hunk.start) {
					hunk.start += delta;
					return true;
				}
				return startLine > last;
			});
		}
		this.endIfDone(session);
		this.refresh();
	}

	// --- Presentation -----------------------------------------------------------------------

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const session = this.sessions.get(document.uri.toString());
		if (!session) {
			return [];
		}
		const lenses: vscode.CodeLens[] = [];
		session.hunks.forEach((hunk, index) => {
			const range = new vscode.Range(hunk.start, 0, hunk.start, 0);
			const args = [document.uri, hunk.id];
			// Meridian's "Companion edit" card: what was asked, then Reject and Accept.
			if (index === 0) {
				lenses.push(new vscode.CodeLens(range, { title: `$(sparkle) Companion edit · ${editTitle(session.instruction)}`, command: '', tooltip: `${editTitle(session.instruction) === 'Apply code from chat' ? 'Code from the chat, applied here' : session.instruction.slice(0, 400)}\n\nEdited by ${session.modelName}` }));
			}
			if (index === 0 && session.hunks.length > 1) {
				lenses.push(new vscode.CodeLens(range, { title: `Reject all ${REJECT_KEYS}`, command: 'forkAi.rejectAllEdits', arguments: [] }));
				lenses.push(new vscode.CodeLens(range, { title: `Accept all ${ACCEPT_KEYS}`, command: 'forkAi.acceptAllEdits', arguments: [] }));
			}
			lenses.push(new vscode.CodeLens(range, { title: session.hunks.length > 1 ? '$(close) Reject' : `$(close) Reject ${REJECT_KEYS}`, command: 'forkAi.rejectEdit', arguments: args, tooltip: 'Undo this change' }));
			lenses.push(new vscode.CodeLens(range, { title: session.hunks.length > 1 ? '$(check) Accept' : `$(check) Accept ${ACCEPT_KEYS}`, command: 'forkAi.acceptEdit', arguments: args, tooltip: 'Keep this change' }));
		});
		return lenses;
	}

	private decorate(): void {
		for (const editor of vscode.window.visibleTextEditors) {
			const key = editor.document.uri.toString();
			const session = this.sessions.get(key);
			const removed: vscode.Range[] = [];
			const added: vscode.Range[] = [];
			for (const hunk of session?.hunks ?? []) {
				if (hunk.removed) {
					removed.push(new vscode.Range(hunk.start, 0, hunk.start + hunk.removed - 1, 0));
				}
				if (hunk.added) {
					added.push(new vscode.Range(hunk.start + hunk.removed, 0, hunk.start + hunk.removed + hunk.added - 1, 0));
				}
			}
			editor.setDecorations(this.removedDecoration, removed);
			editor.setDecorations(this.addedDecoration, added);

			const pending = this.pending.get(key);
			if (pending && pending.endLine < editor.document.lineCount) {
				const firstLineEnd = editor.document.lineAt(pending.startLine).range.end;
				editor.setDecorations(this.pendingDecoration, [new vscode.Range(pending.startLine, 0, pending.endLine, 0)]);
				editor.setDecorations(this.pendingLabel, [new vscode.Range(firstLineEnd, firstLineEnd)]);
			} else {
				editor.setDecorations(this.pendingDecoration, []);
				editor.setDecorations(this.pendingLabel, []);
			}
		}
	}

	private refresh(): void {
		this.decorate();
		this.codeLensChanged.fire();
		const document = vscode.window.activeTextEditor?.document;
		const session = document && this.sessions.get(document.uri.toString());
		void vscode.commands.executeCommand('setContext', 'forkAi.reviewing', Boolean(session));
		void vscode.commands.executeCommand('setContext', 'forkAi.generating', Boolean(document && this.pending.has(document.uri.toString())));
		if (session) {
			const count = session.hunks.length;
			this.acceptAllItem.text = `$(check) Accept ${count === 1 ? 'change' : `all ${count} changes`}`;
			this.acceptAllItem.tooltip = `Keep the Companion changes from ${session.modelName} (${ACCEPT_KEYS})`;
			this.acceptAllItem.show();
			this.rejectAllItem.show();
		} else {
			this.acceptAllItem.hide();
			this.rejectAllItem.hide();
		}
	}
}
