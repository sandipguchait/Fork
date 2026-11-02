/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { ModelRouterError, type ChatMessage, type ChatRequest, type ContentPart, type StreamEvent, type ToolCallPart, type ToolDefinition, type ToolResultPart } from '../../../../fork/model-router/src/index.ts';
import { truncateOutput } from './tools.ts';

export const MAX_AGENT_STEPS = 25;

export interface ToolOutcome {
	readonly content: string;
	readonly isError?: boolean;
}

export interface AgentEvents {
	/** Streamed model text; `step` counts model calls from 0. */
	onText(step: number, text: string): void;
	onToolStart(call: ToolCallPart): void;
	onToolEnd(call: ToolCallPart, outcome: ToolOutcome): void;
}

export interface AgentRunOptions {
	readonly client: { stream(request: ChatRequest): AsyncIterable<StreamEvent> };
	readonly system: string;
	/** The conversation so far, ending with the user's new message. */
	readonly messages: readonly ChatMessage[];
	readonly tools: readonly ToolDefinition[];
	readonly execute: (call: ToolCallPart, signal: AbortSignal) => Promise<ToolOutcome>;
	readonly events: AgentEvents;
	readonly signal: AbortSignal;
	readonly maxSteps?: number;
}

export interface AgentRunResult {
	/** Messages this run added: each assistant reply and the tool results that answered it. */
	readonly transcript: ChatMessage[];
	readonly stopReason: 'done' | 'max_steps' | 'aborted';
	readonly steps: number;
}

/**
 * The agent loop: ask the model, run the tools it calls, send back the results, repeat until it
 * answers without calling a tool. Stops on abort or after maxSteps model calls.
 */
export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
	const transcript: ChatMessage[] = [];
	const maxSteps = options.maxSteps ?? MAX_AGENT_STEPS;

	for (let step = 0; step < maxSteps; step++) {
		if (options.signal.aborted) {
			return { transcript, stopReason: 'aborted', steps: step };
		}
		let text = '';
		const calls: ToolCallPart[] = [];
		// Bad argument JSON is reported back to the model as the tool's result; it never goes to providers.
		const argumentErrors = new Map<string, string>();
		try {
			const stream = options.client.stream({
				system: options.system,
				messages: [...options.messages, ...transcript],
				tools: options.tools,
				signal: options.signal,
			});
			for await (const event of stream) {
				if (event.type === 'text') {
					text += event.text;
					options.events.onText(step, event.text);
				} else if (event.type === 'tool_call') {
					calls.push({ type: 'tool_call', id: event.id, name: event.name, arguments: event.arguments, ...(event.providerData ? { providerData: event.providerData } : {}) });
					if (event.argumentsError) {
						argumentErrors.set(event.id, event.argumentsError);
					}
				}
			}
		} catch (error) {
			if (error instanceof ModelRouterError && error.kind === 'aborted') {
				if (text) {
					transcript.push({ role: 'assistant', content: text });
				}
				return { transcript, stopReason: 'aborted', steps: step + 1 };
			}
			throw error;
		}

		const content: ContentPart[] = [...(text ? [{ type: 'text', text } as const] : []), ...calls];
		transcript.push({ role: 'assistant', content: content.length ? content : '' });
		if (!calls.length) {
			return { transcript, stopReason: 'done', steps: step + 1 };
		}

		const results: ToolResultPart[] = [];
		for (const call of calls) {
			if (options.signal.aborted) {
				results.push({ type: 'tool_result', toolCallId: call.id, toolName: call.name, content: 'Cancelled by the user.', isError: true });
				continue;
			}
			options.events.onToolStart(call);
			let outcome: ToolOutcome;
			const argumentsError = argumentErrors.get(call.id);
			if (argumentsError) {
				outcome = { content: argumentsError, isError: true };
			} else {
				try {
					outcome = await options.execute(call, options.signal);
				} catch (error) {
					outcome = { content: `The tool failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
				}
			}
			options.events.onToolEnd(call, outcome);
			results.push({ type: 'tool_result', toolCallId: call.id, toolName: call.name, content: truncateOutput(outcome.content), ...(outcome.isError ? { isError: true } : {}) });
		}
		transcript.push({ role: 'user', content: results });
		if (options.signal.aborted) {
			return { transcript, stopReason: 'aborted', steps: step + 1 };
		}
	}
	return { transcript, stopReason: 'max_steps', steps: maxSteps };
}
