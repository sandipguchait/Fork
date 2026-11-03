/*---------------------------------------------------------------------------------------------
 *  Meridian. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { StartupWelcomeOverride } from '../../welcomeGettingStarted/browser/startupPage.js';
import { importFromOtherEditor } from './importSettings.js';
import { IMPORT_SETTINGS_COMMAND, MeridianWelcomeInput, MeridianWelcomePane, MeridianWelcomeSerializer, WELCOME_TYPE_ID } from './welcome.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorGroupFooters } from '../../../browser/parts/editor/editorGroupFooter.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { TerminalViewHeaders } from '../../terminal/browser/terminalViewHeader.js';
import { ScriptsBar, SCRIPTS_SETTING } from './scriptsBar.js';
import { TIME_SCRUB_SETTING, TimeScrub } from './timeScrub.js';
import { MeridianOmnibar } from './omnibar.js';
import { MeridianTitleBarControls } from './titleBarControls.js';
import { MeridianUnsavedDecorations } from './unsavedDecorations.js';

// Meridian's own parts of the workbench that are not styling: the title bar controls, the omnibar,
// the editor's time scrub and the console's Scripts row.

registerWorkbenchContribution2(MeridianTitleBarControls.ID, MeridianTitleBarControls, WorkbenchPhase.BlockStartup);
registerWorkbenchContribution2(MeridianOmnibar.ID, MeridianOmnibar, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(MeridianUnsavedDecorations.ID, MeridianUnsavedDecorations, WorkbenchPhase.AfterRestored);

// The Welcome: Meridian's startup page, in place of Getting Started.
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(MeridianWelcomePane, MeridianWelcomePane.ID, localize('meridian.welcomePane', "Welcome")),
	[new SyncDescriptor(MeridianWelcomeInput)],
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(WELCOME_TYPE_ID, MeridianWelcomeSerializer);

class MeridianStartupWelcome extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.meridian.startupWelcome';
	constructor(
		@IEditorService editorService: IEditorService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		StartupWelcomeOverride.value = {
			typeId: WELCOME_TYPE_ID,
			open: options => editorService.openEditor(instantiationService.createInstance(MeridianWelcomeInput), options),
		};
		this._register({ dispose: () => StartupWelcomeOverride.value = undefined });
	}
}
registerWorkbenchContribution2(MeridianStartupWelcome.ID, MeridianStartupWelcome, WorkbenchPhase.BlockRestore);

registerAction2(class extends Action2 {
	constructor() {
		super({ id: IMPORT_SETTINGS_COMMAND, title: localize2('meridian.importCommand', "Import Settings from Another Editor"), category: localize2('meridian.category', "Meridian"), f1: true });
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return importFromOtherEditor(accessor);
	}
});

// The editor group's footer: the time scrub. Set at load, before the editor part creates its groups.
EditorGroupFooters.factory = (instantiationService, group) => instantiationService.createInstance(TimeScrub, group);

// The row above the terminal: the workspace's scripts.
TerminalViewHeaders.factory = instantiationService => instantiationService.createInstance(ScriptsBar);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'meridian',
	title: localize('meridian.settings', "Meridian"),
	type: 'object',
	properties: {
		[TIME_SCRUB_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.WINDOW,
			description: localize('meridian.timeScrubSetting', "Show the time scrub under the editor: the file's local history as snapshots you can compare with the file now."),
		},
		[SCRIPTS_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.WINDOW,
			description: localize('meridian.scriptsSetting', "Show the workspace's package.json scripts above the terminal. A click runs one with the package manager the lockfile names."),
		},
	},
});
