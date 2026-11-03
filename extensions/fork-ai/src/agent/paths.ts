/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { realpath } from 'node:fs/promises';
import { dirname, relative, sep } from 'node:path';

/**
 * Whether a path really lies inside the root once symlinks are followed: a link inside the
 * project that points at ~/.ssh or another project must not let the agent read or write there.
 * For a file that does not exist yet, its nearest existing folder decides.
 */
export async function isInside(root: string, target: string): Promise<boolean> {
	let realRoot: string;
	try {
		realRoot = await realpath(root);
	} catch {
		return false;
	}
	let current = target;
	let rest = '';
	for (let i = 0; i < 256; i++) {
		try {
			const resolved = await realpath(current);
			const full = rest ? `${resolved}${sep}${rest}` : resolved;
			const path = relative(realRoot, full);
			return path === '' || (!path.startsWith('..') && !path.startsWith(sep) && !/^[a-zA-Z]:/.test(path));
		} catch {
			const parent = dirname(current);
			if (parent === current) {
				return false;
			}
			rest = rest ? `${current.slice(parent.length + 1)}${sep}${rest}` : current.slice(parent.length + 1);
			current = parent;
		}
	}
	return false;
}
