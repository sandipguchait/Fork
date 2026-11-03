/*---------------------------------------------------------------------------------------------
 *  Meridian. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { API_OPEN_DIFF_EDITOR_COMMAND_ID } from '../../../browser/parts/editor/editorCommands.js';
import { IEditorGroupView } from '../../../browser/parts/editor/editor.js';
import { IEditorGroupFooter } from '../../../browser/parts/editor/editorGroupFooter.js';
import { EditorResourceAccessor, SideBySideEditor } from '../../../common/editor.js';
import { DiffEditorInput } from '../../../common/editor/diffEditorInput.js';
import { IWorkingCopyHistoryEntry, IWorkingCopyHistoryService } from '../../../services/workingCopy/common/workingCopyHistory.js';
import { toDiffEditorArguments } from '../../localHistory/browser/localHistoryCommands.js';

// The time scrub at the bottom of each editor: the file's local history (every save is a snapshot)
// as marks on a line that ends at "Now". A mark opens that snapshot next to the current file.

export const TIME_SCRUB_SETTING = 'meridian.editor.timeScrub';
const HEIGHT = 44;
const MAX_MARKS = 40;

export class TimeScrub extends Disposable implements IEditorGroupFooter {

	readonly element: HTMLElement;
	private readonly track: HTMLElement;
	private readonly marks: HTMLElement;
	private readonly empty: HTMLElement;
	private readonly onDidChangeHeightEmitter = this._register(new Emitter<void>());
	readonly onDidChangeHeight = this.onDidChangeHeightEmitter.event;
	private readonly loading = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly markListeners = this._register(new DisposableStore());
	private resource: URI | undefined;
	private shown = false;

	constructor(
		private readonly group: IEditorGroupView,
		@IWorkingCopyHistoryService private readonly historyService: IWorkingCopyHistoryService,
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFileService private readonly fileService: IFileService,
	) {
		super();
		this.element = $('.meridian-time-scrub');
		this.element.setAttribute('role', 'toolbar');
		this.element.setAttribute('aria-label', localize('meridian.timeScrub', "Local history of this file"));

		const label = append(this.element, $('.meridian-time-scrub-label'));
		label.appendChild(renderIcon(Codicon.history));
		append(label, $('span', undefined, localize('meridian.localHistory', "Local history")));

		this.track = append(this.element, $('.meridian-time-scrub-track'));
		append(this.track, $('span.meridian-time-scrub-line'));
		this.marks = append(this.track, $('.meridian-time-scrub-marks'));
		this.empty = append(this.track, $('span.meridian-time-scrub-empty', undefined, localize('meridian.noSnapshots', "No snapshots yet. Each save adds one.")));
		const now = append(this.track, $('button.meridian-time-scrub-now')) as HTMLButtonElement;
		now.type = 'button';
		now.setAttribute('aria-label', localize('meridian.now', "Now: the file as it is"));
		now.title = localize('meridian.now', "Now: the file as it is");
		this._register(addDisposableListener(now, EventType.CLICK, () => this.group.activeEditorPane?.focus()));
		append(this.element, $('span.meridian-time-scrub-now-label', undefined, localize('meridian.nowLabel', "Now")));

		this._register(this.group.onDidActiveEditorChange(() => this.refresh()));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(TIME_SCRUB_SETTING)) {
				this.refresh();
			}
		}));
		const onHistory = (e: { entry: IWorkingCopyHistoryEntry }) => {
			if (this.resource && e.entry.workingCopy.resource.toString() === this.resource.toString()) {
				this.load();
			}
		};
		this._register(this.historyService.onDidAddEntry(onHistory));
		this._register(this.historyService.onDidChangeEntry(onHistory));
		this._register(this.historyService.onDidRemoveEntry(onHistory));
		this._register(this.historyService.onDidMoveEntries(() => this.load()));
		this._register(this.historyService.onDidRemoveEntries(() => this.load()));
		this.refresh();
	}

	get height(): number {
		return this.shown ? HEIGHT : 0;
	}

	/** Shows the scrub for text files (anything with local history), hides it for everything else. */
	private refresh(): void {
		const editor = this.group.activeEditor;
		const resource = EditorResourceAccessor.getOriginalUri(editor, { supportSideBySide: SideBySideEditor.PRIMARY });
		const enabled = this.configurationService.getValue<boolean>(TIME_SCRUB_SETTING) !== false;
		// Files only: not diffs (they compare two versions already), not untitled buffers, not
		// pages like Welcome or Settings that have no file behind them.
		const shown = Boolean(enabled && editor && resource && !(editor instanceof DiffEditorInput) && resource.scheme !== 'untitled' && this.fileService.hasProvider(resource));
		this.resource = shown ? resource : undefined;
		if (shown !== this.shown) {
			this.shown = shown;
			this.onDidChangeHeightEmitter.fire();
		}
		if (shown) {
			this.load();
		}
	}

	private async load(): Promise<void> {
		const resource = this.resource;
		if (!resource) {
			return;
		}
		const cts = new CancellationTokenSource();
		this.loading.value = cts;
		let entries: readonly IWorkingCopyHistoryEntry[] = [];
		try {
			entries = await this.historyService.getEntries(resource, cts.token);
		} catch {
			entries = [];
		}
		if (cts.token.isCancellationRequested || resource !== this.resource) {
			return;
		}
		this.render(resource, entries);
	}

	private render(resource: URI, all: readonly IWorkingCopyHistoryEntry[]): void {
		this.markListeners.clear();
		clearNode(this.marks);
		const entries = [...all].sort((a, b) => a.timestamp - b.timestamp).slice(-MAX_MARKS);
		this.empty.classList.toggle('hidden', entries.length > 0);
		if (!entries.length) {
			return;
		}
		// Marks share the line by time, the oldest at the left and "Now" at the right end.
		const now = Date.now();
		const first = entries[0].timestamp;
		const span = Math.max(now - first, 1);
		let lastLeft = -Infinity;
		for (const entry of entries) {
			// Keep marks at least a few pixels apart, so close saves stay clickable.
			const left = Math.max((entry.timestamp - first) / span * 94, lastLeft + 1.4);
			lastLeft = left;
			const mark = append(this.marks, $('button.meridian-time-scrub-mark')) as HTMLButtonElement;
			mark.type = 'button';
			mark.style.left = `${Math.min(left, 94)}%`;
			const when = new Date(entry.timestamp);
			const label = localize('meridian.snapshot', "{0} ({1}){2}. Click to compare with the file now.", when.toLocaleString(), fromNow(entry.timestamp, true, true), entry.sourceDescription ? ` · ${entry.sourceDescription}` : '');
			mark.title = label;
			mark.setAttribute('aria-label', label);
			this.markListeners.add(addDisposableListener(mark, EventType.CLICK, () => this.commandService.executeCommand(API_OPEN_DIFF_EDITOR_COMMAND_ID, ...toDiffEditorArguments(entry, resource))));
		}
	}
}
