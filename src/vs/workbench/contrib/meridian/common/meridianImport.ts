/*---------------------------------------------------------------------------------------------
 *  Meridian. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { OperatingSystem } from '../../../../base/common/platform.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';

// What "Bring your settings" brings over from another editor, and where that editor keeps it.

export interface OtherEditor {
	readonly id: string;
	readonly label: string;
	/** Folder name under the OS's application data folder. */
	readonly appFolder: string;
	/** Folder in the user's home that holds `extensions/`. */
	readonly dataFolder: string;
}

export const OTHER_EDITORS: readonly OtherEditor[] = [
	{ id: 'vscode', label: 'Visual Studio Code', appFolder: 'Code', dataFolder: '.vscode' },
	{ id: 'insiders', label: 'VS Code Insiders', appFolder: 'Code - Insiders', dataFolder: '.vscode-insiders' },
	{ id: 'cursor', label: 'Cursor', appFolder: 'Cursor', dataFolder: '.cursor' },
	{ id: 'windsurf', label: 'Windsurf', appFolder: 'Windsurf', dataFolder: '.windsurf' },
	{ id: 'vscodium', label: 'VSCodium', appFolder: 'VSCodium', dataFolder: '.vscode-oss' },
];

/** Settings that are about how the other editor looked or about the other editor itself. */
const LEFT_OUT_SETTINGS = new Set([
	'workbench.colorTheme', 'workbench.preferredDarkColorTheme', 'workbench.preferredLightColorTheme',
	'workbench.iconTheme', 'workbench.productIconTheme', 'workbench.colorCustomizations',
	'window.titleBarStyle', 'window.zoomLevel', 'workbench.startupEditor', 'workbench.editor.tabActionLocation',
	'editor.fontFamily', 'terminal.integrated.fontFamily',
	'extensions.gallery', 'update.mode', 'telemetry.telemetryLevel',
]);
const LEFT_OUT_PREFIXES = ['cursor.', 'windsurf.', 'codeium.', 'github.copilot', 'chat.'];

/** The other editor's settings that Meridian does not have yet. */
export function settingsToImport(theirs: unknown, isSet: (key: string) => boolean): [string, unknown][] {
	if (!theirs || typeof theirs !== 'object' || Array.isArray(theirs)) {
		return [];
	}
	return Object.entries(theirs as Record<string, unknown>).filter(([key]) =>
		!LEFT_OUT_SETTINGS.has(key) && !LEFT_OUT_PREFIXES.some(prefix => key.startsWith(prefix)) && !isSet(key));
}

export interface Keybinding {
	readonly key?: unknown;
	readonly command?: unknown;
	readonly when?: unknown;
}

/** The other editor's keybindings that Meridian does not have, in their order. */
export function keybindingsToImport(theirs: unknown, ours: unknown): Keybinding[] {
	if (!Array.isArray(theirs)) {
		return [];
	}
	const same = (a: Keybinding, b: Keybinding) => a.key === b.key && a.command === b.command && (a.when ?? '') === (b.when ?? '');
	const existing: Keybinding[] = Array.isArray(ours) ? ours : [];
	return theirs.filter((binding): binding is Keybinding =>
		!!binding && typeof binding === 'object' && typeof binding.key === 'string' && typeof binding.command === 'string'
		&& !existing.some(other => same(other, binding)));
}

/** Extension ids from an extensions/extensions.json, lowercased, without duplicates. */
export function extensionIds(extensionsJson: unknown): string[] {
	if (!Array.isArray(extensionsJson)) {
		return [];
	}
	const ids = new Set<string>();
	for (const entry of extensionsJson) {
		const id = entry?.identifier?.id;
		if (typeof id === 'string' && /^[\w-]+\.[\w.-]+$/.test(id)) {
			ids.add(id.toLowerCase());
		}
	}
	return [...ids];
}

/** Where an editor keeps its User folder on each OS. */
export function userFolder(home: URI, os: OperatingSystem, editor: OtherEditor): URI {
	switch (os) {
		case OperatingSystem.Macintosh: return joinPath(home, 'Library', 'Application Support', editor.appFolder, 'User');
		case OperatingSystem.Windows: return joinPath(home, 'AppData', 'Roaming', editor.appFolder, 'User');
		default: return joinPath(home, '.config', editor.appFolder, 'User');
	}
}
