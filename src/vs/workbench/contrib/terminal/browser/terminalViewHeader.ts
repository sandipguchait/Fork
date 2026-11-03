/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';

// Meridian: a row above the terminal in the panel (the Scripts chips). The terminal view
// leaves room for it; what goes in it is up to whoever sets the factory.

export interface ITerminalViewHeader extends IDisposable {
	readonly element: HTMLElement;
	/** Pixels the row takes, 0 while it is hidden. */
	readonly height: number;
	readonly onDidChangeHeight: Event<void>;
}

export const TerminalViewHeaders: { factory: ((instantiationService: IInstantiationService) => ITerminalViewHeader) | undefined } = {
	factory: undefined,
};
