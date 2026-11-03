/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { createModelClient, parseBaseUrl, testConnection, type ApiFormat, type ConnectionReport, type FetchLike, type ModelConfig } from '../../../fork/model-router/src/index.ts';
import { ModelStore } from './modelStore.ts';
import { API_FORMAT_LABELS, guessApiFormat, PROVIDER_PRESETS, shortModelName, type ProviderPreset } from './presets.ts';

const STEPS = 5;
const LIST_TIMEOUT_MS = 10_000;

export type ModelPurpose = 'chat' | 'embedding';

interface Draft {
	purpose: ModelPurpose;
	preset: ProviderPreset;
	apiFormat: ApiFormat;
	baseUrl: string;
	apiKey: string;
	model: string;
	displayName: string;
}

let purposeTitle = 'Add model';

function title(step: number, text: string): string {
	return `${purposeTitle} (${step}/${STEPS}): ${text}`;
}

/** Which providers to offer: all of them, the ones that need a key, or the local ones. */
export type ProviderKind = 'any' | 'key' | 'local';

async function pickPreset(purpose: ModelPurpose, kind: ProviderKind = 'any'): Promise<ProviderPreset | undefined> {
	const presets = (purpose === 'embedding' ? PROVIDER_PRESETS.filter(preset => preset.embeddingModel !== undefined) : PROVIDER_PRESETS)
		.filter(preset => kind === 'any' || (kind === 'local') === (preset.needsKey === false));
	const picked = await vscode.window.showQuickPick(
		presets.map(preset => ({
			label: preset.label,
			description: preset.baseUrl,
			detail: purpose === 'embedding' && preset.embeddingModel ? `${preset.detail} · e.g. ${preset.embeddingModel}` : preset.detail,
			preset,
		})),
		{
			title: title(1, 'provider'),
			placeHolder: purpose === 'embedding' ? 'Where does the embedding model run? Ollama with nomic-embed-text is free and keeps your code on this computer.' : 'Where does the model run?',
			matchOnDescription: true,
			ignoreFocusOut: true,
		},
	);
	return picked?.preset;
}

async function pickApiFormat(suggested: ApiFormat): Promise<ApiFormat | undefined> {
	const formats = (Object.keys(API_FORMAT_LABELS) as ApiFormat[])
		.filter(format => purposeTitle === 'Add model' || format !== 'anthropic')
		.sort((a, b) => (a === suggested ? -1 : b === suggested ? 1 : 0));
	const picked = await vscode.window.showQuickPick(
		formats.map(format => ({ label: API_FORMAT_LABELS[format].label, detail: API_FORMAT_LABELS[format].detail, format })),
		{ title: title(2, 'API format'), placeHolder: 'Which request format does the endpoint use?', ignoreFocusOut: true },
	);
	return picked?.format;
}

async function askUrl(value: string): Promise<string | undefined> {
	const url = await vscode.window.showInputBox({
		title: title(2, 'endpoint URL'),
		prompt: 'The base URL of the API. HTTPS is required, except for localhost.',
		value,
		ignoreFocusOut: true,
		validateInput: text => {
			try {
				parseBaseUrl(text);
				return undefined;
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		},
	});
	return url?.trim();
}

async function askKey(draft: Draft): Promise<string | undefined> {
	const local = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(draft.baseUrl);
	const where = draft.preset.keyUrl ? ` Get one at ${draft.preset.keyUrl}.` : '';
	return vscode.window.showInputBox({
		title: title(3, 'API key'),
		prompt: local || !draft.preset.needsKey
			? 'Local models usually need no key. Leave empty and press Enter.'
			: `Stored in your system keychain, never in settings files.${where}`,
		password: true,
		value: draft.apiKey,
		ignoreFocusOut: true,
	});
}

/** Lists the provider's models with a typed-in fallback, since not every endpoint offers a list. */
async function pickModelName(draft: Draft): Promise<string | undefined> {
	const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem>();
	quickPick.title = title(4, 'model');
	quickPick.placeholder = 'Loading models from the provider… or type a model name';
	quickPick.ignoreFocusOut = true;
	quickPick.busy = true;
	quickPick.matchOnDescription = true;
	quickPick.value = draft.model;

	let listed: vscode.QuickPickItem[] = [];
	const typedItem = (value: string): vscode.QuickPickItem => ({ label: value, description: 'Use this model name', alwaysShow: true });
	const refresh = () => {
		const value = quickPick.value.trim();
		const exact = listed.some(item => item.label === value);
		quickPick.items = value && !exact ? [typedItem(value), ...listed] : listed;
	};
	quickPick.onDidChangeValue(refresh);

	const timeoutFetch: FetchLike = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
	createModelClient(configOf(draft, 'probe'), { fetch: timeoutFetch }).listModels().then(models => {
		// For embeddings, models that look like embedding models come first.
		const rank = (id: string) => draft.purpose === 'embedding' && !/embed/i.test(id) ? 1 : 0;
		listed = models
			.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id))
			.map(model => ({ label: model.id, description: model.displayName && model.displayName !== model.id ? model.displayName : undefined }));
		quickPick.placeholder = listed.length ? `${listed.length} models available. Pick one or type a model name.` : 'This endpoint lists no models. Type the model name.';
	}, () => {
		quickPick.placeholder = 'Could not load the model list. Type the model name.';
	}).finally(() => {
		quickPick.busy = false;
		refresh();
	});
	refresh();

	return new Promise(resolve => {
		quickPick.onDidAccept(() => {
			const choice = quickPick.selectedItems[0]?.label ?? quickPick.value.trim();
			if (choice) {
				resolve(choice);
				quickPick.hide();
			}
		});
		quickPick.onDidHide(() => {
			resolve(undefined);
			quickPick.dispose();
		});
		quickPick.show();
	});
}

async function askDisplayName(draft: Draft): Promise<string | undefined> {
	const name = await vscode.window.showInputBox({
		title: title(5, 'display name'),
		prompt: draft.purpose === 'embedding' ? 'Shown in Manage Models and the index status.' : 'Shown in the model picker.',
		value: draft.displayName || `${shortModelName(draft.model)} · ${draft.preset.id === 'custom' ? new URL(draft.baseUrl).host : draft.preset.label}`,
		ignoreFocusOut: true,
		validateInput: text => text.trim() ? undefined : 'Enter a name.',
	});
	return name?.trim();
}

function configOf(draft: Draft, id: string): ModelConfig {
	return {
		id,
		displayName: draft.displayName || draft.model,
		apiFormat: draft.apiFormat,
		baseUrl: draft.baseUrl,
		model: draft.model || 'probe',
		...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
	};
}

export function describeReport(report: ConnectionReport): string {
	const ms = report.firstTokenMs;
	const speed = ms !== undefined ? ` First response in ${ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`}.` : '';
	const tools = report.toolCalling === true
		? ' Tool calling works, so it can run the agent.'
		: report.toolCalling === false
			? ' It does not support tool calling, so it will work for chat but not for the agent.'
			: ' Tool calling could not be checked.';
	return `${speed}${tools}`.trim();
}

/** Embeds a short text: proves the endpoint, key and model work, and learns the vector size. */
export async function testEmbedding(config: ModelConfig): Promise<{ dims: number } | { error: string }> {
	return vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Testing ${config.displayName}…`, cancellable: false },
		async () => {
			try {
				const [vector] = await createModelClient(config).embed(['function parseDate(input) { return new Date(input); }'], AbortSignal.timeout(30_000));
				return vector?.length ? { dims: vector.length } : { error: 'The endpoint returned an empty embedding.' };
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) };
			}
		},
	);
}

async function runTest(config: ModelConfig): Promise<ConnectionReport> {
	return vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Testing ${config.displayName}…`, cancellable: false },
		() => testConnection(config),
	);
}

/**
 * The five-step flow behind Fork AI: Add Model. With purpose "embedding" it adds a model for
 * codebase search instead, tested by embedding a line of code, and makes it the embedding model.
 * Returns the new model's id, or undefined if cancelled.
 */
export async function addModel(store: ModelStore, purpose: ModelPurpose = 'chat', kind: ProviderKind = 'any'): Promise<string | undefined> {
	purposeTitle = purpose === 'embedding' ? 'Add embedding model' : 'Add model';
	const preset = await pickPreset(purpose, kind);
	if (!preset) {
		return undefined;
	}
	const draft: Draft = {
		purpose,
		preset,
		apiFormat: preset.apiFormat ?? 'openai',
		baseUrl: preset.baseUrl,
		apiKey: '',
		model: purpose === 'embedding' ? preset.embeddingModel ?? '' : '',
		displayName: '',
	};

	while (true) {
		const url = await askUrl(draft.baseUrl);
		if (url === undefined) {
			return undefined;
		}
		draft.baseUrl = url;
		if (!preset.apiFormat) {
			const format = await pickApiFormat(guessApiFormat(url));
			if (!format) {
				return undefined;
			}
			draft.apiFormat = format;
		}

		const key = await askKey(draft);
		if (key === undefined) {
			return undefined;
		}
		draft.apiKey = key.trim();

		const model = await pickModelName(draft);
		if (!model) {
			return undefined;
		}
		draft.model = model;

		const name = await askDisplayName(draft);
		if (!name) {
			return undefined;
		}
		draft.displayName = name;

		const config = configOf(draft, ModelStore.newId());

		if (purpose === 'embedding') {
			const result = await testEmbedding(config);
			if ('dims' in result) {
				await store.save(config, { embeddingDims: result.dims });
				await store.setEmbedModel(config.id);
				void vscode.window.showInformationMessage(`Added ${config.displayName} (${result.dims} dimensions). Fork is now embedding your code for semantic search.`);
				return config.id;
			}
			const choice = await vscode.window.showErrorMessage(`Could not embed with ${config.displayName}: ${result.error}`, { modal: false }, 'Edit and Retry');
			if (choice !== 'Edit and Retry') {
				return undefined;
			}
			continue;
		}

		const report = await runTest(config);

		if (report.streaming) {
			await store.save(config, { toolCalling: report.toolCalling });
			await store.setChatModel(config.id);
			void vscode.window.showInformationMessage(`Added ${config.displayName}. ${describeReport(report)}`);
			return config.id;
		}

		const choice = await vscode.window.showErrorMessage(
			`Could not use ${config.displayName}: ${report.error?.message ?? 'unknown error'}`,
			{ modal: false },
			'Edit and Retry',
			'Save Anyway',
		);
		if (choice === 'Save Anyway') {
			await store.save(config);
			await store.setChatModel(config.id);
			return config.id;
		}
		if (choice !== 'Edit and Retry') {
			return undefined;
		}
	}
}

/** Re-tests a saved model and reports the result. */
export async function retestModel(store: ModelStore, id: string): Promise<void> {
	const config = await store.resolve(id);
	if (!config) {
		return;
	}
	if (store.get(id)?.embeddingDims) {
		const result = await testEmbedding(config);
		if ('dims' in result) {
			await store.save(config, { embeddingDims: result.dims });
			void vscode.window.showInformationMessage(`${config.displayName} works: it returns ${result.dims}-dimension embeddings.`);
		} else {
			void vscode.window.showErrorMessage(`${config.displayName} failed: ${result.error}`);
		}
		return;
	}
	const report = await runTest(config);
	if (report.streaming) {
		await store.save(config, { toolCalling: report.toolCalling });
		void vscode.window.showInformationMessage(`${config.displayName} works. ${describeReport(report)}`);
	} else {
		void vscode.window.showErrorMessage(`${config.displayName} failed: ${report.error?.message ?? 'unknown error'}`);
	}
}

/** Replaces a saved model's API key. */
export async function changeKey(store: ModelStore, id: string): Promise<void> {
	const config = await store.resolve(id);
	if (!config) {
		return;
	}
	const key = await vscode.window.showInputBox({
		title: `API key for ${config.displayName}`,
		prompt: 'Stored in your system keychain. Leave empty to remove the key.',
		password: true,
		ignoreFocusOut: true,
	});
	if (key === undefined) {
		return;
	}
	const { apiKey: _old, ...rest } = config;
	await store.save(key.trim() ? { ...rest, apiKey: key.trim() } : rest);
	void vscode.window.showInformationMessage(`Updated the key for ${config.displayName}.`);
}
