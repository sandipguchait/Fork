/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatHistory, MAX_SESSIONS, newSession, titleFor } from '../src/history.ts';
import { ModelStore, type KeyValueStore, type SecretStore } from '../src/modelStore.ts';
import { guessApiFormat, PROVIDER_PRESETS, shortModelName } from '../src/presets.ts';

class MemoryState implements KeyValueStore {
	readonly data = new Map<string, unknown>();
	get<T>(key: string): T | undefined {
		return this.data.get(key) as T | undefined;
	}
	async update(key: string, value: unknown): Promise<void> {
		// Like vscode.Memento: values are stored as JSON.
		if (value === undefined) {
			this.data.delete(key);
		} else {
			this.data.set(key, JSON.parse(JSON.stringify(value)));
		}
	}
}

class MemorySecrets implements SecretStore {
	readonly data = new Map<string, string>();
	async get(key: string) { return this.data.get(key); }
	async store(key: string, value: string) { this.data.set(key, value); }
	async delete(key: string) { this.data.delete(key); }
}

const model = { id: 'a', displayName: 'A', apiFormat: 'openai' as const, baseUrl: 'https://example.com/v1', model: 'x' };

test('keeps API keys out of settings storage', async () => {
	const state = new MemoryState();
	const secrets = new MemorySecrets();
	const store = new ModelStore(state, secrets);
	await store.save({ ...model, apiKey: 'sk-secret' });

	assert.doesNotMatch(JSON.stringify([...state.data.values()]), /sk-secret/);
	assert.equal(secrets.data.get('forkAi.apiKey.a'), 'sk-secret');
	assert.deepEqual(store.list(), [{ ...model, hasKey: true }]);
	assert.deepEqual(await store.resolve('a'), { ...model, apiKey: 'sk-secret' });
});

test('picks the first model for chat and moves on when it is removed', async () => {
	const store = new ModelStore(new MemoryState(), new MemorySecrets());
	let changes = 0;
	store.onDidChange(() => changes++);
	assert.equal(store.chatModelId(), undefined);
	await store.save(model);
	await store.save({ ...model, id: 'b', displayName: 'B' });
	assert.equal(store.chatModelId(), 'a');
	await store.setChatModel('b');
	assert.equal(store.chatModelId(), 'b');
	await store.setChatModel('missing');
	assert.equal(store.chatModelId(), 'b');
	await store.remove('b');
	assert.equal(store.chatModelId(), 'a');
	assert.ok(changes >= 4);
});

test('inline edits follow the chat model unless given their own', async () => {
	const store = new ModelStore(new MemoryState(), new MemorySecrets());
	await store.save(model);
	await store.save({ ...model, id: 'fast', displayName: 'Fast' });
	assert.equal(store.editModelId(), 'a');
	assert.equal(store.hasOwnEditModel(), false);
	await store.setEditModel('fast');
	assert.equal(store.editModelId(), 'fast');
	await store.setChatModel('a');
	assert.equal(store.editModelId(), 'fast');
	await store.remove('fast');
	assert.equal(store.editModelId(), 'a');
	assert.equal(store.hasOwnEditModel(), false);
});

test('saving without a key removes the old key', async () => {
	const secrets = new MemorySecrets();
	const store = new ModelStore(new MemoryState(), secrets);
	await store.save({ ...model, apiKey: 'k' });
	await store.save(model);
	assert.equal(secrets.data.size, 0);
	assert.deepEqual(await store.resolve('a'), model);
	assert.equal(store.list().length, 1);
});

test('history keeps the newest chats first, skips empty ones and caps the count', async () => {
	const history = new ChatHistory(new MemoryState());
	await history.save(newSession(1));
	assert.equal(history.list().length, 0);

	for (let i = 0; i < MAX_SESSIONS + 5; i++) {
		const session = newSession(i);
		session.updatedAt = i;
		session.turns.push({ id: `t${i}`, role: 'user', text: `q${i}` });
		await history.save(session);
	}
	const list = history.list();
	assert.equal(list.length, MAX_SESSIONS);
	assert.equal(list[0].turns[0].text, `q${MAX_SESSIONS + 4}`);
	assert.equal(history.current()?.id, list[0].id);
});

test('titles, model names and format guesses', () => {
	assert.equal(titleFor('  How does this work?\nmore'), 'How does this work?');
	assert.equal(titleFor('x'.repeat(80)).length, 58);
	assert.equal(shortModelName('anthropic/claude-sonnet-4.5'), 'claude-sonnet-4.5');
	assert.equal(guessApiFormat('https://api.anthropic.com'), 'anthropic');
	assert.equal(guessApiFormat('https://generativelanguage.googleapis.com'), 'gemini');
	assert.equal(guessApiFormat('https://my-gateway.example.com/v1'), 'openai');
	assert.ok(PROVIDER_PRESETS.every(preset => preset.id === 'custom' || preset.baseUrl.startsWith('https://') || preset.baseUrl.startsWith('http://localhost')));
});
