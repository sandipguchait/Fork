/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import * as vscode from 'vscode';
import type { ToolCallPart } from '../../../../fork/model-router/src/index.ts';
import { approvalFor, type ApprovalNeed } from './approvals.ts';
import type { ToolOutcome } from './loop.ts';
import { formatForAgent, type Snippet } from '../index/snippets.ts';
import { normalizeRelativePath, numberLines, replaceText, truncateOutput } from './tools.ts';

export const EXCLUDE_GLOB = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.next/**,**/.venv/**,**/__pycache__/**}';
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_RESULTS = 100;
const COMMAND_TIMEOUT_MS = 120_000;

export type ApprovalDecision = 'run' | 'always' | 'skip';

/** The project index, as the agent sees it. */
export interface CodebaseSearch {
	search(query: string, options: { limit?: number; pathPrefix?: string }): Promise<{ snippets: Snippet[] }>;
	describe(): string;
}

export interface ToolContext {
	readonly root: vscode.Uri;
	/** Content of each changed file before this turn; null when the agent created the file. */
	readonly checkpoint: Record<string, string | null>;
	readonly allowedCommands: () => readonly string[];
	readonly requestApproval: (callId: string, command: string, need: Exclude<ApprovalNeed, 'none'>) => Promise<ApprovalDecision>;
	readonly allowAlways: (command: string) => Promise<void>;
	readonly codebase?: CodebaseSearch;
}

const str = (value: unknown) => typeof value === 'string' ? value : undefined;
const fail = (content: string): ToolOutcome => ({ content, isError: true });
const decoder = new TextDecoder('utf-8', { fatal: false });

/** The agent's tools, scoped to the first workspace folder. */
export class WorkspaceTools {
	constructor(private readonly context: ToolContext) { }

	async execute(call: ToolCallPart, signal: AbortSignal): Promise<ToolOutcome> {
		const args = call.arguments;
		switch (call.name) {
			case 'read_file': return this.readFile(str(args.path), Number(args.start_line) || 1, Number(args.end_line) || undefined);
			case 'list_files': return this.listFiles(str(args.pattern));
			case 'search': return this.search(str(args.query), args.is_regex === true, str(args.include));
			case 'codebase_search': return this.codebaseSearch(str(args.query), str(args.path), Number(args.limit) || 8);
			case 'edit_file': return this.editFile(str(args.path), str(args.old_text), str(args.new_text), args.replace_all === true);
			case 'create_file': return this.createFile(str(args.path), str(args.content));
			case 'run_command': return this.runCommand(call.id, str(args.command), signal);
			default: return fail(`Unknown tool "${call.name}".`);
		}
	}

	/** Accepts workspace-relative paths, or absolute paths inside the workspace. */
	private resolve(path: string | undefined): { uri: vscode.Uri; relative: string } | ToolOutcome {
		if (!path) {
			return fail('A path is required.');
		}
		let candidate = path.trim();
		const rootPath = this.context.root.path.replace(/\/+$/, '');
		if (candidate.startsWith(rootPath + '/')) {
			candidate = candidate.slice(rootPath.length + 1);
		} else if (/^([a-zA-Z]:[\\/]|\/)/.test(candidate)) {
			return fail(`${path} is outside the workspace. Use a path relative to the workspace root.`);
		}
		const relative = normalizeRelativePath(candidate);
		if (!relative) {
			return fail(`${path} is outside the workspace. Use a path relative to the workspace root.`);
		}
		return { uri: vscode.Uri.joinPath(this.context.root, ...relative.split('/')), relative };
	}

	private async stat(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
		try {
			return await vscode.workspace.fs.stat(uri);
		} catch {
			return undefined;
		}
	}

	private async readFile(path: string | undefined, start: number, end: number | undefined): Promise<ToolOutcome> {
		const target = this.resolve(path);
		if (!('uri' in target)) {
			return target;
		}
		const stat = await this.stat(target.uri);
		if (!stat) {
			return fail(`${target.relative} does not exist.`);
		}
		if (stat.type & vscode.FileType.Directory) {
			return fail(`${target.relative} is a folder. Use list_files to see what is in it.`);
		}
		if (stat.size > MAX_FILE_BYTES) {
			return fail(`${target.relative} is larger than 2 MB. Use search to find the part you need.`);
		}
		const document = await vscode.workspace.openTextDocument(target.uri);
		return { content: numberLines(document.getText(), start, end) };
	}

	private async listFiles(pattern: string | undefined): Promise<ToolOutcome> {
		const glob = pattern?.trim() || '**/*';
		const files = await vscode.workspace.findFiles(new vscode.RelativePattern(this.context.root, glob), EXCLUDE_GLOB, 501);
		const paths = files.map(uri => vscode.workspace.asRelativePath(uri, false)).sort();
		if (!paths.length) {
			return { content: `No files match ${glob}.` };
		}
		const shown = paths.slice(0, 500);
		return { content: shown.join('\n') + (paths.length > 500 ? '\n… more files not shown. Use a narrower pattern.' : '') };
	}

	private async codebaseSearch(query: string | undefined, path: string | undefined, limit: number): Promise<ToolOutcome> {
		const codebase = this.context.codebase;
		if (!codebase) {
			return fail('Codebase search is not available. Use search instead.');
		}
		if (!query?.trim()) {
			return fail('A query is required.');
		}
		let prefix: string | undefined;
		if (path?.trim() && !/^\.?\/?$/.test(path.trim())) {
			prefix = normalizeRelativePath(path);
			if (!prefix) {
				return fail(`${path} is outside the workspace.`);
			}
		}
		const { snippets } = await codebase.search(query, { limit: Math.min(20, Math.max(1, Math.floor(limit))), pathPrefix: prefix });
		return { content: formatForAgent(query, snippets, codebase.describe()) };
	}

	private async search(query: string | undefined, isRegex: boolean, include: string | undefined): Promise<ToolOutcome> {
		if (!query) {
			return fail('A query is required.');
		}
		let pattern: RegExp;
		try {
			// Smart case: case-insensitive unless the query has capitals.
			const flags = /[A-Z]/.test(query) ? '' : 'i';
			pattern = new RegExp(isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
		} catch (error) {
			return fail(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
		}
		const files = await vscode.workspace.findFiles(new vscode.RelativePattern(this.context.root, include?.trim() || '**/*'), EXCLUDE_GLOB, 5000);
		const results: string[] = [];
		let filesWithMatches = 0;
		for (const uri of files.sort((a, b) => a.path.localeCompare(b.path))) {
			if (results.length >= MAX_SEARCH_RESULTS) {
				break;
			}
			const stat = await this.stat(uri);
			if (!stat || stat.size > MAX_SEARCH_FILE_BYTES) {
				continue;
			}
			const bytes = await vscode.workspace.fs.readFile(uri);
			if (bytes.subarray(0, 8000).includes(0)) {
				continue; // binary
			}
			const lines = decoder.decode(bytes).split(/\r?\n/);
			let matched = false;
			for (let index = 0; index < lines.length && results.length < MAX_SEARCH_RESULTS; index++) {
				if (pattern.test(lines[index])) {
					matched = true;
					results.push(`${vscode.workspace.asRelativePath(uri, false)}:${index + 1}: ${lines[index].trim().slice(0, 200)}`);
				}
			}
			filesWithMatches += matched ? 1 : 0;
		}
		if (!results.length) {
			return { content: `No matches for ${query}.` };
		}
		const more = results.length >= MAX_SEARCH_RESULTS ? '\n… stopped at 100 matches. Narrow the query or the include glob.' : '';
		return { content: `${results.length} matches in ${filesWithMatches} files:\n${results.join('\n')}${more}` };
	}

	/** Records a file's content before the agent's first change to it this turn. */
	private remember(relative: string, original: string | null): void {
		if (!(relative in this.context.checkpoint)) {
			this.context.checkpoint[relative] = original;
		}
	}

	private async writeDocument(document: vscode.TextDocument, content: string): Promise<boolean> {
		const edit = new vscode.WorkspaceEdit();
		const end = document.lineAt(document.lineCount - 1).range.end;
		edit.replace(document.uri, new vscode.Range(0, 0, end.line, end.character), content);
		if (!await vscode.workspace.applyEdit(edit)) {
			return false;
		}
		// Saved so commands the agent runs next (tests, builds) see the change.
		return document.save();
	}

	private async editFile(path: string | undefined, oldText: string | undefined, newText: string | undefined, replaceAll: boolean): Promise<ToolOutcome> {
		const target = this.resolve(path);
		if (!('uri' in target)) {
			return target;
		}
		if (oldText === undefined || newText === undefined) {
			return fail('old_text and new_text are required.');
		}
		if (!await this.stat(target.uri)) {
			return fail(`${target.relative} does not exist. Use create_file for new files.`);
		}
		const document = await vscode.workspace.openTextDocument(target.uri);
		const original = document.getText();
		const result = replaceText(original, oldText, newText, replaceAll);
		if (!result.ok) {
			return fail(`${target.relative}: ${result.error}`);
		}
		this.remember(target.relative, original);
		if (!await this.writeDocument(document, result.content)) {
			return fail(`Could not save ${target.relative}.`);
		}
		return { content: `Edited ${target.relative}: ${result.count} replacement${result.count === 1 ? '' : 's'}.` };
	}

	private async createFile(path: string | undefined, content: string | undefined): Promise<ToolOutcome> {
		const target = this.resolve(path);
		if (!('uri' in target)) {
			return target;
		}
		if (content === undefined) {
			return fail('content is required.');
		}
		const stat = await this.stat(target.uri);
		if (stat && stat.type & vscode.FileType.Directory) {
			return fail(`${target.relative} is a folder.`);
		}
		if (stat) {
			const document = await vscode.workspace.openTextDocument(target.uri);
			this.remember(target.relative, document.getText());
			if (!await this.writeDocument(document, content)) {
				return fail(`Could not save ${target.relative}.`);
			}
			return { content: `Replaced the content of ${target.relative}.` };
		}
		this.remember(target.relative, null);
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target.uri, '..'));
		await vscode.workspace.fs.writeFile(target.uri, new TextEncoder().encode(content));
		return { content: `Created ${target.relative}.` };
	}

	private async runCommand(callId: string, command: string | undefined, signal: AbortSignal): Promise<ToolOutcome> {
		if (!command?.trim()) {
			return fail('A command is required.');
		}
		if (this.context.root.scheme !== 'file') {
			return fail('Commands can only run in a folder on this computer.');
		}
		const need = approvalFor(command, this.context.allowedCommands());
		if (need !== 'none') {
			const decision = await this.context.requestApproval(callId, command.trim(), need);
			if (decision === 'skip') {
				return { content: 'The user chose not to run this command. Ask them, or try another way.', isError: true };
			}
			if (decision === 'always') {
				await this.context.allowAlways(command.trim());
			}
		}
		return runShell(command, this.context.root.fsPath, signal);
	}
}

/** Runs a command in the user's shell, capturing stdout and stderr together. */
export function runShell(command: string, cwd: string, signal: AbortSignal, timeoutMs = COMMAND_TIMEOUT_MS): Promise<ToolOutcome> {
	return new Promise(resolve => {
		const windows = process.platform === 'win32';
		const shell = windows ? (process.env.COMSPEC || 'cmd.exe') : (process.env.SHELL || '/bin/sh');
		const args = windows ? ['/d', '/s', '/c', command] : ['-c', command];
		const child = spawn(shell, args, { cwd, env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' }, windowsVerbatimArguments: windows });
		let output = '';
		let finished = false;
		const append = (chunk: Buffer) => {
			if (output.length < 200_000) {
				output += chunk.toString('utf8');
			}
		};
		child.stdout.on('data', append);
		child.stderr.on('data', append);
		const stop = (reason: string) => {
			if (!finished) {
				output += `\n[${reason}]`;
				child.kill('SIGTERM');
				setTimeout(() => child.kill('SIGKILL'), 2000).unref();
			}
		};
		const timer = setTimeout(() => stop(`Stopped after ${timeoutMs / 1000} seconds`), timeoutMs);
		const onAbort = () => stop('Stopped by the user');
		signal.addEventListener('abort', onAbort, { once: true });
		const done = (code: number | null, error?: Error) => {
			if (finished) {
				return;
			}
			finished = true;
			clearTimeout(timer);
			signal.removeEventListener('abort', onAbort);
			const text = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trimEnd();
			const header = error ? `Could not start the command: ${error.message}` : `Exit code: ${code ?? 'killed'}`;
			resolve({ content: truncateOutput(`${header}\n${text || '(no output)'}`), isError: Boolean(error) || code !== 0 });
		};
		child.on('error', error => done(null, error));
		child.on('close', code => done(code));
	});
}
