/*---------------------------------------------------------------------------------------------
 *  Meridian. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { parse } from '../../../../base/common/json.js';

// The Scripts row's rules: which scripts a package.json has and the command line that runs one.

export const LOCKFILES = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'];

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** Which package manager a folder uses, going by its lockfile. */
export function packageManagerFor(lockfiles: readonly string[]): PackageManager {
	if (lockfiles.includes('pnpm-lock.yaml')) {
		return 'pnpm';
	}
	if (lockfiles.includes('yarn.lock')) {
		return 'yarn';
	}
	if (lockfiles.includes('bun.lockb') || lockfiles.includes('bun.lock')) {
		return 'bun';
	}
	return 'npm';
}

/** The command line that runs a script. */
export function scriptCommand(pm: PackageManager, script: string): string {
	// Names with spaces or shell characters are quoted; plain names stay readable.
	const name = /^[\w:.\-/@]+$/.test(script) ? script : `'${script.replace(/'/g, `'\\''`)}'`;
	return `${pm} run ${name}`;
}

/** The script names in a package.json, in file order. */
export function scriptNames(packageJson: string): string[] {
	const json = parse(packageJson);
	const scripts = json && typeof json === 'object' ? json.scripts : undefined;
	if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) {
		return [];
	}
	return Object.keys(scripts).filter(name => typeof scripts[name] === 'string');
}
