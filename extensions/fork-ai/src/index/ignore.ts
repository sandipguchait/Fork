/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

// .gitignore-style rules for the index: comments, negation, directory-only and anchored patterns,
// *, ** and ?. Patterns from a nested ignore file apply below its folder.

interface Rule {
	readonly regex: RegExp;
	readonly negate: boolean;
	readonly directoryOnly: boolean;
}

/** Folders and files the index always skips, whatever the ignore files say. */
export const ALWAYS_IGNORED = [
	'.git/', 'node_modules/', '.hg/', '.svn/', 'dist/', 'out/', 'build/', '.next/', '.nuxt/', 'coverage/', '.venv/', 'venv/',
	'__pycache__/', 'target/', '.gradle/', '.idea/', '.DS_Store', '*.min.js', '*.map', '*.lock', 'package-lock.json',
	'pnpm-lock.yaml', '*.png', '*.jpg', '*.jpeg', '*.gif', '*.ico', '*.pdf', '*.zip', '*.gz', '*.woff', '*.woff2', '*.ttf',
	'*.mp3', '*.mp4', '*.wasm', '*.exe', '*.dll', '*.so', '*.dylib', '*.class', '*.jar', '*.pyc', '*.svg', '*.icns',
];

function globToRegex(glob: string): string {
	let out = '';
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === '*') {
			if (glob[i + 1] === '*') {
				i++;
				if (glob[i + 1] === '/') {
					i++;
					out += '(?:.*/)?';
				} else {
					out += '.*';
				}
			} else {
				out += '[^/]*';
			}
		} else if (c === '?') {
			out += '[^/]';
		} else if (c === '[') {
			const close = glob.indexOf(']', i);
			if (close === -1) {
				out += '\\[';
			} else {
				out += glob.slice(i, close + 1).replace(/^\[!/, '[^');
				i = close;
			}
		} else if (c === '\\' && i + 1 < glob.length) {
			out += '\\' + glob[++i];
		} else {
			out += /[.+^${}()|]/.test(c) ? '\\' + c : c;
		}
	}
	return out;
}

/** One rule from one line, or undefined for blanks and comments. `base` is the ignore file's folder ("" at the root). */
export function parseRule(line: string, base = ''): Rule | undefined {
	let pattern = line.replace(/\r$/, '');
	if (!pattern.trim() || pattern.startsWith('#')) {
		return undefined;
	}
	pattern = pattern.replace(/(?<!\\)\s+$/, '');
	let negate = false;
	if (pattern.startsWith('!')) {
		negate = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith('\\!') || pattern.startsWith('\\#')) {
		pattern = pattern.slice(1);
	}
	const directoryOnly = pattern.endsWith('/');
	if (directoryOnly) {
		pattern = pattern.slice(0, -1);
	}
	// A slash anywhere but the end anchors the pattern to the ignore file's folder.
	const anchored = pattern.includes('/');
	if (pattern.startsWith('/')) {
		pattern = pattern.slice(1);
	}
	const prefix = base ? globToRegex(base.replace(/\/?$/, '/')) : '';
	const body = globToRegex(pattern);
	const regex = new RegExp(`^${prefix}${anchored ? '' : '(?:.*/)?'}${body}(?:/.*)?$`);
	return { regex, negate, directoryOnly };
}

export class IgnoreRules {
	private readonly rules: Rule[] = [];

	constructor(lines: readonly string[] = ALWAYS_IGNORED) {
		this.add(lines);
	}

	add(lines: readonly string[], base = ''): void {
		for (const line of lines) {
			const rule = parseRule(line, base);
			if (rule) {
				this.rules.push(rule);
			}
		}
	}

	/** `path` is workspace-relative with forward slashes; folders end with "/". The last matching rule wins. */
	ignores(path: string): boolean {
		const isDirectory = path.endsWith('/');
		const clean = isDirectory ? path.slice(0, -1) : path;
		let ignored = false;
		for (const rule of this.rules) {
			if (!rule.regex.test(clean)) {
				continue;
			}
			// A directory-only rule matches a folder, or a file only through one of its parent folders.
			if (rule.directoryOnly && !isDirectory) {
				const parts = clean.split('/');
				const matchesParent = parts.slice(0, -1).some((_, index) => rule.regex.test(parts.slice(0, index + 1).join('/')));
				if (!matchesParent) {
					continue;
				}
			}
			ignored = !rule.negate;
		}
		return ignored;
	}
}
