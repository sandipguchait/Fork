/*---------------------------------------------------------------------------------------------
 *  Meridian. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType, getActiveDocument } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IPickerQuickAccessItem, PickerQuickAccessProvider, Picks } from '../../../../platform/quickinput/browser/pickerQuickAccess.js';
import { Extensions as QuickAccessExtensions, IQuickAccessRegistry } from '../../../../platform/quickinput/common/quickAccess.js';
import { IQuickInput, IQuickInputService, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { hasKey } from '../../../../base/common/types.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { EditorResourceAccessor } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { CommandsQuickAccessProvider } from '../../quickaccess/browser/commandsQuickAccess.js';
import { AnythingQuickAccessProvider, IAnythingQuickPickItem } from '../../search/browser/anythingQuickAccess.js';

// Meridian's omnibar is quick open with tabs. All: files, matching commands, and a row that asks the
// Companion. Files: files only. Commands: the command palette (">"). Ask: the Companion ("ask ").
// ⌘⏎ (Ctrl+Enter) asks the Companion whatever is typed, from any tab.

export const ASK_PREFIX = 'ask ';
const ASK_CONTEXT_KEY = 'inMeridianAskPicker';
const FILES_CONTEXT_KEY = 'inFilesPicker';
const COMMANDS_CONTEXT_KEY = 'inCommandsPicker';
export const ASK_COMPANION_COMMAND = 'forkAi.askCompanion';
const OMNIBAR_ASK_ACTION = 'meridian.omnibar.ask';
const EXTRA_COMMANDS = 3;
const SUGGESTED_COMMANDS = ['workbench.action.terminal.toggleTerminal', 'workbench.action.tasks.runTask', 'workbench.action.files.newUntitledFile'];

export type OmnibarTab = 'all' | 'files' | 'commands' | 'ask';

/** Arguments the Companion's askCompanion command takes. */
export interface IAskCompanionArgs {
	readonly text: string;
	/** Attach the active editor's file. */
	readonly withActiveFile?: boolean;
	/** Search the codebase for the question first. */
	readonly withCodebase?: boolean;
	readonly mode?: 'ask' | 'agent';
}

/** Which tab the files picker is serving: All adds the extras, Files leaves them out. */
let filesTab: 'all' | 'files' = 'all';

/** What is typed in the open quick input, or '' when there is none. */
function typedValue(input: IQuickInput | undefined): string {
	const value = (input as { value?: unknown } | undefined)?.value;
	return typeof value === 'string' ? value : '';
}

/** The command palette's picks, reused for the commands mixed into All. */
class OmnibarCommandPicks extends CommandsQuickAccessProvider {
	async top(filter: string, max: number, token: CancellationToken): Promise<IPickerQuickAccessItem[]> {
		const result = await this._getPicks(filter, new DisposableStore(), token);
		const picks = Array.isArray(result) ? result : (hasKey(result, { picks: true }) ? result.picks : result);
		const items = (Array.isArray(picks) ? picks : (picks as { items: readonly unknown[] }).items) as ReadonlyArray<IPickerQuickAccessItem | IQuickPickSeparator>;
		const commands = items.filter((item): item is IPickerQuickAccessItem => item.type !== 'separator');
		if (!filter) {
			// Nothing typed: a few everyday commands, as in the design, rather than the alphabet's first.
			const suggested = SUGGESTED_COMMANDS.map(id => commands.find(command => command.id === id)).filter((command): command is IPickerQuickAccessItem => Boolean(command));
			return suggested.slice(0, max);
		}
		return commands.slice(0, max);
	}
}

function askItem(label: string, description: string, args: IAskCompanionArgs, commandService: ICommandService): IPickerQuickAccessItem {
	return {
		label: `$(sparkle) ${label}`,
		description,
		ariaLabel: label,
		accept: () => commandService.executeCommand(ASK_COMPANION_COMMAND, args),
	};
}

/** The Ask tab: put a question or a task to the Companion, with or without context. */
export class AskCompanionQuickAccessProvider extends PickerQuickAccessProvider<IPickerQuickAccessItem> {

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super(ASK_PREFIX, { canAcceptInBackground: false, noResultsPick: { label: localize('meridian.askEmpty', "Type a question for the Companion") } });
	}

	protected _getPicks(filter: string): Picks<IPickerQuickAccessItem> {
		const text = filter.trim();
		const file = EditorResourceAccessor.getOriginalUri(this.editorService.activeEditor);
		const fileName = file ? basename(file) : undefined;
		const items: IPickerQuickAccessItem[] = [];
		if (text) {
			items.push(askItem(localize('meridian.askText', "Ask Companion: {0}", text), localize('meridian.ask', "Ask"), { text }, this.commandService));
			if (fileName) {
				items.push(askItem(localize('meridian.askWithFile', "Ask about {0}: {1}", fileName, text), localize('meridian.withFile', "With this file"), { text, withActiveFile: true }, this.commandService));
			}
			items.push(askItem(localize('meridian.askCodebase', "Search the codebase: {0}", text), localize('meridian.withCodebase', "With codebase"), { text, withCodebase: true }, this.commandService));
			items.push(askItem(localize('meridian.agentTask', "Give the agent a task: {0}", text), localize('meridian.agent', "Agent"), { text, mode: 'agent' }, this.commandService));
		} else if (fileName) {
			items.push(askItem(localize('meridian.explainFile', "Explain {0}", fileName), localize('meridian.withFile', "With this file"), { text: localize('meridian.explainPrompt', "Explain what this file does."), withActiveFile: true }, this.commandService));
			items.push(askItem(localize('meridian.testFile', "Write tests for {0}", fileName), localize('meridian.agent', "Agent"), { text: localize('meridian.testPrompt', "Write tests for this file and run them."), withActiveFile: true, mode: 'agent' }, this.commandService));
			items.push(askItem(localize('meridian.reviewFile', "Review {0} for bugs", fileName), localize('meridian.withFile', "With this file"), { text: localize('meridian.reviewPrompt', "Review this file for bugs and risky code."), withActiveFile: true }, this.commandService));
		}
		return items;
	}
}

Registry.as<IQuickAccessRegistry>(QuickAccessExtensions.Quickaccess).registerQuickAccessProvider({
	ctor: AskCompanionQuickAccessProvider,
	prefix: ASK_PREFIX,
	contextKey: ASK_CONTEXT_KEY,
	placeholder: localize('meridian.askPlaceholder', "Ask the Companion, or give the agent a task"),
	helpEntries: [{ description: localize('meridian.askHelp', "Ask Companion"), commandCenterOrder: 15 }],
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: OMNIBAR_ASK_ACTION,
			title: localize2('meridian.omnibarAsk', "Ask Companion"),
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib + 100,
				primary: KeyMod.CtrlCmd | KeyCode.Enter,
				when: ContextKeyExpr.and(ContextKeyExpr.has('inQuickOpen'), ContextKeyExpr.or(ContextKeyExpr.has(FILES_CONTEXT_KEY), ContextKeyExpr.has(COMMANDS_CONTEXT_KEY), ContextKeyExpr.has(ASK_CONTEXT_KEY))),
			},
		});
	}
	run(accessor: ServicesAccessor): Promise<unknown> | void {
		const quickInputService = accessor.get(IQuickInputService);
		const commandService = accessor.get(ICommandService);
		const value = typedValue(quickInputService.currentQuickInput);
		const text = value.replace(/^(>|ask )/, '').trim();
		quickInputService.cancel();
		return commandService.executeCommand(ASK_COMPANION_COMMAND, { text } satisfies IAskCompanionArgs);
	}
});

/**
 * Adds the tab strip and the key hints to quick open while it serves the omnibar's pickers, and
 * supplies the All tab's extra rows.
 */
export class MeridianOmnibar extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.meridian.omnibar';

	private readonly chrome = this._register(new MutableDisposable<DisposableStore>());
	private readonly commandPicks: OmnibarCommandPicks;
	private tabs: Map<OmnibarTab, HTMLButtonElement> | undefined;

	constructor(
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
		@IEditorService private readonly editorService: IEditorService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
	) {
		super();
		this.commandPicks = this._register(instantiationService.createInstance(OmnibarCommandPicks));
		AnythingQuickAccessProvider.extraPicksProvider = {
			get enabled() { return filesTab === 'all'; },
			getExtraPicks: (filter, token) => this.extraPicks(filter, token),
		};
		this._register({ dispose: () => { AnythingQuickAccessProvider.extraPicksProvider = undefined; } });
		this._register(this.quickInputService.onShow(() => this.update()));
		this._register(this.quickInputService.onHide(() => {
			this.chrome.clear();
			this.tabs = undefined;
			filesTab = 'all';
		}));
		const keys = new Set([FILES_CONTEXT_KEY, COMMANDS_CONTEXT_KEY, ASK_CONTEXT_KEY]);
		this._register(this.contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(keys)) {
				this.update();
			}
		}));
	}

	private activeTab(): OmnibarTab | undefined {
		if (this.contextKeyService.getContextKeyValue<boolean>(COMMANDS_CONTEXT_KEY)) {
			return 'commands';
		}
		if (this.contextKeyService.getContextKeyValue<boolean>(ASK_CONTEXT_KEY)) {
			return 'ask';
		}
		if (this.contextKeyService.getContextKeyValue<boolean>(FILES_CONTEXT_KEY)) {
			return filesTab;
		}
		return undefined;
	}

	/** Shows, updates or removes the tabs and hints, depending on which picker quick open shows. */
	private update(): void {
		// Context keys settle after the picker opens.
		queueMicrotask(() => {
			const tab = this.activeTab();
			if (!tab) {
				this.chrome.clear();
				this.tabs = undefined;
				return;
			}
			if (!this.tabs) {
				this.mount();
			}
			for (const [name, button] of this.tabs ?? []) {
				button.classList.toggle('checked', name === tab);
				button.setAttribute('aria-selected', String(name === tab));
			}
		});
	}

	private mount(): void {
		// The quick input does not expose its DOM; the tabs and footer are added next to its header.
		// eslint-disable-next-line no-restricted-syntax
		const widget = getActiveDocument().querySelector<HTMLElement>('.quick-input-widget');
		// eslint-disable-next-line no-restricted-syntax
		const header = widget?.querySelector<HTMLElement>('.quick-input-header');
		if (!widget || !header) {
			return;
		}
		const store = new DisposableStore();
		widget.classList.add('meridian-omnibar');
		store.add({ dispose: () => widget.classList.remove('meridian-omnibar') });

		const strip = $('.meridian-omnibar-tabs');
		strip.setAttribute('role', 'tablist');
		strip.setAttribute('aria-label', localize('meridian.omnibarTabs', "Search in"));
		header.after(strip);
		store.add({ dispose: () => strip.remove() });
		const tabs = new Map<OmnibarTab, HTMLButtonElement>();
		const labels: [OmnibarTab, string][] = [
			['all', localize('meridian.tabAll', "All")],
			['files', localize('meridian.tabFiles', "Files")],
			['commands', localize('meridian.tabCommands', "Commands")],
			['ask', localize('meridian.tabAsk', "Ask")],
		];
		for (const [tab, label] of labels) {
			const button = append(strip, $('button.meridian-omnibar-tab', undefined, label)) as HTMLButtonElement;
			button.type = 'button';
			button.setAttribute('role', 'tab');
			button.tabIndex = -1;
			store.add(addDisposableListener(button, EventType.MOUSE_DOWN, e => e.preventDefault())); // Keep focus in the input.
			store.add(addDisposableListener(button, EventType.CLICK, () => this.switchTo(tab)));
			tabs.set(tab, button);
		}

		const footer = append(widget, $('.meridian-omnibar-footer'));
		store.add({ dispose: () => footer.remove() });
		const hint = (keys: string, text: string) => {
			const item = append(footer, $('span'));
			append(item, $('kbd', undefined, keys));
			append(item, document.createTextNode(text));
		};
		hint('↑↓', localize('meridian.hintNavigate', "Navigate"));
		hint('⏎', localize('meridian.hintOpen', "Open"));
		hint(this.keybindingService.lookupKeybinding(OMNIBAR_ASK_ACTION)?.getLabel() ?? '⌘⏎', localize('meridian.hintAsk', "Ask Companion"));

		this.tabs = tabs;
		this.chrome.value = store;
	}

	/** Each tab is a picker prefix; what was typed carries over. */
	private switchTo(tab: OmnibarTab): void {
		const input = this.quickInputService.currentQuickInput;
		const current = typedValue(input);
		const text = current.replace(/^(>|ask )/, '');
		if (tab === 'all' || tab === 'files') {
			filesTab = tab;
		}
		const prefix = tab === 'commands' ? '>' : tab === 'ask' ? ASK_PREFIX : '';
		this.quickInputService.quickAccess.show(prefix + text, { preserveValue: false });
		this.update();
	}

	/** All's extra rows: the best matching commands, then a row that asks the Companion. */
	private async extraPicks(filter: string, token: CancellationToken): Promise<ReadonlyArray<IAnythingQuickPickItem | IQuickPickSeparator>> {
		const text = filter.trim();
		const out: Array<IAnythingQuickPickItem | IQuickPickSeparator> = [];
		const commands = await this.commandPicks.top(text, text ? EXTRA_COMMANDS : 2, token);
		if (token.isCancellationRequested) {
			return [];
		}
		if (commands.length) {
			out.push({ type: 'separator', label: localize('meridian.sectionCommands', "Commands") });
			out.push(...commands.map((command): IAnythingQuickPickItem => ({ ...command, description: command.description ?? localize('meridian.command', "Command") })));
		}
		const file = EditorResourceAccessor.getOriginalUri(this.editorService.activeEditor);
		out.push({ type: 'separator', label: localize('meridian.sectionAsk', "Ask Companion") });
		out.push((text
			? askItem(localize('meridian.askText', "Ask Companion: {0}", text), localize('meridian.ask', "Ask"), { text }, this.commandService)
			: file
				? askItem(localize('meridian.askAboutFile', "Ask Companion about {0}", basename(file)), localize('meridian.ask', "Ask"), { text: '', withActiveFile: true }, this.commandService)
				: askItem(localize('meridian.askCompanion', "Ask Companion"), localize('meridian.ask', "Ask"), { text: '' }, this.commandService)) as IAnythingQuickPickItem);
		return out;
	}
}
