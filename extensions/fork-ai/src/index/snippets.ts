/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

// Turning index hits into text for the agent (codebase_search) and for chat (Codebase context).

export interface Snippet {
	readonly path: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly text: string;
	readonly via: readonly ('keyword' | 'semantic')[];
}

/** Longest snippet shown; longer chunks are cut and say so. */
export const MAX_SNIPPET_LINES = 80;
export const AGENT_SEARCH_BUDGET = 20_000;
export const CHAT_CONTEXT_BUDGET = 30_000;
export const CHAT_CONTEXT_SNIPPETS = 10;

/** Lines startLine..endLine (1-based, inclusive) of a file's text. */
export function sliceLines(text: string, startLine: number, endLine: number): string {
	return text.split(/\r?\n/).slice(Math.max(0, startLine - 1), endLine).join('\n');
}

function capLines(snippet: Snippet): { text: string; endLine: number; cut: number } {
	const lines = snippet.text.split('\n');
	if (lines.length <= MAX_SNIPPET_LINES) {
		return { text: snippet.text, endLine: snippet.endLine, cut: 0 };
	}
	return { text: lines.slice(0, MAX_SNIPPET_LINES).join('\n'), endLine: snippet.startLine + MAX_SNIPPET_LINES - 1, cut: lines.length - MAX_SNIPPET_LINES };
}

/** The codebase_search result: each snippet with numbered lines, the best first, within a budget. */
export function formatForAgent(query: string, snippets: readonly Snippet[], note: string, budget = AGENT_SEARCH_BUDGET): string {
	if (!snippets.length) {
		return [`No indexed code matches "${query}".`, note, 'Try other words, or use search for exact text.'].filter(Boolean).join(' ');
	}
	const parts: string[] = [];
	let used = 0;
	let shown = 0;
	for (const snippet of snippets) {
		const { text, endLine, cut } = capLines(snippet);
		const numbered = text.split('\n').map((line, i) => `${snippet.startLine + i}\t${line}`).join('\n');
		const block = `## ${snippet.path}:${snippet.startLine}-${endLine}\n${numbered}${cut ? `\n… ${cut} more lines. Use read_file to see them.` : ''}`;
		if (shown && used + block.length > budget) {
			break;
		}
		parts.push(block);
		used += block.length;
		shown++;
	}
	const more = snippets.length > shown ? `${snippets.length - shown} more not shown.` : '';
	const header = [`${shown} snippet${shown === 1 ? '' : 's'} for "${query}", best first.`, note, more].filter(Boolean).join(' ');
	return `${header}\n\n${parts.join('\n\n')}`;
}

const escapeAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** The <codebase> block sent with a chat message. Undefined when nothing was found. */
export function renderCodebaseBlock(query: string, snippets: readonly Snippet[], budget = CHAT_CONTEXT_BUDGET): { text: string; count: number } | undefined {
	const parts: string[] = [];
	let used = 0;
	for (const snippet of snippets.slice(0, CHAT_CONTEXT_SNIPPETS)) {
		const { text, endLine } = capLines(snippet);
		const block = `<snippet path="${escapeAttr(snippet.path)}" lines="${snippet.startLine}-${endLine}">\n${text}\n</snippet>`;
		if (parts.length && used + block.length > budget) {
			break;
		}
		parts.push(block);
		used += block.length;
	}
	if (!parts.length) {
		return undefined;
	}
	return {
		text: `<codebase query="${escapeAttr(query)}" note="the parts of the project that best match the question, found by search; other relevant code may exist">\n${parts.join('\n')}\n</codebase>`,
		count: parts.length,
	};
}

/** "@codebase" anywhere in a message asks for codebase context; the search uses the rest of the text. */
export function takeCodebaseMention(text: string): { mentioned: boolean; query: string } {
	const pattern = /(^|\s)@codebase\b/gi;
	const mentioned = pattern.test(text);
	return { mentioned, query: mentioned ? text.replace(pattern, ' ').replace(/\s+/g, ' ').trim() : text.trim() };
}

/**
 * Some embedding models were trained with task prefixes and work noticeably better with them.
 * Matched on the model name; anything else gets no prefix.
 */
export function embeddingPrefixes(model: string): { document: string; query: string } {
	const name = model.toLowerCase();
	if (name.includes('nomic-embed')) {
		return { document: 'search_document: ', query: 'search_query: ' };
	}
	if (/(^|[^a-z])e5([^a-z]|$)/.test(name)) {
		return { document: 'passage: ', query: 'query: ' };
	}
	if (name.includes('mxbai-embed')) {
		return { document: '', query: 'Represent this sentence for searching relevant passages: ' };
	}
	return { document: '', query: '' };
}

/** What is embedded for a chunk: its path gives the model a strong hint about what the code is for. */
export function documentText(model: string, path: string, text: string): string {
	return `${embeddingPrefixes(model).document}${path}\n${text}`;
}
