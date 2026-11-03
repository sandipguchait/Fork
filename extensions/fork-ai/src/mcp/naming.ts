/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';

// How MCP tools appear to the model, and how their results come back as text.

/** Providers accept tool names of at most 64 characters from [a-zA-Z0-9_-]. */
const MAX_NAME = 64;
export const MCP_PREFIX = 'mcp__';

const clean = (part: string) => part.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'x';

/** "mcp__github__create_issue". Too long, it is cut and given a short hash so it stays unique. */
export function toolName(server: string, tool: string): string {
	const name = `${MCP_PREFIX}${clean(server)}__${clean(tool)}`;
	if (name.length <= MAX_NAME) {
		return name;
	}
	const hash = createHash('sha1').update(`${server}\u0000${tool}`).digest('hex').slice(0, 6);
	return `${name.slice(0, MAX_NAME - 7)}_${hash}`;
}

export interface McpContent {
	readonly type: string;
	readonly text?: string;
	readonly data?: string;
	readonly mimeType?: string;
	readonly uri?: string;
	readonly name?: string;
	readonly resource?: { readonly uri?: string; readonly text?: string; readonly blob?: string; readonly mimeType?: string };
}

export interface McpToolResult {
	readonly content?: readonly McpContent[];
	readonly structuredContent?: unknown;
	readonly isError?: boolean;
}

/** Most text a single MCP result may hand the model; the rest is cut with a note. */
export const MAX_RESULT_CHARS = 30_000;

/**
 * A tool result as text for the model. Images and binary resources cannot travel in a tool result
 * on every provider, so they become a short note saying what was there.
 */
export function formatToolResult(result: McpToolResult): { content: string; isError: boolean } {
	const parts: string[] = [];
	for (const item of result.content ?? []) {
		switch (item.type) {
			case 'text':
				parts.push(item.text ?? '');
				break;
			case 'image':
			case 'audio':
				parts.push(`[${item.type} (${item.mimeType ?? 'unknown type'}, ${Math.round((item.data?.length ?? 0) * 0.75 / 1024)} KB) not shown: Fork passes text only]`);
				break;
			case 'resource_link':
				parts.push(`[resource ${item.name ? `${item.name}: ` : ''}${item.uri ?? ''}]`);
				break;
			case 'resource':
				if (item.resource?.text !== undefined) {
					parts.push(`[resource ${item.resource.uri ?? ''}]\n${item.resource.text}`);
				} else {
					parts.push(`[binary resource ${item.resource?.uri ?? ''} (${item.resource?.mimeType ?? 'unknown type'}) not shown]`);
				}
				break;
			default:
				parts.push(`[${item.type} content not shown]`);
		}
	}
	if (!parts.length && result.structuredContent !== undefined) {
		parts.push(JSON.stringify(result.structuredContent, null, 2));
	}
	let content = parts.join('\n').trim() || (result.isError ? 'The tool failed without saying why.' : 'The tool returned nothing.');
	if (content.length > MAX_RESULT_CHARS) {
		content = `${content.slice(0, MAX_RESULT_CHARS)}\n… [${content.length - MAX_RESULT_CHARS} more characters cut]`;
	}
	return { content, isError: result.isError === true };
}

/** The tool card's title: "github: create_issue". */
export function describeMcpCall(server: string, tool: string): string {
	return `${server}: ${tool}`;
}

/** Arguments shown in the approval card, kept short. */
export function summarizeArguments(args: Record<string, unknown>, max = 600): string {
	const text = JSON.stringify(args, null, 1).replace(/\n\s*/g, ' ');
	return text.length > max ? `${text.slice(0, max)}…` : text;
}
