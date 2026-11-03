/*---------------------------------------------------------------------------------------------
 *  Meridian. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { parse } from '../../../../base/common/json.js';
import { OS } from '../../../../base/common/platform.js';
import { joinPath } from '../../../../base/common/resources.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IPathService } from '../../../../platform/path/common/pathService.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IJSONEditingService } from '../../../services/configuration/common/jsonEditing.js';
import { IWorkbenchExtensionManagementService } from '../../../services/extensionManagement/common/extensionManagement.js';
import { IUserDataProfileService } from '../../../services/userDataProfile/common/userDataProfile.js';
import { extensionIds, Keybinding, keybindingsToImport, OTHER_EDITORS, OtherEditor, settingsToImport, userFolder } from '../common/meridianImport.js';

// "Bring your settings" on the welcome page: settings, keybindings and extensions from VS Code,
// Cursor, Windsurf or VSCodium on this computer. Nothing is overwritten: settings already set in
// Meridian stay, keybindings are added after Meridian's own, installed extensions are skipped.

interface Found {
	readonly editor: OtherEditor;
	readonly settings: [string, unknown][];
	readonly keybindings: Keybinding[];
	readonly extensions: string[];
}

async function readJson(fileService: IFileService, resource: URI): Promise<unknown> {
	try {
		return parse((await fileService.readFile(resource)).value.toString());
	} catch {
		return undefined;
	}
}

export async function importFromOtherEditor(accessor: ServicesAccessor): Promise<void> {
	const fileService = accessor.get(IFileService);
	const pathService = accessor.get(IPathService);
	const quickInputService = accessor.get(IQuickInputService);
	const notificationService = accessor.get(INotificationService);
	const configurationService = accessor.get(IConfigurationService);
	const jsonEditingService = accessor.get(IJSONEditingService);
	const profileService = accessor.get(IUserDataProfileService);
	const extensionManagementService = accessor.get(IWorkbenchExtensionManagementService);
	const commandService = accessor.get(ICommandService);
	const progressService = accessor.get(IProgressService);
	const productService = accessor.get(IProductService);

	const home = await pathService.userHome({ preferLocal: true });
	if (home.scheme !== Schemas.file) {
		notificationService.info(localize('meridian.import.desktopOnly', "Importing from another editor works in the Meridian desktop app, where it can read that editor's files."));
		return;
	}
	// The other editor's files are on this computer, so this computer's OS says where they are.
	const os = OS;
	const ours = profileService.currentProfile;
	const ourKeybindings = await readJson(fileService, ours.keybindingsResource);
	const installed = new Set((await extensionManagementService.getInstalled()).map(extension => extension.identifier.id.toLowerCase()));

	const found: Found[] = [];
	for (const editor of OTHER_EDITORS) {
		if (editor.dataFolder === productService.dataFolderName) {
			continue;
		}
		const user = userFolder(home, os, editor);
		const [settings, keybindings, extensions] = await Promise.all([
			readJson(fileService, joinPath(user, 'settings.json')),
			readJson(fileService, joinPath(user, 'keybindings.json')),
			readJson(fileService, joinPath(home, editor.dataFolder, 'extensions', 'extensions.json')),
		]);
		if (settings === undefined && keybindings === undefined && extensions === undefined) {
			continue;
		}
		found.push({
			editor,
			settings: settingsToImport(settings, key => configurationService.inspect(key).userValue !== undefined),
			keybindings: keybindingsToImport(keybindings, ourKeybindings),
			extensions: extensionIds(extensions).filter(id => !installed.has(id)),
		});
	}

	if (!found.length) {
		notificationService.info(localize('meridian.import.none', "No other editor found on this computer. Meridian looks for VS Code, Cursor, Windsurf and VSCodium."));
		return;
	}

	const count = (n: number, one: string, many: string) => n === 1 ? one : many.replace('{0}', String(n));
	type EditorItem = IQuickPickItem & { found: Found };
	const source = found.length === 1 ? found[0] : (await quickInputService.pick<EditorItem>(found.map(entry => ({
		label: entry.editor.label,
		detail: [
			count(entry.settings.length, localize('meridian.import.oneSetting', "1 setting"), localize('meridian.import.settings', "{0} settings")),
			count(entry.keybindings.length, localize('meridian.import.oneKeybinding', "1 keybinding"), localize('meridian.import.keybindings', "{0} keybindings")),
			count(entry.extensions.length, localize('meridian.import.oneExtension', "1 extension"), localize('meridian.import.extensions', "{0} extensions")),
		].join(' · '),
		found: entry,
	})), { title: localize('meridian.import.title', "Bring your settings"), placeHolder: localize('meridian.import.pickEditor', "Import from which editor?") }))?.found;
	if (!source) {
		return;
	}

	type PartItem = IQuickPickItem & { part: 'settings' | 'keybindings' | 'extensions' };
	const parts: PartItem[] = [];
	if (source.settings.length) {
		parts.push({ part: 'settings', label: localize('meridian.import.settingsLabel', "Settings"), description: count(source.settings.length, localize('meridian.import.oneNew', "1 not set in Meridian"), localize('meridian.import.manyNew', "{0} not set in Meridian")), picked: true });
	}
	if (source.keybindings.length) {
		parts.push({ part: 'keybindings', label: localize('meridian.import.keybindingsLabel', "Keybindings"), description: count(source.keybindings.length, localize('meridian.import.oneKb', "1 custom keybinding"), localize('meridian.import.manyKb', "{0} custom keybindings")), picked: true });
	}
	if (source.extensions.length) {
		parts.push({ part: 'extensions', label: localize('meridian.import.extensionsLabel', "Extensions"), description: count(source.extensions.length, localize('meridian.import.oneExt', "1 not installed here"), localize('meridian.import.manyExt', "{0} not installed here")), picked: true });
	}
	if (!parts.length) {
		notificationService.info(localize('meridian.import.upToDate', "Meridian already has everything from {0}.", source.editor.label));
		return;
	}
	const chosen = await quickInputService.pick(parts, {
		canPickMany: true,
		title: localize('meridian.import.fromTitle', "Bring your settings from {0}", source.editor.label),
		placeHolder: localize('meridian.import.pickParts', "What to bring over. Nothing in Meridian is overwritten."),
	});
	if (!chosen?.length) {
		return;
	}
	const picked = new Set(chosen.map(item => item.part));

	const failed: string[] = [];
	let extensionsInstalled = 0;
	await progressService.withProgress({ location: ProgressLocation.Notification, title: localize('meridian.import.progress', "Bringing your settings from {0}", source.editor.label) }, async progress => {
		if (picked.has('settings')) {
			progress.report({ message: localize('meridian.import.writingSettings', "Settings") });
			await jsonEditingService.write(ours.settingsResource, source.settings.map(([key, value]) => ({ path: [key], value })), true);
		}
		if (picked.has('keybindings')) {
			progress.report({ message: localize('meridian.import.writingKeybindings', "Keybindings") });
			if (!Array.isArray(ourKeybindings)) {
				await fileService.writeFile(ours.keybindingsResource, VSBuffer.fromString('[]'));
			}
			await jsonEditingService.write(ours.keybindingsResource, source.keybindings.map(binding => ({ path: [-1], value: binding })), true);
		}
		if (picked.has('extensions')) {
			const total = source.extensions.length;
			for (const [index, id] of source.extensions.entries()) {
				progress.report({ message: localize('meridian.import.installing', "Installing {0} ({1} of {2})", id, index + 1, total), increment: 100 / total });
				try {
					await commandService.executeCommand('workbench.extensions.installExtension', id, { donotSync: false });
					extensionsInstalled++;
				} catch {
					failed.push(id);
				}
			}
		}
	});

	const done: string[] = [];
	if (picked.has('settings')) {
		done.push(count(source.settings.length, localize('meridian.import.doneOneSetting', "1 setting"), localize('meridian.import.doneSettings', "{0} settings")));
	}
	if (picked.has('keybindings')) {
		done.push(count(source.keybindings.length, localize('meridian.import.doneOneKb', "1 keybinding"), localize('meridian.import.doneKbs', "{0} keybindings")));
	}
	if (picked.has('extensions')) {
		done.push(count(extensionsInstalled, localize('meridian.import.doneOneExt', "1 extension"), localize('meridian.import.doneExts', "{0} extensions")));
	}
	notificationService.notify({
		severity: failed.length ? Severity.Warning : Severity.Info,
		message: failed.length
			? localize('meridian.import.doneWithFailures', "Brought over {0} from {1}. These extensions could not be installed from Meridian's marketplace: {2}", done.join(', '), source.editor.label, failed.join(', '))
			: localize('meridian.import.done', "Brought over {0} from {1}.", done.join(', '), source.editor.label),
	});
}
