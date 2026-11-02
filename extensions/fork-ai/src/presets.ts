/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { ApiFormat } from '../../../fork/model-router/src/index.ts';

/** Shortcuts for the Add model flow. Every field stays editable; "Custom" covers anything else. */
export interface ProviderPreset {
	readonly id: string;
	readonly label: string;
	readonly detail: string;
	readonly apiFormat: ApiFormat | undefined;
	readonly baseUrl: string;
	readonly needsKey: boolean;
	readonly keyUrl?: string;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
	{ id: 'openrouter', label: 'OpenRouter', detail: 'Hundreds of models from many labs behind one key', apiFormat: 'openai', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true, keyUrl: 'https://openrouter.ai/keys' },
	{ id: 'anthropic', label: 'Anthropic', detail: 'Claude models', apiFormat: 'anthropic', baseUrl: 'https://api.anthropic.com', needsKey: true, keyUrl: 'https://console.anthropic.com/settings/keys' },
	{ id: 'openai', label: 'OpenAI', detail: 'GPT models', apiFormat: 'openai', baseUrl: 'https://api.openai.com/v1', needsKey: true, keyUrl: 'https://platform.openai.com/api-keys' },
	{ id: 'gemini', label: 'Google Gemini', detail: 'Gemini models', apiFormat: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', needsKey: true, keyUrl: 'https://aistudio.google.com/apikey' },
	{ id: 'groq', label: 'Groq', detail: 'Very fast open models', apiFormat: 'openai', baseUrl: 'https://api.groq.com/openai/v1', needsKey: true, keyUrl: 'https://console.groq.com/keys' },
	{ id: 'deepseek', label: 'DeepSeek', detail: 'DeepSeek models', apiFormat: 'openai', baseUrl: 'https://api.deepseek.com/v1', needsKey: true, keyUrl: 'https://platform.deepseek.com/api_keys' },
	{ id: 'mistral', label: 'Mistral', detail: 'Mistral and Codestral models', apiFormat: 'openai', baseUrl: 'https://api.mistral.ai/v1', needsKey: true, keyUrl: 'https://console.mistral.ai/api-keys' },
	{ id: 'ollama', label: 'Ollama (local)', detail: 'Models running on this computer, free and private', apiFormat: 'openai', baseUrl: 'http://localhost:11434/v1', needsKey: false },
	{ id: 'lmstudio', label: 'LM Studio (local)', detail: 'Models running on this computer, free and private', apiFormat: 'openai', baseUrl: 'http://localhost:1234/v1', needsKey: false },
	{ id: 'custom', label: 'Custom endpoint', detail: 'Any OpenAI-compatible, Anthropic or Gemini URL: gateways, Azure, vLLM, your own server', apiFormat: undefined, baseUrl: '', needsKey: true },
];

export const API_FORMAT_LABELS: Readonly<Record<ApiFormat, { label: string; detail: string }>> = {
	openai: { label: 'OpenAI-compatible', detail: 'Most providers and gateways, Ollama, LM Studio, vLLM' },
	anthropic: { label: 'Anthropic', detail: 'The Anthropic Messages API' },
	gemini: { label: 'Google Gemini', detail: 'The Gemini API' },
};

/** Best guess at the format from a pasted URL, used to pre-select the format for custom endpoints. */
export function guessApiFormat(url: string): ApiFormat {
	if (/anthropic/i.test(url)) {
		return 'anthropic';
	}
	if (/generativelanguage\.googleapis\.com|gemini/i.test(url)) {
		return 'gemini';
	}
	return 'openai';
}

/** "anthropic/claude-sonnet-4.5" → "claude-sonnet-4.5", "models/gemini-2.5-pro" → "gemini-2.5-pro". */
export function shortModelName(model: string): string {
	const parts = model.split('/');
	return parts[parts.length - 1] || model;
}
