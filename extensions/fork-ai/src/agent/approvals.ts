/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

// Which agent commands run without asking. Read-only basics run straight away, commands the user
// allowed with "Always allow" run straight away, and anything destructive always asks.

/** Read-only commands that run without approval, matched as a whole first word or phrase. */
export const DEFAULT_ALLOWED_COMMANDS: readonly string[] = [
	'git status', 'git diff', 'git log', 'git show', 'git branch',
	'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'which', 'tree',
	'node --version', 'npm --version', 'pnpm --version', 'python --version', 'python3 --version',
];

const DANGEROUS: readonly RegExp[] = [
	/\brm\s+-[a-z]*[rf]/i,
	/\bsudo\b/,
	/\bgit\s+push\b[^\n]*(--force\b|\s-f\b|--force-with-lease\b)/,
	/\bgit\s+reset\s+--hard\b/,
	/\bgit\s+clean\s+-[a-z]*f/,
	/\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/,
	/\bmkfs\b/,
	/\bdd\s+if=/,
	/:\(\)\s*\{\s*:\|:&\s*\};:/,
	/\bchmod\s+-R\b/,
	/\bchown\s+-R\b/,
	/\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/,
	/\b(shutdown|reboot|halt)\b/,
	/>\s*\/dev\/(sd|disk)/,
];

/** Shell features that can hide a second command inside an allowed-looking one. */
const CHAINING = /[;&|`<>]|\$\(/;

export function isDangerousCommand(command: string): boolean {
	return DANGEROUS.some(pattern => pattern.test(command));
}

function matchesAllowed(command: string, allowed: string): boolean {
	return command === allowed || command.startsWith(allowed + ' ');
}

export type ApprovalNeed = 'none' | 'ask' | 'warn';

/**
 * 'none': run it. 'ask': show Run / Skip. 'warn': looks destructive; ask, and never offer "Always allow".
 * An exact command the user allowed before runs even with pipes in it, unless it looks destructive.
 */
export function approvalFor(command: string, userAllowed: readonly string[] = []): ApprovalNeed {
	const trimmed = command.trim();
	if (isDangerousCommand(trimmed)) {
		return 'warn';
	}
	if (userAllowed.includes(trimmed)) {
		return 'none';
	}
	if (CHAINING.test(trimmed)) {
		return 'ask';
	}
	const allowed = [...DEFAULT_ALLOWED_COMMANDS, ...userAllowed.filter(entry => !CHAINING.test(entry))];
	return allowed.some(entry => matchesAllowed(trimmed, entry)) ? 'none' : 'ask';
}
