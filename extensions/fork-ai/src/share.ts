/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { ChatSession, ChatTurn } from './history.ts';

// Share in Meridian's title bar: the current Companion chat as Markdown. What the user and the
// Companion said, the steps the agent took and the files it changed; not the context blocks
// (whole files) or the model's raw tool transcript.

const STEP_MARK: Record<string, string> = {
	done: '✓',
	error: '✗',
	skipped: '–',
	running: '…',
	awaiting: '…',
};

function quoteBlock(text: string): string {
	return text.split('\n').map(line => line ? `> ${line}` : '>').join('\n');
}

function assistantBody(turn: ChatTurn): string {
	const parts: string[] = [];
	if (turn.steps?.length) {
		for (const step of turn.steps) {
			if (step.kind === 'text') {
				if (step.text.trim()) {
					parts.push(step.text.trim());
				}
			} else {
				parts.push(`- ${STEP_MARK[step.status ?? 'done'] ?? '✓'} ${step.text}`);
			}
		}
	} else if (turn.text.trim()) {
		parts.push(turn.text.trim());
	}
	if (turn.changes?.length) {
		const lines = turn.changes.map(change => `- \`${change.path}\`${change.created ? ' (new)' : ''} +${change.added} −${change.removed}`);
		parts.push(`**${turn.undone ? 'Changed, then undone' : 'Changed'}**\n\n${lines.join('\n')}`);
	}
	if (turn.error) {
		parts.push(`*Error: ${turn.error}*`);
	}
	// Tool steps follow each other as one list; everything else is its own paragraph.
	return parts.reduce((text, part, index) => {
		if (!index) {
			return part;
		}
		const joinAsList = part.startsWith('- ') && parts[index - 1].startsWith('- ');
		return text + (joinAsList ? '\n' : '\n\n') + part;
	}, '');
}

/** The chat as Markdown, or undefined when nothing has been said yet. */
export function chatMarkdown(session: ChatSession): string | undefined {
	const turns = session.turns.filter(turn => turn.role === 'user' ? turn.text.trim() : (turn.text.trim() || turn.steps?.length || turn.error));
	if (!turns.length) {
		return undefined;
	}
	const sections = [`# ${session.title || 'Companion chat'}`];
	for (const turn of turns) {
		if (turn.role === 'user') {
			const context = turn.chips?.length ? `\n\n*Context: ${turn.chips.join(', ')}*` : '';
			sections.push(`**You**\n\n${quoteBlock(turn.text.trim())}${context}`);
		} else {
			sections.push(`**Companion**${turn.modelName ? ` · ${turn.modelName}` : ''}\n\n${assistantBody(turn)}`);
		}
	}
	return `${sections.join('\n\n---\n\n')}\n`;
}

/** Up to two initials from a name: "Sandip Guchait" → "SG", "sandip" → "S". */
export function initialsFor(name: string): string {
	const words = name.trim().split(/[\s._-]+/).filter(Boolean);
	if (!words.length) {
		return '';
	}
	const first = words[0][0];
	const last = words.length > 1 ? words[words.length - 1][0] : '';
	return (first + last).toUpperCase();
}
