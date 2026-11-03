/*---------------------------------------------------------------------------------------------
 *  Meridian. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType, getWindow } from '../../../../base/browser/dom.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { SimpleAccountActivityActionViewItem } from '../../../browser/parts/globalCompositeBar.js';

// The right side of Meridian's title bar: which model the Companion uses (a pill that switches
// it), Share (the current Companion chat as Markdown), and an avatar for the accounts menu. The
// Companion (the fork-ai extension) supplies the model name and the initials as context keys.

export const MERIDIAN_MODEL_COMMAND = 'meridian.titleBar.model';
export const MERIDIAN_SHARE_COMMAND = 'meridian.titleBar.share';
export const MERIDIAN_ACCOUNT_COMMAND = 'meridian.titleBar.account';

/** Context keys the Companion sets. */
export const COMPANION_READY = 'forkAi.ready';
export const COMPANION_MODEL_NAME = 'forkAi.chatModelName';
export const USER_INITIALS = 'meridian.userInitials';
export const USER_NAME = 'meridian.userName';

const companionReady = ContextKeyExpr.has(COMPANION_READY);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: MERIDIAN_MODEL_COMMAND,
			title: localize2('meridian.model', "Companion Model"),
			menu: { id: MenuId.TitleBar, group: 'navigation', order: 10_001, when: companionReady },
		});
	}
	run(accessor: ServicesAccessor): Promise<unknown> {
		return accessor.get(ICommandService).executeCommand('forkAi.pickChatModel');
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: MERIDIAN_SHARE_COMMAND,
			title: localize2('meridian.share', "Share Chat"),
			menu: { id: MenuId.TitleBar, group: 'navigation', order: 10_002, when: companionReady },
		});
	}
	run(accessor: ServicesAccessor): Promise<unknown> {
		return accessor.get(ICommandService).executeCommand('forkAi.shareChat');
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: MERIDIAN_ACCOUNT_COMMAND,
			title: localize2('meridian.account', "Accounts"),
			menu: { id: MenuId.TitleBar, group: 'navigation', order: 10_003 },
		});
	}
	run(): void {
		// The view item opens the accounts menu itself.
	}
});

/** "● qwen2.5-coder ⌄": the Companion's chat model; click to switch. */
class ModelPillViewItem extends BaseActionViewItem {

	private label: HTMLElement | undefined;

	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
	) {
		super(undefined, action, options);
		this._register(this.contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(new Set([COMPANION_MODEL_NAME]))) {
				this.updateModelLabel();
			}
		}));
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('meridian-model-pill');
		container.setAttribute('role', 'button');
		container.tabIndex = 0;
		append(container, $('span.meridian-model-dot'));
		this.label = append(container, $('span.meridian-model-label'));
		append(container, renderIcon(Codicon.chevronDown));
		this.updateModelLabel();
	}

	private updateModelLabel(): void {
		const name = this.contextKeyService.getContextKeyValue<string>(COMPANION_MODEL_NAME);
		if (!this.label || !this.element) {
			return;
		}
		this.label.textContent = name || localize('meridian.addModel', "Add a model");
		this.element.classList.toggle('no-model', !name);
		this.element.setAttribute('aria-label', name ? localize('meridian.modelAria', "Companion model: {0}. Click to switch.", name) : localize('meridian.addModelAria', "Add a model for the Companion"));
	}

	protected override getTooltip(): string {
		return localize('meridian.modelTooltip', "The model the Companion uses. Click to switch or add one.");
	}
}

/** "Share": the current Companion chat as Markdown, on the clipboard. */
class ShareViewItem extends BaseActionViewItem {

	constructor(action: IAction, options: IBaseActionViewItemOptions) {
		super(undefined, action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('meridian-share-button');
		container.setAttribute('role', 'button');
		container.tabIndex = 0;
		container.textContent = localize('meridian.shareLabel', "Share");
		container.setAttribute('aria-label', localize('meridian.shareAria', "Share the current Companion chat as Markdown"));
	}

	protected override getTooltip(): string {
		return localize('meridian.shareTooltip', "Copy the current Companion chat as Markdown");
	}
}

/** VS Code's accounts menu, drawn as a round avatar with the user's initials. */
class AvatarViewItem extends SimpleAccountActivityActionViewItem {

	private initials: HTMLElement | undefined;
	/** Set by the factory: the base class keeps its own context key service private. */
	meridianContextKeys: IContextKeyService | undefined;

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('meridian-avatar');
		this.initials = append(container, $('span.meridian-avatar-initials'));
		this.initials.setAttribute('aria-hidden', 'true');
		const contextKeyService = this.meridianContextKeys;
		if (!contextKeyService) {
			return;
		}
		const update = () => {
			const initials = contextKeyService.getContextKeyValue<string>(USER_INITIALS);
			const name = contextKeyService.getContextKeyValue<string>(USER_NAME);
			if (this.initials) {
				this.initials.textContent = initials || '';
				container.classList.toggle('has-initials', Boolean(initials));
			}
			container.setAttribute('aria-label', name ? localize('meridian.accountAria', "Accounts: {0}", name) : localize('meridian.accounts', "Accounts"));
		};
		update();
		this._register(contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(new Set([USER_INITIALS, USER_NAME]))) {
				update();
			}
		}));
		this._register(addDisposableListener(container, EventType.KEY_DOWN, e => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				container.click();
			}
		}));
		void getWindow(container);
	}
}

export class MeridianTitleBarControls extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.meridian.titleBarControls';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._register(actionViewItemService.register(MenuId.TitleBar, MERIDIAN_MODEL_COMMAND, (action, options) => instantiationService.createInstance(ModelPillViewItem, action, options), undefined));
		this._register(actionViewItemService.register(MenuId.TitleBar, MERIDIAN_SHARE_COMMAND, (action, options) => new ShareViewItem(action, options), undefined));
		this._register(actionViewItemService.register(MenuId.TitleBar, MERIDIAN_ACCOUNT_COMMAND, (_action, options) => {
			const item = instantiationService.createInstance(AvatarViewItem, { position: () => HoverPosition.BELOW }, options);
			item.meridianContextKeys = instantiationService.invokeFunction(accessor => accessor.get(IContextKeyService));
			return item;
		}, undefined));
	}
}
