/*---------------------------------------------------------------------------------------------
 *  Meridian. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/welcome.css';
import { $, addDisposableListener, append, clearNode, Dimension, EventType } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { isMacintosh, isWeb } from '../../../../base/common/platform.js';
import { basename, dirname, joinPath } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILabelService, Verbosity } from '../../../../platform/label/common/label.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWindowOpenable } from '../../../../platform/window/common/window.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IRecentFolder, IRecentWorkspace, isRecentFolder, isRecentWorkspace, IWorkspacesService } from '../../../../platform/workspaces/common/workspaces.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorOpenContext, IEditorSerializer, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { COMPANION_MODEL_NAME, COMPANION_READY, USER_NAME } from './titleBarControls.js';
import { firstName, greetingFor } from '../common/meridianWelcome.js';

// Meridian's Welcome: the startup page. "Good evening, Sandip. Where to?", the ways in (open a
// folder, clone, a new Space), the recent Spaces, and three choices that make Meridian yours:
// a theme, a model for the Companion, and the settings from the editor you used before.

export const WELCOME_TYPE_ID = 'workbench.editors.meridianWelcome';
export const WELCOME_COMMAND = 'meridian.welcome';
export const NEW_SPACE_COMMAND = 'meridian.newSpace';
export const IMPORT_SETTINGS_COMMAND = 'meridian.importSettings';
const MODEL_SKIPPED_KEY = 'meridian.welcome.modelSkipped';
const MAX_RECENT = 4;

export class MeridianWelcomeInput extends EditorInput {

	static readonly RESOURCE = URI.from({ scheme: Schemas.walkThrough, authority: 'meridian_welcome' });

	override get typeId(): string {
		return WELCOME_TYPE_ID;
	}

	override get editorId(): string | undefined {
		return WELCOME_TYPE_ID;
	}

	get resource(): URI {
		return MeridianWelcomeInput.RESOURCE;
	}

	override getName(): string {
		return localize('meridian.welcomeTitle', "Welcome");
	}

	override getIcon(): ThemeIcon {
		return Codicon.globe;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof MeridianWelcomeInput;
	}

	override toUntyped(): IUntypedEditorInput {
		return { resource: MeridianWelcomeInput.RESOURCE, options: { override: WELCOME_TYPE_ID, pinned: false } };
	}
}

export class MeridianWelcomeSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return true;
	}
	serialize(): string {
		return '{}';
	}
	deserialize(): MeridianWelcomeInput {
		return new MeridianWelcomeInput();
	}
}

interface ThemeChoice {
	readonly label: string;
	readonly name: string;
	readonly bg: string;
	readonly bars: readonly string[];
}

const THEMES: readonly ThemeChoice[] = [
	{ label: 'Meridian Nocturne', name: localize('meridian.nocturne', "Nocturne"), bg: '#0D101B', bars: ['#8F82FF', '#5FE3C9', '#FFB86B'] },
	{ label: 'Meridian Ember', name: localize('meridian.ember', "Ember"), bg: '#15100D', bars: ['#FF8F60', '#F4C86A', '#B9DB9E'] },
	{ label: 'Meridian Porcelain', name: localize('meridian.porcelain', "Porcelain"), bg: '#FDFCFA', bars: ['#4A3FD6', '#0B7A68', '#9E4410'] },
];

/** The Meridian mark: a globe with its meridian. */
function brandMark(size: number): SVGSVGElement {
	const ns = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(ns, 'svg');
	svg.setAttribute('width', String(size));
	svg.setAttribute('height', String(size));
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	svg.classList.add('meridian-welcome-mark');
	for (const [tag, attrs] of [
		['circle', { cx: '12', cy: '12', r: '9.5', class: 'accent' }],
		['path', { d: 'M2.5 12h19', class: 'accent2' }],
		['path', { d: 'M12 2.5c3.2 2.6 3.2 16.4 0 19', class: 'accent' }],
	] as const) {
		const node = document.createElementNS(ns, tag);
		for (const [key, value] of Object.entries(attrs)) {
			node.setAttribute(key, value);
		}
		svg.appendChild(node);
	}
	return svg;
}

export class MeridianWelcomePane extends EditorPane {

	static readonly ID = 'meridianWelcomePage';

	private root!: HTMLElement;
	private readonly renderStore = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storage: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IWorkspacesService private readonly workspacesService: IWorkspacesService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@ILabelService private readonly labelService: ILabelService,
		@IHostService private readonly hostService: IHostService,
		@IWorkbenchThemeService private readonly workbenchThemeService: IWorkbenchThemeService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(MeridianWelcomePane.ID, group, telemetryService, themeService, storage);
	}

	protected createEditor(parent: HTMLElement): void {
		this.root = append(parent, $('.meridian-welcome'));
		this.root.tabIndex = 0;
		this._register(this.workspacesService.onDidChangeRecentlyOpened(() => this.render()));
		this._register(this.workbenchThemeService.onDidColorThemeChange(() => this.render()));
		this._register(this.contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(new Set([USER_NAME, COMPANION_MODEL_NAME, COMPANION_READY]))) {
				this.render();
			}
		}));
	}

	override async setInput(input: MeridianWelcomeInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.render();
	}

	override layout(dimension: Dimension): void {
		this.root.style.width = `${dimension.width}px`;
		this.root.style.height = `${dimension.height}px`;
		this.root.classList.toggle('narrow', dimension.width < 940);
		this.root.classList.toggle('compact', dimension.width < 640);
	}

	override focus(): void {
		super.focus();
		this.root.focus();
	}

	private keyFor(commandId: string): string | undefined {
		return this.keybindingService.lookupKeybinding(commandId)?.getLabel() ?? undefined;
	}

	private run(commandId: string, ...args: unknown[]): void {
		this.commandService.executeCommand(commandId, ...args).catch(error => this.notificationService.error(error));
	}

	private button(parent: HTMLElement, className: string, label: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
		const button = append(parent, $(`button.${className}`)) as HTMLButtonElement;
		button.type = 'button';
		if (label) {
			button.textContent = label;
		}
		this.renderStore.add(addDisposableListener(button, EventType.CLICK, onClick));
		return button;
	}

	private async render(): Promise<void> {
		if (!this.root) {
			return;
		}
		this.renderStore.clear();
		const scroll = this.root.scrollTop;
		clearNode(this.root);
		const page = append(this.root, $('.meridian-welcome-page'));
		const left = append(page, $('.meridian-welcome-main'));
		const right = append(page, $('.meridian-welcome-choices'));
		this.renderGreeting(left);
		this.renderActions(left);
		const recent = append(left, $('.meridian-welcome-recent'));
		this.renderChoices(right);
		this.root.scrollTop = scroll;
		await this.renderRecent(recent);
	}

	private renderGreeting(parent: HTMLElement): void {
		const head = append(parent, $('.meridian-welcome-head'));
		const brand = append(head, $('.meridian-welcome-brand'));
		brand.appendChild(brandMark(28));
		append(brand, $('span.meridian-welcome-wordmark', undefined, 'Meridian'));
		const name = firstName(this.contextKeyService.getContextKeyValue<string>(USER_NAME));
		const greeting = greetingFor(new Date().getHours());
		const h1 = append(head, $('h1.meridian-welcome-title'));
		append(h1, $('span', undefined, name ? localize('meridian.greetingName', "{0}, {1}.", greeting, name) : localize('meridian.greeting', "{0}.", greeting)));
		append(h1, $('br'));
		append(h1, $('span.meridian-welcome-where', undefined, localize('meridian.whereTo', "Where to?")));
	}

	private renderActions(parent: HTMLElement): void {
		const actions = append(parent, $('.meridian-welcome-actions'));
		const openFolder = isMacintosh && !isWeb ? 'workbench.action.files.openFileFolder' : 'workbench.action.files.openFolder';
		for (const action of [
			{ icon: Codicon.folderOpened, label: localize('meridian.openFolder', "Open folder"), command: openFolder },
			{ icon: Codicon.repoClone, label: localize('meridian.clone', "Clone repository"), command: 'git.clone' },
			{ icon: Codicon.add, label: localize('meridian.newSpace', "New Space"), command: NEW_SPACE_COMMAND },
		]) {
			const card = this.button(actions, 'meridian-welcome-action', '', () => this.run(action.command));
			card.appendChild(renderIcon(action.icon));
			const row = append(card, $('span.meridian-welcome-action-row'));
			append(row, $('span.meridian-welcome-action-label', undefined, action.label));
			const key = this.keyFor(action.command);
			if (key) {
				append(row, $('span.meridian-welcome-key', undefined, key));
			}
		}
	}

	private async renderRecent(parent: HTMLElement): Promise<void> {
		const recent = (await this.workspacesService.getRecentlyOpened()).workspaces
			.filter(entry => !this.contextService.isCurrentWorkspace(isRecentWorkspace(entry) ? entry.workspace : entry.folderUri))
			.slice(0, MAX_RECENT);
		if (!recent.length || !parent.isConnected) {
			return;
		}
		append(parent, $('span.meridian-welcome-label', undefined, localize('meridian.recentSpaces', "Recent Spaces")));
		for (const entry of recent) {
			this.renderRecentRow(parent, entry);
		}
	}

	private renderRecentRow(parent: HTMLElement, entry: IRecentFolder | IRecentWorkspace): void {
		let openable: IWindowOpenable;
		let uri: URI;
		let name: string;
		if (isRecentFolder(entry)) {
			openable = { folderUri: entry.folderUri };
			uri = entry.folderUri;
			name = entry.label || this.labelService.getWorkspaceLabel(entry.folderUri, { verbose: Verbosity.SHORT });
		} else {
			openable = { workspaceUri: entry.workspace.configPath };
			uri = entry.workspace.configPath;
			name = entry.label || this.labelService.getWorkspaceLabel(entry.workspace, { verbose: Verbosity.SHORT });
		}
		const path = this.labelService.getUriLabel(dirname(uri), { noPrefix: true });
		const row = this.button(parent, 'meridian-welcome-space', '', e => {
			this.hostService.openWindow([openable], { forceNewWindow: e.ctrlKey || e.metaKey, remoteAuthority: entry.remoteAuthority || null });
		});
		row.title = this.labelService.getUriLabel(uri);
		row.setAttribute('aria-label', localize('meridian.openSpace', "Open {0}, {1}", name, path));
		append(row, $('span.meridian-welcome-space-initial', undefined, (name.trim()[0] ?? '?').toUpperCase()));
		const text = append(row, $('span.meridian-welcome-space-text'));
		append(text, $('span.meridian-welcome-space-name', undefined, name));
		append(text, $('span.meridian-welcome-space-path', undefined, path));
		append(row, $('span.meridian-welcome-space-open', undefined, localize('meridian.open', "Open")));
	}

	private renderChoices(parent: HTMLElement): void {
		const head = append(parent, $('.meridian-welcome-choices-head'));
		append(head, $('span.meridian-welcome-label', undefined, localize('meridian.makeItYours', "Make it yours")));
		append(head, $('span.meridian-welcome-choices-title', undefined, localize('meridian.threeChoices', "Three quick choices")));

		// 1. Theme
		const theme = append(parent, $('.meridian-welcome-choice'));
		append(theme, $('span.meridian-welcome-choice-title', undefined, localize('meridian.pickTheme', "1. Pick a theme")));
		const themes = append(theme, $('.meridian-welcome-themes'));
		themes.setAttribute('role', 'radiogroup');
		themes.setAttribute('aria-label', localize('meridian.theme', "Theme"));
		const current = this.workbenchThemeService.getColorTheme().settingsId;
		for (const choice of THEMES) {
			const card = this.button(themes, 'meridian-welcome-theme', '', () => this.setTheme(choice.label));
			card.setAttribute('role', 'radio');
			card.setAttribute('aria-checked', String(current === choice.label));
			card.classList.toggle('checked', current === choice.label);
			const swatch = append(card, $('span.meridian-welcome-swatch'));
			swatch.style.backgroundColor = choice.bg;
			choice.bars.forEach((color, index) => {
				const bar = append(swatch, $('span'));
				bar.style.backgroundColor = color;
				bar.style.width = ['60%', '85%', '45%'][index];
			});
			append(card, $('span.meridian-welcome-theme-name', undefined, choice.name));
		}

		// 2. Model
		const model = append(parent, $('.meridian-welcome-choice'));
		append(model, $('span.meridian-welcome-choice-title', undefined, localize('meridian.connectModel', "2. Connect your model")));
		const modelRow = append(model, $('.meridian-welcome-buttons'));
		const modelName = this.contextKeyService.getContextKeyValue<string>(COMPANION_MODEL_NAME);
		if (modelName) {
			const connected = append(modelRow, $('span.meridian-welcome-connected'));
			connected.appendChild(renderIcon(Codicon.check));
			append(connected, $('span', undefined, modelName));
			this.button(modelRow, 'meridian-welcome-choice-button', localize('meridian.change', "Change"), () => this.run('forkAi.pickChatModel'));
		} else {
			const skipped = this.storage.getBoolean(MODEL_SKIPPED_KEY, StorageScope.APPLICATION, false);
			const own = this.button(modelRow, `meridian-welcome-choice-button${skipped ? '' : '.primary'}`, localize('meridian.ownKey', "Bring my own key"), () => this.run('forkAi.addModel', { kind: 'key' }));
			own.title = localize('meridian.ownKeyTitle', "OpenRouter, Anthropic, OpenAI, Gemini, Groq or any OpenAI-compatible endpoint");
			const local = this.button(modelRow, 'meridian-welcome-choice-button', localize('meridian.localModel', "Local model"), () => this.run('forkAi.addModel', { kind: 'local' }));
			local.title = localize('meridian.localModelTitle', "Ollama or LM Studio on this computer: free, and your code stays here");
			const skip = this.button(modelRow, 'meridian-welcome-choice-button', skipped ? localize('meridian.skipped', "Skipped") : localize('meridian.skip', "Skip for now"), () => {
				this.storage.store(MODEL_SKIPPED_KEY, true, StorageScope.APPLICATION, StorageTarget.USER);
				this.render();
			});
			skip.disabled = skipped;
		}

		// 3. Settings
		const settings = append(parent, $('.meridian-welcome-choice'));
		append(settings, $('span.meridian-welcome-choice-title', undefined, localize('meridian.bringSettings', "3. Bring your settings")));
		const importButton = this.button(settings, 'meridian-welcome-import', '', () => this.run(IMPORT_SETTINGS_COMMAND));
		append(importButton, $('span', undefined, localize('meridian.import', "Import keybindings and extensions from another editor")));
		append(importButton, $('span.meridian-welcome-arrow', undefined, '→')).setAttribute('aria-hidden', 'true');

		this.button(parent, 'meridian-welcome-start', localize('meridian.startCoding', "Start coding"), () => this.startCoding());
	}

	private async setTheme(label: string): Promise<void> {
		const theme = (await this.workbenchThemeService.getColorThemes()).find(candidate => candidate.settingsId === label || candidate.label === label);
		if (theme) {
			await this.workbenchThemeService.setColorTheme(theme, ConfigurationTarget.USER);
		}
	}

	private async startCoding(): Promise<void> {
		const input = this.input;
		if (this.contextService.getWorkbenchState() === WorkbenchState.EMPTY) {
			this.run('workbench.action.files.newUntitledFile');
		} else {
			this.run('workbench.view.explorer');
		}
		if (input) {
			await this.group.closeEditor(input);
		}
	}

	override clearInput(): void {
		this.renderStore.clear();
		super.clearInput();
	}
}

registerAction2(class extends Action2 {
	constructor() {
		super({ id: WELCOME_COMMAND, title: localize2('meridian.welcomeCommand', "Meridian Welcome"), category: Categories.Help, f1: true });
	}
	run(accessor: ServicesAccessor): Promise<unknown> {
		return accessor.get(IEditorService).openEditor(accessor.get(IInstantiationService).createInstance(MeridianWelcomeInput), { pinned: false });
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: NEW_SPACE_COMMAND, title: localize2('meridian.newSpaceCommand', "New Space"), category: localize2('meridian.category', "Meridian"), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const dialogService = accessor.get(IFileDialogService);
		const quickInputService = accessor.get(IQuickInputService);
		const fileService = accessor.get(IFileService);
		const hostService = accessor.get(IHostService);
		const contextService = accessor.get(IWorkspaceContextService);
		const notificationService = accessor.get(INotificationService);
		const parents = await dialogService.showOpenDialog({
			title: localize('meridian.newSpaceWhere', "Where should the new Space go?"),
			openLabel: localize('meridian.newSpaceHere', "Create Here"),
			canSelectFolders: true,
			canSelectFiles: false,
			canSelectMany: false,
			defaultUri: await dialogService.defaultFolderPath(),
		});
		const parent = parents?.[0];
		if (!parent) {
			return;
		}
		const name = await quickInputService.input({
			title: localize('meridian.newSpaceTitle', "New Space"),
			prompt: localize('meridian.newSpacePrompt', "A name for the folder, in {0}", basename(parent) || parent.path),
			placeHolder: localize('meridian.newSpacePlaceholder', "my-project"),
			validateInput: async value => {
				const trimmed = value.trim();
				if (!trimmed) {
					return localize('meridian.newSpaceEmpty', "Give the Space a name.");
				}
				if (/[\\/:*?"<>|]/.test(trimmed) || trimmed === '.' || trimmed === '..') {
					return localize('meridian.newSpaceBadName', "A folder name cannot contain \\ / : * ? \" < > |");
				}
				return (await fileService.exists(joinPath(parent, trimmed))) ? localize('meridian.newSpaceExists', "{0} already exists here.", trimmed) : undefined;
			},
		});
		if (!name?.trim()) {
			return;
		}
		const folderUri = joinPath(parent, name.trim());
		try {
			await fileService.createFolder(folderUri);
		} catch (error) {
			notificationService.error(localize('meridian.newSpaceFailed', "Could not create {0}: {1}", folderUri.fsPath, error instanceof Error ? error.message : String(error)));
			return;
		}
		await hostService.openWindow([{ folderUri }], { forceReuseWindow: contextService.getWorkbenchState() === WorkbenchState.EMPTY });
	}
});
