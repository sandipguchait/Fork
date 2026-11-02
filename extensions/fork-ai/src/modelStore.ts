/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { ModelConfig } from '../../../fork/model-router/src/index.ts';

/** The parts of vscode.Memento and vscode.SecretStorage the stores use, so they run in plain tests. */
export interface KeyValueStore {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): PromiseLike<void>;
}

export interface SecretStore {
	get(key: string): PromiseLike<string | undefined>;
	store(key: string, value: string): PromiseLike<void>;
	delete(key: string): PromiseLike<void>;
}

/** What is kept in settings storage: everything except the key, which lives in the OS keychain. */
export type StoredModel = Omit<ModelConfig, 'apiKey'> & { readonly hasKey: boolean };

const MODELS_KEY = 'forkAi.models';
const CHAT_MODEL_KEY = 'forkAi.chatModel';
const secretKey = (id: string) => `forkAi.apiKey.${id}`;

export class ModelStore {
	private readonly state: KeyValueStore;
	private readonly secrets: SecretStore;
	private readonly listeners = new Set<() => void>();

	constructor(state: KeyValueStore, secrets: SecretStore) {
		this.state = state;
		this.secrets = secrets;
	}

	list(): StoredModel[] {
		return [...(this.state.get<StoredModel[]>(MODELS_KEY) ?? [])];
	}

	get(id: string): StoredModel | undefined {
		return this.list().find(model => model.id === id);
	}

	/** Adds or replaces a model. An empty or missing key removes the stored key. */
	async save(config: ModelConfig): Promise<void> {
		const { apiKey, ...rest } = config;
		if (apiKey) {
			await this.secrets.store(secretKey(config.id), apiKey);
		} else {
			await this.secrets.delete(secretKey(config.id));
		}
		const models = this.list();
		const stored: StoredModel = { ...rest, hasKey: Boolean(apiKey) };
		const index = models.findIndex(model => model.id === config.id);
		if (index === -1) {
			models.push(stored);
		} else {
			models[index] = stored;
		}
		await this.state.update(MODELS_KEY, models);
		if (!this.state.get<string>(CHAT_MODEL_KEY)) {
			await this.state.update(CHAT_MODEL_KEY, config.id);
		}
		this.fire();
	}

	async remove(id: string): Promise<void> {
		await this.secrets.delete(secretKey(id));
		const models = this.list().filter(model => model.id !== id);
		await this.state.update(MODELS_KEY, models);
		if (this.state.get<string>(CHAT_MODEL_KEY) === id) {
			await this.state.update(CHAT_MODEL_KEY, models[0]?.id);
		}
		this.fire();
	}

	/** The full config with its key, ready for createModelClient. */
	async resolve(id: string): Promise<ModelConfig | undefined> {
		const stored = this.get(id);
		if (!stored) {
			return undefined;
		}
		const { hasKey, ...rest } = stored;
		const apiKey = hasKey ? await this.secrets.get(secretKey(id)) : undefined;
		return apiKey ? { ...rest, apiKey } : rest;
	}

	/** The model chat uses: the one picked, else the first one added. */
	chatModelId(): string | undefined {
		const chosen = this.state.get<string>(CHAT_MODEL_KEY);
		const models = this.list();
		return models.some(model => model.id === chosen) ? chosen : models[0]?.id;
	}

	async setChatModel(id: string): Promise<void> {
		if (!this.get(id)) {
			return;
		}
		await this.state.update(CHAT_MODEL_KEY, id);
		this.fire();
	}

	onDidChange(listener: () => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	static newId(): string {
		return `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
	}

	private fire(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}
}
