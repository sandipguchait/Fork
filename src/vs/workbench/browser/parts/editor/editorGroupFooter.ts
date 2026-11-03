/*---------------------------------------------------------------------------------------------
 *  Meridian. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorGroupView } from './editor.js';

/**
 * A row under an editor group's editor, inside its card: Meridian's time scrub lives here. The
 * group gives it `height` pixels below the editor; 0 hides it.
 */
export interface IEditorGroupFooter extends IDisposable {
	readonly element: HTMLElement;
	readonly height: number;
	readonly onDidChangeHeight: Event<void>;
}

export type EditorGroupFooterFactory = (instantiationService: IInstantiationService, group: IEditorGroupView) => IEditorGroupFooter;

/** Set by a workbench contribution before the editor part is created. */
export const EditorGroupFooters: { factory: EditorGroupFooterFactory | undefined } = { factory: undefined };
