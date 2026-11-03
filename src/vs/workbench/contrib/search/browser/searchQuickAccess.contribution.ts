/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from '../../../../nls.js';
import { Extensions as QuickAccessExtensions, IQuickAccessRegistry } from '../../../../platform/quickinput/common/quickAccess.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { defaultQuickAccessContextKeyValue } from '../../../browser/quickaccess.js';
import { AnythingQuickAccessProvider } from './anythingQuickAccess.js';
import { SymbolsQuickAccessProvider } from './symbolsQuickAccess.js';
import './searchActionsSymbol.js';

const quickAccessRegistry = Registry.as<IQuickAccessRegistry>(QuickAccessExtensions.Quickaccess);

quickAccessRegistry.registerQuickAccessProvider({
	ctor: AnythingQuickAccessProvider,
	prefix: AnythingQuickAccessProvider.PREFIX,
	// Meridian's omnibar: files, commands and the Companion from one box. The prefixes still work.
	placeholder: nls.localize('meridianOmnibarPlaceholder', "Search or ask"),
	contextKey: defaultQuickAccessContextKeyValue,
	helpEntries: [{
		description: nls.localize('anythingQuickAccess', "Go to File"),
		commandId: 'workbench.action.quickOpen',
		commandCenterOrder: 10
	}]
});

quickAccessRegistry.registerQuickAccessProvider({
	ctor: SymbolsQuickAccessProvider,
	prefix: SymbolsQuickAccessProvider.PREFIX,
	placeholder: nls.localize('symbolsQuickAccessPlaceholder', "Type the name of a symbol to open."),
	contextKey: 'inWorkspaceSymbolsPicker',
	helpEntries: [{ description: nls.localize('symbolsQuickAccess', "Go to Symbol in Workspace"), commandId: 'workbench.action.showAllSymbols' }]
});
