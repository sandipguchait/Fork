/*---------------------------------------------------------------------------------------------
 *  Meridian. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';
import { ITerminalViewHeader } from '../../terminal/browser/terminalViewHeader.js';
import { LOCKFILES, PackageManager, packageManagerFor, scriptCommand, scriptNames } from '../common/meridianScripts.js';

// "SCRIPTS ▶ build ▶ test ▶ lint": the workspace's package.json scripts as chips above the
// terminal. A chip runs the script in the terminal with the package manager the lockfile names.

export const SCRIPTS_SETTING = 'meridian.terminal.scripts';
const HEIGHT = 38;
const MAX_SCRIPTS = 24;

export class ScriptsBar extends Disposable implements ITerminalViewHeader {

	readonly element: HTMLElement;
	private readonly chips: HTMLElement;
	private readonly onDidChangeHeightEmitter = this._register(new Emitter<void>());
	readonly onDidChangeHeight = this.onDidChangeHeightEmitter.event;
	private readonly chipListeners = this._register(new DisposableStore());
	private readonly reload = this._register(new RunOnceScheduler(() => this.load(), 200));
	private shown = false;
	private folder: URI | undefined;
	private packageManager: PackageManager = 'npm';

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalGroupService private readonly terminalGroupService: ITerminalGroupService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this.element = $('.meridian-scripts-bar');
		this.element.setAttribute('role', 'toolbar');
		this.element.setAttribute('aria-label', localize('meridian.scripts', "Scripts"));
		append(this.element, $('span.meridian-scripts-label', undefined, localize('meridian.scriptsLabel', "Scripts")));
		this.chips = append(this.element, $('.meridian-scripts-chips'));
		this.element.style.display = 'none';

		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => this.reload.schedule()));
		this._register(this.fileService.onDidFilesChange(e => {
			const folder = this.folder;
			if (folder && (e.contains(joinPath(folder, 'package.json')) || LOCKFILES.some(name => e.contains(joinPath(folder, name))))) {
				this.reload.schedule();
			}
		}));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(SCRIPTS_SETTING)) {
				this.reload.schedule();
			}
		}));
		this.load();
	}

	get height(): number {
		return this.shown ? HEIGHT : 0;
	}

	private async load(): Promise<void> {
		const folder = this.folder = this.workspaceService.getWorkspace().folders[0]?.uri;
		let names: string[] = [];
		if (folder && this.configurationService.getValue<boolean>(SCRIPTS_SETTING) !== false) {
			try {
				const content = await this.fileService.readFile(joinPath(folder, 'package.json'));
				names = scriptNames(content.value.toString());
			} catch {
				names = [];
			}
			const present = await Promise.all(LOCKFILES.map(async name => (await this.fileService.exists(joinPath(folder, name))) ? name : undefined));
			this.packageManager = packageManagerFor(present.filter((name): name is string => !!name));
		}
		if (folder !== this.folder) {
			return; // The workspace changed while this was loading.
		}
		this.render(names.slice(0, MAX_SCRIPTS));
	}

	private render(names: string[]): void {
		this.chipListeners.clear();
		clearNode(this.chips);
		for (const name of names) {
			const chip = append(this.chips, $('button.meridian-script-chip')) as HTMLButtonElement;
			chip.type = 'button';
			append(chip, $('span.meridian-script-play')).setAttribute('aria-hidden', 'true');
			append(chip, $('span', undefined, name));
			const command = scriptCommand(this.packageManager, name);
			chip.title = localize('meridian.runScript', "Run {0}", command);
			chip.setAttribute('aria-label', chip.title);
			this.chipListeners.add(addDisposableListener(chip, EventType.CLICK, () => this.run(command)));
		}
		const shown = names.length > 0;
		this.element.style.display = shown ? '' : 'none';
		if (shown !== this.shown) {
			this.shown = shown;
			this.onDidChangeHeightEmitter.fire();
		}
	}

	/** Runs the command in the active terminal, or a new one when that one is busy. */
	private async run(command: string): Promise<void> {
		let instance: ITerminalInstance | undefined = this.terminalService.activeInstance;
		if (!instance || instance.isDisposed || instance.hasChildProcesses || instance.target !== TerminalLocation.Panel) {
			instance = await this.terminalService.createTerminal({ location: TerminalLocation.Panel, cwd: this.folder });
		}
		this.terminalService.setActiveInstance(instance);
		await this.terminalGroupService.showPanel(true);
		await instance.sendText(command, true);
	}
}
