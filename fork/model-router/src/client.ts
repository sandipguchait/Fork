/*---------------------------------------------------------------------------------------------
 *  Fork model router. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { anthropicAdapter } from './adapters/anthropic.ts';
import { geminiAdapter } from './adapters/gemini.ts';
import { openAiAdapter } from './adapters/openai.ts';
import { ModelRouterError, normalizeError } from './errors.ts';
import { validateConfig } from './http.ts';
import type { Adapter, ApiFormat, ChatRequest, ClientOptions, CompletionResult, FetchLike, ModelClient, ModelConfig, ModelInfo, StopReason, StreamEvent, ToolCallPart, Usage } from './types.ts';

/** Inputs per embeddings request; providers cap batches (Gemini at 100). */
export const EMBED_BATCH = 64;

const ADAPTERS: Record<ApiFormat, Adapter> = {
	openai: openAiAdapter,
	anthropic: anthropicAdapter,
	gemini: geminiAdapter,
};

async function* guarded(events: AsyncGenerator<StreamEvent>, signal: AbortSignal | undefined): AsyncGenerator<StreamEvent> {
	try {
		yield* events;
	} catch (error) {
		throw normalizeError(error, signal);
	}
}

/** One interface for every provider: the rest of the editor only ever sees StreamEvents. */
export function createModelClient(config: ModelConfig, options: ClientOptions = {}): ModelClient {
	validateConfig(config);
	const adapter = ADAPTERS[config.apiFormat];
	const fetchFn: FetchLike = options.fetch ?? ((url, init) => globalThis.fetch(url, init));

	const stream = (request: ChatRequest) => guarded(adapter.stream(config, request, fetchFn), request.signal);

	return {
		config,
		stream,
		async complete(request: ChatRequest): Promise<CompletionResult> {
			let text = '';
			const toolCalls: ToolCallPart[] = [];
			let stopReason: StopReason = 'end';
			let usage: Usage | undefined;
			for await (const event of stream(request)) {
				if (event.type === 'text') {
					text += event.text;
				} else if (event.type === 'tool_call') {
					toolCalls.push({ type: 'tool_call', id: event.id, name: event.name, arguments: event.arguments, ...(event.providerData ? { providerData: event.providerData } : {}) });
				} else {
					stopReason = event.stopReason;
					usage = event.usage;
				}
			}
			return { text, toolCalls, stopReason, usage };
		},
		async embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
			if (!adapter.embed) {
				throw new ModelRouterError('invalid_config', `The ${config.apiFormat} API has no embeddings endpoint. Use an OpenAI-compatible or Gemini embedding model.`);
			}
			const vectors: number[][] = [];
			try {
				for (let start = 0; start < texts.length; start += EMBED_BATCH) {
					vectors.push(...await adapter.embed(config, texts.slice(start, start + EMBED_BATCH), fetchFn, signal));
				}
			} catch (error) {
				throw normalizeError(error, signal);
			}
			return vectors;
		},
		async listModels(): Promise<ModelInfo[]> {
			try {
				return await adapter.listModels(config, fetchFn);
			} catch (error) {
				throw normalizeError(error);
			}
		},
	};
}
