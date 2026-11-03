/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// The agent's commands run in an OS sandbox where one is available: they can read the disk but
// write only inside the project, the temp folder and a few package caches, and optionally reach
// no network. macOS uses sandbox-exec (Seatbelt); Linux uses bubblewrap. Elsewhere commands run
// as before, behind the approval prompts only.

export type SandboxKind = 'seatbelt' | 'bubblewrap' | 'none';

export interface SandboxPolicy {
	/** Real paths (symlinks resolved) that commands may write to, the project first. */
	readonly writable: readonly string[];
	readonly network: boolean;
}

/** Package caches that installs and builds write to, relative to the home folder. */
export const DEFAULT_CACHE_FOLDERS = [
	'.npm', '.cache', '.pnpm-store', 'Library/Caches', 'Library/pnpm', '.yarn/berry/cache', '.bun/install/cache',
	'.cargo/registry', '.cargo/git', 'go/pkg/mod', '.gradle/caches', '.m2/repository',
];

function real(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

/**
 * The folders a sandboxed command may write: the project, the temp folders, and the allowed
 * folders that exist ("~/" expands to the home folder). Duplicates and missing folders drop out.
 */
export function writableFolders(root: string, allowWrite: readonly string[], home = homedir()): string[] {
	const candidates = [
		root,
		tmpdir(),
		'/tmp',
		...(process.env.TMPDIR ? [process.env.TMPDIR] : []),
		...allowWrite.map(path => path.startsWith('~/') ? join(home, path.slice(2)) : path === '~' ? home : path),
	];
	const out: string[] = [];
	for (const candidate of candidates) {
		const resolved = real(candidate);
		if (resolved && !out.includes(resolved)) {
			out.push(resolved);
		}
	}
	return out;
}

const sbplString = (path: string) => `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** A Seatbelt profile: everything allowed except writing outside the writable folders (and the network, when off). */
export function seatbeltProfile(policy: SandboxPolicy): string {
	return [
		'(version 1)',
		'(allow default)',
		'(deny file-write*)',
		'(allow file-write*',
		...policy.writable.map(path => `  (subpath ${sbplString(path)})`),
		'  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty") (literal "/dev/dtracehelper")',
		'  (regex #"^/dev/fd/") (regex #"^/dev/ttys[0-9]+$"))',
		...(policy.network ? [] : ['(deny network-outbound (remote ip "*:*"))']),
	].join('\n');
}

/** bubblewrap arguments: the whole disk read-only, the writable folders bound read-write on top. */
export function bubblewrapArgs(policy: SandboxPolicy, cwd: string): string[] {
	return [
		'--ro-bind', '/', '/',
		'--dev', '/dev',
		'--proc', '/proc',
		...policy.writable.flatMap(path => ['--bind', path, path]),
		...(policy.network ? [] : ['--unshare-net']),
		'--unshare-pid',
		'--die-with-parent',
		'--new-session',
		'--chdir', cwd,
	];
}

/** The program and arguments that run `command` with `shell -c` inside the sandbox. */
export function sandboxedCommand(kind: SandboxKind, policy: SandboxPolicy, shell: string, command: string, cwd: string): { file: string; args: string[] } {
	switch (kind) {
		case 'seatbelt': return { file: '/usr/bin/sandbox-exec', args: ['-p', seatbeltProfile(policy), shell, '-c', command] };
		case 'bubblewrap': return { file: 'bwrap', args: [...bubblewrapArgs(policy, cwd), '--', shell, '-c', command] };
		default: return { file: shell, args: ['-c', command] };
	}
}

let detected: SandboxKind | undefined;

/** Which sandbox this computer has. bubblewrap is tried once, since user namespaces may be off. */
export function detectSandbox(platform = process.platform): SandboxKind {
	if (detected !== undefined && platform === process.platform) {
		return detected;
	}
	let kind: SandboxKind = 'none';
	if (platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
		const probe = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { timeout: 5000 });
		kind = probe.status === 0 ? 'seatbelt' : 'none';
	} else if (platform === 'linux') {
		const probe = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-pid', '--die-with-parent', 'true'], { timeout: 5000 });
		kind = probe.status === 0 ? 'bubblewrap' : 'none';
	}
	if (platform === process.platform) {
		detected = kind;
	}
	return kind;
}

/** Forgets the detection result (tests, and after the user installs bubblewrap). */
export function resetSandboxDetection(): void {
	detected = undefined;
}

export function describeSandbox(kind: SandboxKind, policy: SandboxPolicy | undefined): string {
	if (kind === 'none' || !policy) {
		return 'Commands are not sandboxed on this computer, so be careful with anything that writes outside the project.';
	}
	return `Commands run in a sandbox: they can read files anywhere but write only inside the project, the temp folder and package caches${policy.network ? '' : ', and they have no network access'}. A command that fails with "Operation not permitted" or "Read-only file system" tried to write outside those; tell the user instead of working around it.`;
}
