/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { KeyValueStore } from './modelStore.ts';

export interface ChatTurn {
	readonly id: string;
	readonly role: 'user' | 'assistant';
	text: string;
	/** For user turns: the context block sent with this message, so later turns can replay it. */
	readonly context?: string;
	/** For user turns: short labels of the context that was attached, shown as chips. */
	readonly chips?: readonly string[];
	error?: string;
	readonly modelName?: string;
}

export interface ChatSession {
	readonly id: string;
	title: string;
	readonly createdAt: number;
	updatedAt: number;
	turns: ChatTurn[];
}

const SESSIONS_KEY = 'forkAi.chats';
const CURRENT_KEY = 'forkAi.currentChat';
export const MAX_SESSIONS = 50;

let counter = 0;
export function newId(prefix: string): string {
	counter = (counter + 1) % 1_000_000;
	return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export function titleFor(text: string): string {
	const line = text.trim().split('\n')[0].trim();
	return line.length > 60 ? line.slice(0, 57).trimEnd() + '…' : line || 'New chat';
}

export function newSession(now = Date.now()): ChatSession {
	return { id: newId('chat'), title: 'New chat', createdAt: now, updatedAt: now, turns: [] };
}

/** Chats are kept per workspace, newest first, capped at MAX_SESSIONS. */
export class ChatHistory {
	private readonly state: KeyValueStore;

	constructor(state: KeyValueStore) {
		this.state = state;
	}

	list(): ChatSession[] {
		return [...(this.state.get<ChatSession[]>(SESSIONS_KEY) ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
	}

	get(id: string): ChatSession | undefined {
		return this.list().find(session => session.id === id);
	}

	/** Saves a chat that has at least one message; empty chats are never stored. */
	async save(session: ChatSession): Promise<void> {
		if (!session.turns.length) {
			return;
		}
		const sessions = [session, ...this.list().filter(existing => existing.id !== session.id)]
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, MAX_SESSIONS);
		await this.state.update(SESSIONS_KEY, sessions);
		await this.state.update(CURRENT_KEY, session.id);
	}

	async remove(id: string): Promise<void> {
		await this.state.update(SESSIONS_KEY, this.list().filter(session => session.id !== id));
	}

	current(): ChatSession | undefined {
		const id = this.state.get<string>(CURRENT_KEY);
		return id ? this.get(id) : undefined;
	}

	async setCurrent(id: string | undefined): Promise<void> {
		await this.state.update(CURRENT_KEY, id);
	}
}
