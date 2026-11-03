/*---------------------------------------------------------------------------------------------
 *  Meridian. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { MERIDIAN_WARNING } from '../../../common/theme.js';
import { IDecorationData, IDecorationsProvider, IDecorationsService } from '../../../services/decorations/common/decorations.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';

// The dot after an unsaved file in the Space's file tree, in Meridian's warning color.

class UnsavedDecorationsProvider extends Disposable implements IDecorationsProvider {

	readonly label = localize('meridian.unsaved', "Unsaved");
	private readonly onDidChangeEmitter = this._register(new Emitter<readonly URI[]>());
	readonly onDidChange = this.onDidChangeEmitter.event;

	constructor(private readonly workingCopyService: IWorkingCopyService) {
		super();
		this._register(workingCopyService.onDidChangeDirty(workingCopy => this.onDidChangeEmitter.fire([workingCopy.resource])));
	}

	provideDecorations(uri: URI): IDecorationData | undefined {
		if (!this.workingCopyService.isDirty(uri)) {
			return undefined;
		}
		// Weighted under git's letters, so "M" still shows; the dot shows when there is no letter.
		return { letter: '●', color: MERIDIAN_WARNING, tooltip: localize('meridian.unsavedTooltip', "Unsaved changes"), weight: -1, bubble: false };
	}
}

export class MeridianUnsavedDecorations extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.meridian.unsavedDecorations';

	constructor(
		@IDecorationsService decorationsService: IDecorationsService,
		@IWorkingCopyService workingCopyService: IWorkingCopyService,
	) {
		super();
		const provider = this._register(new UnsavedDecorationsProvider(workingCopyService));
		this._register(decorationsService.registerDecorationsProvider(provider));
	}
}
