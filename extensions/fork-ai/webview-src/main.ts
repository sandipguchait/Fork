/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { ChangeView, ChatState, ContextChip, FromWebview, StepView, ToWebview, TurnView } from '../src/protocol.ts';
import { parseMarkdown } from './markdown.ts';

interface VsCodeApi {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const post = (message: FromWebview) => vscode.postMessage(message);

const ICONS = {
	send: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
	stop: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/></svg>',
	close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7m0-7-7 7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
	file: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.75h5L12.25 5v9.25H4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M9 1.75V5h3.25" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
	plus: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
	check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
	error: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 5v3.5M8 10.8v.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
	skip: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
	pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4.5v7M10 4.5v7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
	spin: '<svg viewBox="0 0 16 16" aria-hidden="true" class="spin"><path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) {
		node.className = className;
	}
	if (text !== undefined) {
		node.textContent = text;
	}
	return node;
}

function iconButton(className: string, icon: string, label: string, onClick: () => void): HTMLButtonElement {
	const button = el('button', className);
	button.type = 'button';
	button.innerHTML = icon;
	button.title = label;
	button.setAttribute('aria-label', label);
	button.addEventListener('click', onClick);
	return button;
}

// --- Layout ---------------------------------------------------------------------------------

const root = el('div', 'chat');
const messages = el('div', 'messages');
messages.setAttribute('role', 'log');
messages.setAttribute('aria-live', 'polite');
const composer = el('div', 'composer');
const chips = el('div', 'chips');
const input = el('textarea', 'input');
input.rows = 1;
input.placeholder = 'Ask about your code. Type @ to add a file.';
input.setAttribute('aria-label', 'Message');
const footer = el('div', 'composer-footer');
const modeSelect = el('select', 'mode-select');
modeSelect.setAttribute('aria-label', 'Mode');
for (const [value, label, title] of [['ask', 'Ask', 'Answers questions about your code'], ['agent', 'Agent', 'Reads, edits and runs commands in your project to finish a task']]) {
	const option = el('option', undefined, label);
	option.value = value;
	option.title = title;
	modeSelect.append(option);
}
const modelSelect = el('select', 'model-select');
modelSelect.setAttribute('aria-label', 'Model');
const sendButton = iconButton('send', ICONS.send, 'Send (Enter)', () => sendOrStop());
const warning = el('div', 'agent-warning');
warning.setAttribute('role', 'status');

footer.append(modeSelect, modelSelect, el('span', 'spacer'), sendButton);
composer.append(chips, input, footer);
root.append(messages, warning, composer);
document.body.append(root);

// --- State ----------------------------------------------------------------------------------

let state: ChatState | undefined;
const liveText = new Map<string, string>();
const turnBodies = new Map<string, HTMLElement>();
let renderQueued = false;

const saved = vscode.getState() as { draft?: string } | undefined;
if (saved?.draft) {
	input.value = saved.draft;
}

function nearBottom(): boolean {
	return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
}

function scrollToBottom(): void {
	messages.scrollTop = messages.scrollHeight;
}

// --- Rendering ------------------------------------------------------------------------------

function renderCodeBlock(language: string, code: string): HTMLElement {
	const block = el('div', 'codeblock');
	const head = el('div', 'codeblock-head');
	head.append(el('span', 'codeblock-lang', language || 'text'), el('span', 'spacer'));
	const copy = el('button', 'codeblock-action', 'Copy');
	copy.type = 'button';
	copy.addEventListener('click', () => {
		post({ type: 'copyCode', code });
		copy.textContent = 'Copied';
		setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
	});
	const insert = el('button', 'codeblock-action', 'Insert');
	insert.type = 'button';
	insert.title = 'Insert at the cursor, replacing the selection';
	insert.addEventListener('click', () => post({ type: 'insertCode', code }));
	const apply = el('button', 'codeblock-action apply', 'Apply');
	apply.type = 'button';
	apply.title = 'Apply to the selection, or the whole file, and review each change';
	apply.addEventListener('click', () => post({ type: 'applyCode', code }));
	head.append(copy, insert, apply);
	const pre = el('pre');
	const codeEl = el('code', language ? `language-${language}` : undefined);
	codeEl.textContent = code;
	pre.append(codeEl);
	block.append(head, pre);
	return block;
}

/** Returns true when the text ends inside an unfinished code block. */
function renderMarkdownInto(target: HTMLElement, text: string): boolean {
	target.replaceChildren();
	const blocks = parseMarkdown(text);
	for (const block of blocks) {
		if (block.type === 'code') {
			target.append(renderCodeBlock(block.language, block.code));
		} else {
			const wrapper = el('div', 'md');
			wrapper.innerHTML = block.html; // Produced from escaped text by parseMarkdown.
			target.append(wrapper);
		}
	}
	const last = blocks[blocks.length - 1];
	return last?.type === 'code' && !last.complete;
}

function renderAssistantBody(turn: TurnView, body: HTMLElement): void {
	const text = liveText.get(turn.id) ?? turn.text;
	const streaming = state?.streamingTurnId === turn.id;
	if (!text && streaming) {
		body.replaceChildren(el('div', 'thinking', 'Thinking'));
		return;
	}
	const insideCode = renderMarkdownInto(body, text);
	// Inside an unfinished code block the growing code shows progress; a cursor below it looks detached.
	if (streaming && !insideCode) {
		body.append(el('span', 'cursor'));
	}
}

function renderTurn(turn: TurnView): HTMLElement {
	const node = el('div', `turn ${turn.role}`);
	if (turn.role === 'user') {
		if (turn.chips?.length) {
			const used = el('div', 'turn-chips');
			for (const label of turn.chips) {
				const chip = el('span', 'chip small');
				chip.innerHTML = ICONS.file;
				chip.append(el('span', undefined, label));
				used.append(chip);
			}
			node.append(used);
		}
		node.append(el('div', 'user-text', turn.text));
		return node;
	}

	if (turn.modelName) {
		node.append(el('div', 'turn-meta', turn.steps ? `${turn.modelName} · agent` : turn.modelName));
	}
	if (turn.steps) {
		node.append(renderSteps(turn));
		if (turn.changes?.length) {
			node.append(renderChanges(turn, turn.changes));
		}
	} else {
		const body = el('div', 'assistant-body');
		turnBodies.set(turn.id, body);
		renderAssistantBody(turn, body);
		node.append(body);
	}
	if (turn.error) {
		const error = el('div', 'error');
		error.append(el('div', 'error-text', turn.error));
		const manage = el('button', 'link-button', 'Manage models');
		manage.type = 'button';
		manage.addEventListener('click', () => post({ type: 'manageModels' }));
		error.append(manage);
		node.append(error);
	}
	return node;
}

const STATUS_ICON: Record<NonNullable<StepView['status']>, string> = {
	running: ICONS.spin, done: ICONS.check, error: ICONS.error, skipped: ICONS.skip, awaiting: ICONS.pause,
};
const STATUS_LABEL: Record<NonNullable<StepView['status']>, string> = {
	running: 'Running', done: 'Done', error: 'Failed', skipped: 'Skipped', awaiting: 'Waiting for you',
};
const openDetails = new Set<string>();

function renderToolStep(step: StepView): HTMLElement {
	const status = step.status ?? 'done';
	const card = el('div', `tool-step status-${status}`);
	const head = el('button', 'tool-head');
	head.type = 'button';
	const icon = el('span', 'tool-icon');
	icon.innerHTML = STATUS_ICON[status];
	icon.title = STATUS_LABEL[status];
	head.append(icon, el('span', 'tool-title', step.text));
	head.setAttribute('aria-expanded', String(openDetails.has(step.id)));
	head.setAttribute('aria-label', `${step.text}. ${STATUS_LABEL[status]}.${step.detail ? ' Show output.' : ''}`);
	card.append(head);
	if (step.detail) {
		const detail = el('pre', 'tool-detail', step.detail);
		detail.hidden = !openDetails.has(step.id);
		head.addEventListener('click', () => {
			detail.hidden = !detail.hidden;
			head.setAttribute('aria-expanded', String(!detail.hidden));
			if (detail.hidden) {
				openDetails.delete(step.id);
			} else {
				openDetails.add(step.id);
			}
		});
		card.append(detail);
	} else {
		head.disabled = true;
	}
	if (step.approval) {
		const ask = el('div', 'approval');
		const destructive = !step.approval.allowAlways;
		ask.append(el('div', 'approval-text', destructive ? 'This command can delete data or rewrite history. Run it?' : 'Run this command?'));
		ask.append(el('code', 'approval-command', step.approval.command));
		const actions = el('div', 'approval-actions');
		const decide = (decision: 'run' | 'always' | 'skip') => post({ type: 'approve', stepId: step.id, decision });
		const run = el('button', destructive ? 'primary danger' : 'primary', 'Run');
		run.type = 'button';
		run.addEventListener('click', () => decide('run'));
		actions.append(run);
		if (!destructive) {
			const always = el('button', 'secondary', 'Always allow');
			always.type = 'button';
			always.title = 'Run this exact command without asking from now on, in this project';
			always.addEventListener('click', () => decide('always'));
			actions.append(always);
		}
		const skip = el('button', 'secondary', 'Skip');
		skip.type = 'button';
		skip.addEventListener('click', () => decide('skip'));
		actions.append(skip);
		ask.append(actions);
		card.append(ask);
	}
	return card;
}

function renderSteps(turn: TurnView): HTMLElement {
	const list = el('div', 'steps');
	for (const step of turn.steps ?? []) {
		if (step.kind === 'tool') {
			list.append(renderToolStep(step));
		} else if (step.text) {
			const body = el('div', 'assistant-body');
			renderMarkdownInto(body, step.text);
			list.append(body);
		}
	}
	const streaming = state?.streamingTurnId === turn.id;
	const last = turn.steps?.[turn.steps.length - 1];
	if (streaming && (!last || (last.kind === 'tool' && last.status !== 'awaiting'))) {
		list.append(el('div', 'thinking', last ? 'Working' : 'Thinking'));
	}
	return list;
}

function renderChanges(turn: TurnView, changes: readonly ChangeView[]): HTMLElement {
	const box = el('div', `changes${turn.undone ? ' undone' : ''}`);
	const head = el('div', 'changes-head');
	head.append(el('span', 'changes-title', turn.undone ? `Undid changes to ${changes.length} file${changes.length === 1 ? '' : 's'}` : `Changed ${changes.length} file${changes.length === 1 ? '' : 's'}`));
	head.append(el('span', 'spacer'));
	if (turn.canUndo) {
		const undo = el('button', 'link-button', 'Undo all');
		undo.type = 'button';
		undo.title = 'Put every file back the way it was before this turn';
		undo.addEventListener('click', () => post({ type: 'undoChanges', turnId: turn.id }));
		head.append(undo);
	}
	box.append(head);
	for (const change of changes) {
		const row = el('button', 'change-row');
		row.type = 'button';
		row.title = turn.undone ? `Open ${change.path}` : `Review the changes to ${change.path}`;
		row.addEventListener('click', () => post({ type: 'reviewChange', turnId: turn.id, path: change.path }));
		row.append(el('span', 'change-path', change.path));
		if (change.created) {
			row.append(el('span', 'change-new', 'new'));
		}
		row.append(el('span', 'spacer'), el('span', 'change-added', `+${change.added}`), el('span', 'change-removed', `−${change.removed}`));
		box.append(row);
	}
	return box;
}

function renderEmpty(current: ChatState): HTMLElement {
	const empty = el('div', 'empty');
	if (!current.models.length) {
		empty.append(
			el('div', 'empty-title', 'Bring your own model'),
			el('p', 'empty-text', 'Connect any model with an endpoint URL, an API key and a model name: OpenRouter, Anthropic, OpenAI, Gemini, Groq, or a free local model with Ollama or LM Studio.'),
		);
		const add = el('button', 'primary', 'Add a model');
		add.type = 'button';
		add.addEventListener('click', () => post({ type: 'addModel' }));
		empty.append(add);
		return empty;
	}
	const agent = current.mode === 'agent';
	empty.append(el('div', 'empty-title', agent ? 'Give the agent a task' : 'Ask anything about your code'));
	const tips = el('ul', 'empty-tips');
	const lines = agent
		? ['It reads and searches your project, edits files and runs commands such as tests.', 'Commands that are not read-only wait for your approval.', 'When it is done, review each changed file or undo everything in one click.']
		: ['The open file is sent with your message. Remove its chip to leave it out.', 'Select code and press Cmd+L (Ctrl+L) to add it here.', 'Type @ to add another file. Switch to Agent below for multi-step tasks.'];
	for (const tip of lines) {
		tips.append(el('li', undefined, tip));
	}
	empty.append(tips);
	return empty;
}

function chipNode(chip: ContextChip, options: { excluded?: boolean; onRemove?: () => void; onToggle?: () => void }): HTMLElement {
	const node = el('span', `chip${options.excluded ? ' excluded' : ''}${chip.kind === 'current' ? ' current' : ''}`);
	node.title = chip.title;
	node.innerHTML = ICONS.file;
	node.append(el('span', 'chip-label', chip.label));
	if (chip.kind === 'current') {
		node.append(el('span', 'chip-note', options.excluded ? 'not sent' : 'current file'));
	}
	if (options.onToggle) {
		node.classList.add('clickable');
		node.setAttribute('role', 'button');
		node.tabIndex = 0;
		node.addEventListener('click', options.onToggle);
		node.addEventListener('keydown', event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				options.onToggle!();
			}
		});
	}
	if (options.onRemove) {
		node.append(iconButton('chip-remove', ICONS.close, `Remove ${chip.label}`, () => options.onRemove!()));
	}
	return node;
}

function renderChips(current: ChatState): void {
	chips.replaceChildren();
	if (current.currentFile) {
		chips.append(chipNode(current.currentFile, {
			excluded: current.currentFileExcluded,
			onToggle: () => post({ type: 'toggleCurrentFile' }),
		}));
	}
	for (const attachment of current.attachments) {
		chips.append(chipNode(attachment, { onRemove: () => post({ type: 'removeAttachment', id: attachment.id }) }));
	}
	const add = iconButton('chip add-context', ICONS.plus, 'Add a file to the context (@)', () => post({ type: 'attachFile' }));
	add.append(el('span', 'chip-label', 'Add context'));
	chips.append(add);
}

function renderModels(current: ChatState): void {
	modelSelect.replaceChildren();
	for (const model of current.models) {
		const option = el('option', undefined, model.name);
		option.value = model.id;
		option.title = model.detail;
		modelSelect.append(option);
	}
	if (current.models.length) {
		const divider = el('option', undefined, '──────────');
		divider.disabled = true;
		modelSelect.append(divider);
	}
	const add = el('option', undefined, 'Add model…');
	add.value = '__add__';
	const manage = el('option', undefined, 'Manage models…');
	manage.value = '__manage__';
	modelSelect.append(add);
	if (current.models.length) {
		modelSelect.append(manage);
	}
	modelSelect.value = current.selectedModelId ?? '__add__';
	modelSelect.classList.toggle('empty', !current.models.length);
}

function render(): void {
	if (!state) {
		return;
	}
	const pinned = nearBottom();
	turnBodies.clear();
	messages.replaceChildren();
	if (!state.turns.length) {
		messages.append(renderEmpty(state));
	} else {
		for (const turn of state.turns) {
			messages.append(renderTurn(turn));
		}
	}
	renderChips(state);
	renderModels(state);
	modeSelect.value = state.mode;
	input.placeholder = state.mode === 'agent' ? 'Describe a task, e.g. fix the failing test in dates.ts' : 'Ask about your code. Type @ to add a file.';
	warning.textContent = state.agentWarning ?? '';
	warning.hidden = !state.agentWarning;
	sendButton.innerHTML = state.busy ? ICONS.stop : ICONS.send;
	sendButton.title = state.busy ? 'Stop' : 'Send (Enter)';
	sendButton.setAttribute('aria-label', state.busy ? 'Stop' : 'Send');
	sendButton.classList.toggle('busy', state.busy);
	updateSendEnabled();
	if (pinned) {
		scrollToBottom();
	}
}

function renderStreaming(): void {
	renderQueued = false;
	if (!state?.streamingTurnId) {
		return;
	}
	const turn = state.turns.find(candidate => candidate.id === state!.streamingTurnId);
	const body = turn && turnBodies.get(turn.id);
	if (turn && body) {
		const pinned = nearBottom();
		renderAssistantBody(turn, body);
		if (pinned) {
			scrollToBottom();
		}
	}
}

// --- Input ----------------------------------------------------------------------------------

function autosize(): void {
	input.style.height = 'auto';
	input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
}

function updateSendEnabled(): void {
	sendButton.disabled = !state?.busy && (!input.value.trim() || !state?.models.length);
}

function sendOrStop(): void {
	if (state?.busy) {
		post({ type: 'stop' });
		return;
	}
	const text = input.value.trim();
	if (!text || !state?.models.length) {
		return;
	}
	post({ type: 'send', text });
	input.value = '';
	vscode.setState({ draft: '' });
	autosize();
	updateSendEnabled();
}

input.addEventListener('keydown', event => {
	if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
		event.preventDefault();
		sendOrStop();
		return;
	}
	if (event.key === '@') {
		const before = input.value.slice(0, input.selectionStart ?? 0);
		if (!before || /\s$/.test(before)) {
			event.preventDefault();
			post({ type: 'attachFile' });
		}
	}
});

input.addEventListener('input', () => {
	autosize();
	updateSendEnabled();
	vscode.setState({ draft: input.value });
});

modeSelect.addEventListener('change', () => {
	post({ type: 'setMode', mode: modeSelect.value === 'agent' ? 'agent' : 'ask' });
});

modelSelect.addEventListener('change', () => {
	const value = modelSelect.value;
	if (value === '__add__' || value === '__manage__') {
		post({ type: value === '__add__' ? 'addModel' : 'manageModels' });
		modelSelect.value = state?.selectedModelId ?? '__add__';
		return;
	}
	post({ type: 'selectModel', id: value });
});

// --- Messages from the extension ------------------------------------------------------------

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
	const message = event.data;
	switch (message.type) {
		case 'state':
			state = message.state;
			for (const turn of state.turns) {
				if (turn.id !== state.streamingTurnId) {
					liveText.delete(turn.id);
				} else if (!liveText.has(turn.id)) {
					liveText.set(turn.id, turn.text);
				}
			}
			render();
			break;
		case 'delta':
			liveText.set(message.turnId, (liveText.get(message.turnId) ?? '') + message.text);
			if (!renderQueued) {
				renderQueued = true;
				requestAnimationFrame(renderStreaming);
			}
			break;
		case 'focusInput':
			input.focus();
			break;
	}
});

autosize();
post({ type: 'ready' });
