/*---------------------------------------------------------------------------------------------
 *  Meridian. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { extensionIds, keybindingsToImport, OTHER_EDITORS, settingsToImport, userFolder } from '../../common/meridianImport.js';
import { packageManagerFor, scriptCommand, scriptNames } from '../../common/meridianScripts.js';
import { firstName, greetingFor } from '../../common/meridianWelcome.js';

suite('Meridian - Scripts row', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the lockfile picks the package manager', () => {
		assert.strictEqual(packageManagerFor([]), 'npm');
		assert.strictEqual(packageManagerFor(['pnpm-lock.yaml']), 'pnpm');
		assert.strictEqual(packageManagerFor(['yarn.lock']), 'yarn');
		assert.strictEqual(packageManagerFor(['bun.lock']), 'bun');
		assert.strictEqual(packageManagerFor(['bun.lockb', 'pnpm-lock.yaml']), 'pnpm');
	});

	test('script names come from package.json in order, comments allowed', () => {
		assert.deepStrictEqual(scriptNames('{ "scripts": { "test-node": "mocha", "build": "tsc", "bad": 1 } }'), ['test-node', 'build']);
		assert.deepStrictEqual(scriptNames('{ // a comment\n "name": "x" }'), []);
		assert.deepStrictEqual(scriptNames('{ "scripts": ["a"] }'), []);
		assert.deepStrictEqual(scriptNames('not json'), []);
	});

	test('script names with shell characters are quoted', () => {
		assert.strictEqual(scriptCommand('pnpm', 'test:unit'), 'pnpm run test:unit');
		assert.strictEqual(scriptCommand('npm', 'lint fix'), `npm run 'lint fix'`);
		assert.strictEqual(scriptCommand('npm', `it's; rm -rf ~`), `npm run 'it'\\''s; rm -rf ~'`);
	});
});

suite('Meridian - Bring your settings', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('settings Meridian already has, and appearance settings, stay out', () => {
		const theirs = { 'editor.tabSize': 2, 'workbench.colorTheme': 'Monokai', 'files.autoSave': 'onFocusChange', 'cursor.cpp.enable': true, 'editor.fontFamily': 'Fira Code' };
		assert.deepStrictEqual(settingsToImport(theirs, key => key === 'files.autoSave'), [['editor.tabSize', 2]]);
		assert.deepStrictEqual(settingsToImport([1, 2], () => false), []);
		assert.deepStrictEqual(settingsToImport(undefined, () => false), []);
	});

	test('keybindings Meridian already has are skipped', () => {
		const ours = [{ key: 'cmd+k', command: 'a' }];
		const theirs = [{ key: 'cmd+k', command: 'a' }, { key: 'cmd+k', command: 'a', when: 'editorFocus' }, { key: 'cmd+j', command: 'b' }, { command: 'no key' }, 'junk'];
		assert.deepStrictEqual(keybindingsToImport(theirs, ours), [{ key: 'cmd+k', command: 'a', when: 'editorFocus' }, { key: 'cmd+j', command: 'b' }]);
		assert.deepStrictEqual(keybindingsToImport(theirs.slice(2, 3), undefined), [{ key: 'cmd+j', command: 'b' }]);
	});

	test('extension ids are read from extensions.json, lowercased, once each', () => {
		const json = [{ identifier: { id: 'EsBenp.Prettier-VSCode' } }, { identifier: { id: 'esbenp.prettier-vscode' } }, { identifier: { id: 'not an id' } }, {}, null];
		assert.deepStrictEqual(extensionIds(json), ['esbenp.prettier-vscode']);
		assert.deepStrictEqual(extensionIds({}), []);
	});

	test('each OS keeps the User folder somewhere else', () => {
		const home = URI.file('/home/sandip');
		const code = OTHER_EDITORS.find(editor => editor.id === 'vscode')!;
		assert.strictEqual(userFolder(home, OperatingSystem.Linux, code).path, '/home/sandip/.config/Code/User');
		assert.strictEqual(userFolder(home, OperatingSystem.Macintosh, code).path, '/home/sandip/Library/Application Support/Code/User');
		assert.strictEqual(userFolder(home, OperatingSystem.Windows, code).path, '/home/sandip/AppData/Roaming/Code/User');
	});
});

suite('Meridian - Welcome', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the greeting follows the hour', () => {
		assert.strictEqual(greetingFor(4), 'Good evening');
		assert.strictEqual(greetingFor(9), 'Good morning');
		assert.strictEqual(greetingFor(12), 'Good afternoon');
		assert.strictEqual(greetingFor(20), 'Good evening');
	});

	test('the first name is capitalized', () => {
		assert.strictEqual(firstName('sandip guchait'), 'Sandip');
		assert.strictEqual(firstName('sandip.guchait'), 'Sandip');
		assert.strictEqual(firstName('  '), undefined);
		assert.strictEqual(firstName(undefined), undefined);
	});
});
