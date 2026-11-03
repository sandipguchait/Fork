/*---------------------------------------------------------------------------------------------
 *  Meridian. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService, Verbosity } from '../../../../platform/label/common/label.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IActivityService, NumberBadge } from '../../../services/activity/common/activity.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { EditorResourceAccessor } from '../../../common/editor.js';

// The Space header at the top of the side bar: the workspace ("Space") name, a switch between
// Files, Changes and Outline, and the files the user pinned to this Space.

export const SPACE_VIEW_CONTAINERS = {
	files: 'workbench.view.explorer',
	changes: 'workbench.view.scm',
} as const;
const FILES_VIEW_ID = 'workbench.explorer.fileView';
const OUTLINE_VIEW_ID = 'outline';
const PINNED_KEY = 'meridian.space.pinned';
const SINGLE_VIEW_KEY = 'meridian.space.singleView';
const MAX_PINNED = 12;

export type SpaceTab = 'files' | 'changes' | 'outline';

/** Files pinned to this workspace, most recent last. */
export class SpacePinnedFiles {

	static read(storageService: IStorageService): URI[] {
		try {
			const raw = JSON.parse(storageService.get(PINNED_KEY, StorageScope.WORKSPACE, '[]'));
			return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string').map(entry => URI.parse(entry)) : [];
		} catch {
			return [];
		}
	}

	static write(storageService: IStorageService, files: readonly URI[]): void {
		storageService.store(PINNED_KEY, JSON.stringify(files.slice(-MAX_PINNED).map(uri => uri.toString())), StorageScope.WORKSPACE, StorageTarget.USER);
	}

	static toggle(storageService: IStorageService, resource: URI, pin?: boolean): void {
		const files = SpacePinnedFiles.read(storageService);
		const index = files.findIndex(file => file.toString() === resource.toString());
		const shouldPin = pin ?? index === -1;
		if (shouldPin && index === -1) {
			files.push(resource);
		} else if (!shouldPin && index !== -1) {
			files.splice(index, 1);
		}
		SpacePinnedFiles.write(storageService, files);
	}

	static readonly key = PINNED_KEY;
}

export interface ISpaceHeaderHost {
	activeViewContainerId(): string | undefined;
	openViewContainer(id: string): Promise<void>;
}

export class SpaceHeader extends Disposable {

	/** Height of the name row and the switch; the pinned row adds PINNED_HEIGHT (see meridian.css). */
	static readonly BASE_HEIGHT = 108;
	static readonly PINNED_HEIGHT = 58;

	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	readonly onDidChangeHeight = this._onDidChangeHeight.event;

	readonly element: HTMLElement;
	private readonly nameElement: HTMLElement;
	private readonly tabs = new Map<SpaceTab, { button: HTMLButtonElement; badge?: HTMLElement }>();
	private readonly pinnedElement: HTMLElement;
	private readonly pinnedRow: HTMLElement;
	private readonly renderDisposables = this._register(new DisposableStore());
	private pinnedCount = 0;
	private visible = false;

	constructor(
		container: HTMLElement,
		private readonly host: ISpaceHeaderHost,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILabelService private readonly labelService: ILabelService,
		@IStorageService private readonly storageService: IStorageService,
		@IEditorService private readonly editorService: IEditorService,
		@IViewsService private readonly viewsService: IViewsService,
		@IActivityService private readonly activityService: IActivityService,
		@ICommandService private readonly commandService: ICommandService,
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
	) {
		super();
		this.element = append(container, $('.meridian-space'));

		// Name row: "SPACE" over the workspace name, and a new-file button.
		const nameRow = append(this.element, $('.meridian-space-name-row'));
		const names = append(nameRow, $('.meridian-space-names'));
		append(names, $('span.meridian-space-label', undefined, localize('meridian.space', "Space")));
		this.nameElement = append(names, $('span.meridian-space-name'));
		const newFile = append(nameRow, $('button.meridian-space-new-file')) as HTMLButtonElement;
		newFile.type = 'button';
		newFile.setAttribute('aria-label', localize('meridian.newFile', "New File"));
		newFile.title = localize('meridian.newFile', "New File");
		newFile.appendChild(renderIcon(Codicon.add));
		this._register(addDisposableListener(newFile, EventType.CLICK, () => this.commandService.executeCommand('explorer.newFile')));

		// The switch.
		const segmented = append(this.element, $('.meridian-space-tabs'));
		segmented.setAttribute('role', 'tablist');
		segmented.setAttribute('aria-label', localize('meridian.spaceViews', "Space views"));
		for (const [tab, label] of [['files', localize('meridian.files', "Files")], ['changes', localize('meridian.changes', "Changes")], ['outline', localize('meridian.outline', "Outline")]] as const) {
			const button = append(segmented, $('button.meridian-space-tab')) as HTMLButtonElement;
			button.type = 'button';
			button.setAttribute('role', 'tab');
			append(button, $('span', undefined, label));
			const entry: { button: HTMLButtonElement; badge?: HTMLElement } = { button };
			if (tab === 'changes') {
				entry.badge = append(button, $('span.meridian-space-badge'));
			}
			this.tabs.set(tab, entry);
			this._register(addDisposableListener(button, EventType.CLICK, () => this.select(tab)));
		}

		// Pinned files.
		this.pinnedRow = append(this.element, $('.meridian-space-pinned-row'));
		append(this.pinnedRow, $('span.meridian-space-label', undefined, localize('meridian.pinned', "Pinned")));
		this.pinnedElement = append(this.pinnedRow, $('.meridian-space-pinned'));

		this._register(this.workspaceService.onDidChangeWorkbenchState(() => this.renderName()));
		this._register(this.workspaceService.onDidChangeWorkspaceName(() => this.renderName()));
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => this.renderName()));
		this._register(this.activityService.onDidChangeActivity(id => {
			if (id === SPACE_VIEW_CONTAINERS.changes || (typeof id !== 'string' && id.id === SPACE_VIEW_CONTAINERS.changes)) {
				this.renderBadge();
			}
		}));
		this._register(this.storageService.onDidChangeValue(StorageScope.WORKSPACE, PINNED_KEY, this._store)(() => this.renderPinned()));
		this._register(this.viewsService.onDidChangeViewVisibility(() => this.updateSelection()));
		// The height depends on fonts, wrapping chips and the side bar's width: follow it.
		const observer = new (getWindow(container).ResizeObserver)(() => this.onResize());
		observer.observe(this.element);
		// The view's own actions (new folder, refresh, collapse) sit at the right of the name row,
		// outside this element: keep the name clear of them, however many the view shows.
		const actions = Array.from(container.children).find(child => child.classList.contains('title-actions'));
		if (actions) {
			const reserve = () => {
				const width = Math.ceil(actions.getBoundingClientRect().width);
				names.style.paddingRight = width ? `${width + 14}px` : '';
			};
			const actionsObserver = new (getWindow(container).ResizeObserver)(reserve);
			actionsObserver.observe(actions);
			this._register({ dispose: () => actionsObserver.disconnect() });
			reserve();
		}
		this._register({ dispose: () => observer.disconnect() });
		this.renderName();
		this.renderBadge();
		this.renderPinned();
		if (!this.storageService.getBoolean(SINGLE_VIEW_KEY, StorageScope.PROFILE, false)) {
			this.storageService.store(SINGLE_VIEW_KEY, true, StorageScope.PROFILE, StorageTarget.MACHINE);
			this.showOnly(FILES_VIEW_ID);
		}
	}

	private lastHeight = 0;

	private onResize(): void {
		const height = this.height;
		if (this.visible && height !== this.lastHeight) {
			this.lastHeight = height;
			this._onDidChangeHeight.fire();
		}
	}

	/** The header's natural height (pinned chips can wrap), with a fallback before it is in the DOM. */
	get height(): number {
		const measured = Math.ceil(this.element.getBoundingClientRect().height);
		return measured > 0 ? measured : SpaceHeader.BASE_HEIGHT + (this.pinnedCount ? SpaceHeader.PINNED_HEIGHT : 0);
	}

	/** The header shows above Files and Changes, the views that belong to a Space. */
	isShownFor(viewContainerId: string | undefined): boolean {
		return this.workspaceService.getWorkbenchState() !== WorkbenchState.EMPTY
			&& (viewContainerId === SPACE_VIEW_CONTAINERS.files || viewContainerId === SPACE_VIEW_CONTAINERS.changes);
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		this.element.classList.toggle('hidden', !visible);
		if (visible) {
			this.updateSelection();
		}
	}

	private renderName(): void {
		const workspace = this.workspaceService.getWorkspace();
		this.nameElement.textContent = this.labelService.getWorkspaceLabel(workspace, { verbose: Verbosity.SHORT }) || localize('meridian.noSpace', "No folder");
	}

	private renderBadge(): void {
		const badge = this.tabs.get('changes')?.badge;
		if (!badge) {
			return;
		}
		const activity = this.activityService.getViewContainerActivities(SPACE_VIEW_CONTAINERS.changes).find(a => a.badge instanceof NumberBadge);
		const count = activity?.badge instanceof NumberBadge ? activity.badge.number : 0;
		badge.textContent = count ? String(count) : '';
		badge.classList.toggle('hidden', !count);
		this.tabs.get('changes')!.button.setAttribute('aria-label', count ? localize('meridian.changesCount', "Changes, {0} files", count) : localize('meridian.changes', "Changes"));
	}

	private renderPinned(): void {
		this.renderDisposables.clear();
		clearNode(this.pinnedElement);
		const files = SpacePinnedFiles.read(this.storageService);
		for (const resource of files) {
			const chip = append(this.pinnedElement, $('button.meridian-space-chip')) as HTMLButtonElement;
			chip.type = 'button';
			chip.title = this.labelService.getUriLabel(resource, { relative: true });
			chip.appendChild(renderIcon(Codicon.pinned));
			append(chip, $('span', undefined, basename(resource)));
			this.renderDisposables.add(addDisposableListener(chip, EventType.CLICK, () => this.editorService.openEditor({ resource, options: { pinned: true } })));
			this.renderDisposables.add(addDisposableListener(chip, EventType.AUXCLICK, e => {
				if (e.button === 1) {
					SpacePinnedFiles.toggle(this.storageService, resource, false);
				}
			}));
			this.renderDisposables.add(addDisposableListener(chip, EventType.CONTEXT_MENU, e => {
				e.preventDefault();
				SpacePinnedFiles.toggle(this.storageService, resource, false);
			}));
			chip.setAttribute('aria-label', localize('meridian.pinnedChip', "{0}, pinned. Right-click to unpin.", basename(resource)));
		}
		const count = files.length;
		this.pinnedRow.classList.toggle('hidden', !count);
		if (count !== this.pinnedCount) {
			this.pinnedCount = count;
			this._onDidChangeHeight.fire();
		}
	}

	private currentTab(): SpaceTab {
		const active = this.host.activeViewContainerId();
		if (active === SPACE_VIEW_CONTAINERS.changes) {
			return 'changes';
		}
		const model = this.filesContainerModel();
		return model && model.isVisible(OUTLINE_VIEW_ID) && !model.isVisible(FILES_VIEW_ID) ? 'outline' : 'files';
	}

	private filesContainerModel() {
		const container = this.viewDescriptorService.getViewContainerById(SPACE_VIEW_CONTAINERS.files);
		return container ? this.viewDescriptorService.getViewContainerModel(container) : undefined;
	}

	/**
	 * Files and Outline each fill the side bar on their own, as in the design: the other views of
	 * the Files container (Outline, Timeline, anything else there) are hidden while one shows. A
	 * container with a single visible view drops its pane header, so the Space header is the title.
	 */
	private showOnly(viewId: string): void {
		const model = this.filesContainerModel();
		if (!model) {
			return;
		}
		for (const descriptor of model.allViewDescriptors) {
			const visible = descriptor.id === viewId;
			if (model.isVisible(descriptor.id) !== visible && (visible || descriptor.canToggleVisibility !== false)) {
				model.setVisible(descriptor.id, visible);
			}
		}
	}

	updateSelection(): void {
		if (!this.visible) {
			return;
		}
		const current = this.currentTab();
		for (const [tab, { button }] of this.tabs) {
			button.classList.toggle('checked', tab === current);
			button.setAttribute('aria-selected', String(tab === current));
		}
	}

	private async select(tab: SpaceTab): Promise<void> {
		if (tab === 'changes') {
			await this.host.openViewContainer(SPACE_VIEW_CONTAINERS.changes);
		} else {
			await this.host.openViewContainer(SPACE_VIEW_CONTAINERS.files);
			const viewId = tab === 'outline' ? OUTLINE_VIEW_ID : FILES_VIEW_ID;
			this.showOnly(viewId);
			await this.viewsService.openView(viewId, true);
		}
		this.updateSelection();
		getWindow(this.element).requestAnimationFrame(() => this.updateSelection());
	}
}

registerAction2(class PinToSpaceAction extends Action2 {
	constructor() {
		super({
			id: 'meridian.space.togglePin',
			title: localize2('meridian.togglePin', "Pin to Space / Unpin"),
			category: localize2('meridian.category', "Meridian"),
			f1: true,
			menu: [
				{ id: MenuId.ExplorerContext, group: '6_copypath', order: 100, when: ContextKeyExpr.equals('explorerResourceIsFolder', false) },
				{ id: MenuId.EditorTitleContext, group: '1_close', order: 100 },
			],
		});
	}

	run(accessor: ServicesAccessor, resource?: URI | { groupId?: number; editorIndex?: number }): void {
		const storageService = accessor.get(IStorageService);
		const editorService = accessor.get(IEditorService);
		const groupsService = accessor.get(IEditorGroupsService);
		let target: URI | undefined;
		if (URI.isUri(resource)) {
			target = resource; // Explorer context menu
		} else if (resource && typeof resource.groupId === 'number' && typeof resource.editorIndex === 'number') {
			target = EditorResourceAccessor.getOriginalUri(groupsService.getGroup(resource.groupId)?.getEditorByIndex(resource.editorIndex)); // Tab context menu
		} else {
			target = EditorResourceAccessor.getOriginalUri(editorService.activeEditor);
		}
		if (target) {
			SpacePinnedFiles.toggle(storageService, target);
		}
	}
});
