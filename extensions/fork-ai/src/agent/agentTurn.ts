/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { createModelClient, type ChatMessage, type ModelConfig } from '../../../../fork/model-router/src/index.ts';
import { countChanges } from '../diff.ts';
import type { AgentStepRecord, ChatTurn } from '../history.ts';
import { runAgent } from './loop.ts';
import { AGENT_SYSTEM_PROMPT, AGENT_TOOLS, describeToolCall } from './tools.ts';
import { WorkspaceTools, type ApprovalDecision } from './workspaceTools.ts';

/** Project rules added to the system prompt, first found wins. */
export const RULES_FILES = ['.fork/rules.md', 'AGENTS.md', '.cursorrules'];
const MAX_RULES_CHARS = 8000;
const MAX_STEP_DETAIL = 4000;

export interface ChangeSummary {
	readonly path: string;
	readonly added: number;
	readonly removed: number;
	readonly created: boolean;
}

/** The project's rules file, if any, trimmed to a size that leaves room for the work. */
export async function readRules(root: vscode.Uri | undefined): Promise<{ file: string; text: string } | undefined> {
	if (!root) {
		return undefined;
	}
	for (const file of RULES_FILES) {
		try {
			const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, ...file.split('/')));
			const text = new TextDecoder().decode(bytes).trim();
			if (text) {
				return { file, text: text.length > MAX_RULES_CHARS ? text.slice(0, MAX_RULES_CHARS) + '\n…' : text };
			}
		} catch {
			// Not there; try the next one.
		}
	}
	return undefined;
}

export function withRules(system: string, rules: { file: string; text: string } | undefined): string {
	return rules ? `${system}\n\nProject rules from ${rules.file} (follow them unless the user says otherwise):\n${rules.text}` : system;
}

export interface AgentTurnOptions {
	readonly config: ModelConfig;
	readonly root: vscode.Uri;
	readonly reply: ChatTurn;
	readonly messages: readonly ChatMessage[];
	readonly signal: AbortSignal;
	readonly allowedCommands: () => readonly string[];
	readonly allowAlways: (command: string) => Promise<void>;
	/** Shows Run / Skip on a step and resolves with the user's choice. */
	readonly askApproval: (step: AgentStepRecord, command: string, allowAlways: boolean) => Promise<ApprovalDecision>;
	/** Called whenever the reply's steps change. */
	readonly onUpdate: () => void;
}

/** Runs one agent turn, filling in the reply's steps, transcript, text and checkpoint as it goes. */
export async function runAgentTurn(options: AgentTurnOptions): Promise<'done' | 'max_steps' | 'aborted'> {
	const { reply } = options;
	const steps: AgentStepRecord[] = reply.steps ??= [];
	const checkpoint = reply.checkpoint ??= {};
	const toolSteps = new Map<string, AgentStepRecord>();
	let textStep: AgentStepRecord | undefined;
	let textStepIndex = -1;

	const tools = new WorkspaceTools({
		root: options.root,
		checkpoint,
		allowedCommands: options.allowedCommands,
		allowAlways: options.allowAlways,
		requestApproval: (callId, command, need) => {
			const step = toolSteps.get(callId);
			return step ? options.askApproval(step, command, need === 'ask') : Promise.resolve('skip');
		},
	});

	const rules = await readRules(options.root);
	const system = withRules(`${AGENT_SYSTEM_PROMPT}\nThe workspace is "${vscode.workspace.name ?? options.root.path.split('/').pop()}" on ${process.platform}.`, rules);

	const result = await runAgent({
		client: createModelClient(options.config),
		system,
		messages: options.messages,
		tools: AGENT_TOOLS,
		signal: options.signal,
		execute: (call, signal) => tools.execute(call, signal),
		events: {
			onText: (step, text) => {
				if (!textStep || textStepIndex !== step) {
					textStep = { id: `${reply.id}_t${step}`, kind: 'text', text: '' };
					textStepIndex = step;
					steps.push(textStep);
				}
				textStep.text += text;
				reply.text += text;
				options.onUpdate();
			},
			onToolStart: call => {
				const step: AgentStepRecord = { id: call.id || `${reply.id}_c${steps.length}`, kind: 'tool', text: describeToolCall(call.name, call.arguments), status: 'running' };
				toolSteps.set(call.id, step);
				steps.push(step);
				textStep = undefined;
				options.onUpdate();
			},
			onToolEnd: (call, outcome) => {
				const step = toolSteps.get(call.id);
				if (step) {
					step.approval = undefined;
					step.status = /^The user chose not to run/.test(outcome.content) || outcome.content === 'Cancelled by the user.' ? 'skipped' : outcome.isError ? 'error' : 'done';
					step.detail = outcome.content.length > MAX_STEP_DETAIL ? outcome.content.slice(0, MAX_STEP_DETAIL) + '\n…' : outcome.content;
				}
				options.onUpdate();
			},
		},
	});

	reply.transcript = result.transcript;
	if (result.stopReason === 'max_steps') {
		steps.push({ id: `${reply.id}_limit`, kind: 'text', text: '*Stopped after 25 steps. Send a message to let the agent continue.*' });
	}
	return result.stopReason;
}

/** What each changed file looks like now compared with the checkpoint. Unchanged files are left out. */
export async function summarizeChanges(root: vscode.Uri, checkpoint: Record<string, string | null>): Promise<ChangeSummary[]> {
	const changes: ChangeSummary[] = [];
	for (const [path, original] of Object.entries(checkpoint)) {
		let current: string | null = null;
		try {
			current = (await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, ...path.split('/')))).getText();
		} catch {
			current = null;
		}
		if (current === original) {
			continue;
		}
		const { added, removed } = countChanges(original, current);
		changes.push({ path, added, removed, created: original === null });
	}
	return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/** Puts every file back the way the checkpoint recorded it; files the agent created go to the trash. */
export async function restoreCheckpoint(root: vscode.Uri, checkpoint: Record<string, string | null>): Promise<string[]> {
	const failed: string[] = [];
	for (const [path, original] of Object.entries(checkpoint)) {
		const uri = vscode.Uri.joinPath(root, ...path.split('/'));
		try {
			if (original === null) {
				await vscode.workspace.fs.delete(uri, { useTrash: true });
				continue;
			}
			let document: vscode.TextDocument | undefined;
			try {
				document = await vscode.workspace.openTextDocument(uri);
			} catch {
				document = undefined;
			}
			if (!document) {
				await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(original));
				continue;
			}
			const edit = new vscode.WorkspaceEdit();
			const end = document.lineAt(document.lineCount - 1).range.end;
			edit.replace(uri, new vscode.Range(0, 0, end.line, end.character), original);
			if (!await vscode.workspace.applyEdit(edit) || !await document.save()) {
				failed.push(path);
			}
		} catch {
			failed.push(path);
		}
	}
	return failed;
}
