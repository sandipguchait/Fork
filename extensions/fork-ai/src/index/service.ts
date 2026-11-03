/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { createModelClient, type ModelClient, type ModelConfig } from '../../../../fork/model-router/src/index.ts';
import type { ModelStore } from '../modelStore.ts';
import { chunkFile } from './chunk.ts';
import { IgnoreRules } from './ignore.ts';
import { CodebaseIndex, compareForIndexing, normalize } from './search.ts';
import { documentText, embeddingPrefixes, sliceLines, type Snippet } from './snippets.ts';
import { contentHash, decodeVectorCache, encodeVectorCache } from './vectorCache.ts';

const IGNORE_FILES = ['.gitignore', '.forkignore'];
/** Folders deeper than this, or more entries than this, are not walked: generated trees. */
const MAX_DEPTH = 40;
const MAX_WALK_ENTRIES = 200_000;
const READ_CONCURRENCY = 16;
const EMBED_BATCH = 32;
const QUERY_EMBED_TIMEOUT_MS = 8000;
const UPDATE_DELAY_MS = 800;
const CACHE_SAVE_DELAY_MS = 15_000;

export type IndexState = 'off' | 'no-folder' | 'scanning' | 'ready';

export interface IndexStatus {
	readonly state: IndexState;
	/** Files indexed so far, and how many will be once the scan ends. */
	readonly files: number;
	readonly totalFiles: number;
	/** True when the file or size limit left files out. */
	readonly truncated: boolean;
	readonly chunks: number;
	readonly embeddedChunks: number;
	readonly embedModel?: string;
	/** Set while embeddings are being made. */
	readonly embedding: boolean;
	readonly embedError?: string;
}

interface Settings {
	readonly enabled: boolean;
	readonly maxFiles: number;
	readonly maxFileBytes: number;
	readonly maxTotalBytes: number;
	readonly exclude: readonly string[];
}

function readSettings(): Settings {
	const config = vscode.workspace.getConfiguration('forkAi.index');
	return {
		enabled: config.get<boolean>('enabled', true),
		maxFiles: Math.max(100, config.get<number>('maxFiles', 15000)),
		maxFileBytes: Math.max(1, config.get<number>('maxFileSizeKB', 512)) * 1024,
		maxTotalBytes: Math.max(1, config.get<number>('maxTotalSizeMB', 100)) * 1024 * 1024,
		exclude: config.get<string[]>('exclude', []),
	};
}

const decoder = new TextDecoder('utf-8', { fatal: false });
const yieldToHost = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function looksBinary(bytes: Uint8Array): boolean {
	const end = Math.min(bytes.length, 8000);
	for (let i = 0; i < end; i++) {
		if (bytes[i] === 0) {
			return true;
		}
	}
	return false;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface Embedder {
	readonly modelId: string;
	readonly config: ModelConfig;
	readonly client: ModelClient;
	/** Cache key: a different model, or the same id pointed at another model, never mixes vectors. */
	readonly cacheName: string;
}

/**
 * Keeps the codebase index of the first workspace folder: a full scan at start, then file-watcher
 * updates. With an embedding model set, embeds chunks in the background, cached on disk by hash.
 */
export class CodebaseIndexService implements vscode.Disposable {
	private index = new CodebaseIndex();
	private rules = new IgnoreRules();
	private settings = readSettings();
	private root: vscode.Uri | undefined;
	private state: IndexState = 'off';
	private totalFiles = 0;
	private indexedBytes = 0;
	private truncated = false;
	private generation = 0;
	private scanDone: Promise<void> = Promise.resolve();
	private readonly pending = new Map<string, vscode.Uri>();
	private updateTimer: ReturnType<typeof setTimeout> | undefined;
	private watcher: vscode.FileSystemWatcher | undefined;

	private embedder: Embedder | undefined;
	private embedError: string | undefined;
	private embedAbort: AbortController | undefined;
	private embedQueue = new Set<string>();
	private embedRunning = false;
	/** Hashes of each file's chunks, in chunk order, for files read while embeddings are on. */
	private readonly chunkHashes = new Map<string, string[]>();
	private vectorCache = new Map<string, Float32Array>();
	private cacheDirty = false;
	private cacheTimer: ReturnType<typeof setTimeout> | undefined;

	private readonly statusEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeStatus = this.statusEmitter.event;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly storage: vscode.Uri | undefined, private readonly store: ModelStore) {
		this.disposables.push(
			this.statusEmitter,
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('forkAi.index')) {
					void this.rebuild();
				}
			}),
			vscode.workspace.onDidChangeWorkspaceFolders(() => void this.rebuild()),
			store.onDidChange(() => void this.syncEmbedder()),
		);
	}

	dispose(): void {
		this.generation++;
		this.embedAbort?.abort();
		clearTimeout(this.updateTimer);
		clearTimeout(this.cacheTimer);
		void this.saveCache();
		this.watcher?.dispose();
		vscode.Disposable.from(...this.disposables).dispose();
	}

	status(): IndexStatus {
		return {
			state: this.state,
			files: this.index.fileCount,
			totalFiles: this.totalFiles,
			truncated: this.truncated,
			chunks: this.index.chunkCount,
			embeddedChunks: this.embedder ? this.index.embeddedCount : 0,
			embedModel: this.embedder?.config.displayName,
			embedding: this.embedRunning,
			embedError: this.embedError,
		};
	}

	/** Resolves when the current scan has finished (or immediately when there is none). */
	whenScanned(): Promise<void> {
		return this.scanDone;
	}

	start(): void {
		void this.rebuild();
	}

	/** Throws the index away and scans the folder again. Cached embeddings are reused. */
	rebuild(): Promise<void> {
		const generation = ++this.generation;
		void this.saveCache(); // Takes its snapshot before the index is cleared.
		this.embedAbort?.abort();
		this.embedError = undefined;
		this.settings = readSettings();
		this.index = new CodebaseIndex();
		this.chunkHashes.clear();
		this.embedQueue.clear();
		this.pending.clear();
		this.watcher?.dispose();
		this.watcher = undefined;
		this.root = vscode.workspace.workspaceFolders?.[0]?.uri;
		this.totalFiles = 0;
		this.indexedBytes = 0;
		this.truncated = false;
		if (!this.settings.enabled || !this.root) {
			this.state = this.settings.enabled ? 'no-folder' : 'off';
			this.fire();
			return this.scanDone = Promise.resolve();
		}
		this.state = 'scanning';
		this.fire();
		this.watch(this.root);
		return this.scanDone = this.scan(generation).catch(error => {
			console.error('[fork-ai] indexing failed', error);
			if (generation === this.generation) {
				this.state = 'ready';
				this.fire();
			}
		});
	}

	// --- Scanning ---------------------------------------------------------------------------

	private relative(uri: vscode.Uri): string | undefined {
		const root = this.root?.path.replace(/\/+$/, '');
		if (!root || !uri.path.startsWith(root + '/')) {
			return undefined;
		}
		return uri.path.slice(root.length + 1);
	}

	private async loadIgnoreFile(dir: vscode.Uri, base: string, name: string): Promise<void> {
		try {
			const text = decoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, name)));
			this.rules.add(text.split('\n'), base);
		} catch {
			// Unreadable: no rules from it.
		}
	}

	/** Every indexable file under `dir`, applying ignore files found on the way. */
	private async walk(dir: vscode.Uri, base: string, generation: number, out: string[], depth = 0): Promise<void> {
		if (depth > MAX_DEPTH || out.length >= MAX_WALK_ENTRIES || generation !== this.generation) {
			return;
		}
		let entries: [string, vscode.FileType][];
		try {
			entries = await vscode.workspace.fs.readDirectory(dir);
		} catch {
			return;
		}
		for (const name of IGNORE_FILES) {
			if (entries.some(([entry, type]) => entry === name && type & vscode.FileType.File)) {
				await this.loadIgnoreFile(dir, base, name);
			}
		}
		const folders: [vscode.Uri, string][] = [];
		for (const [name, type] of entries) {
			const path = base ? `${base}/${name}` : name;
			if (type & vscode.FileType.SymbolicLink && type & vscode.FileType.Directory) {
				continue; // Linked folders can loop, or lead out of the project.
			}
			if (type & vscode.FileType.Directory) {
				if (!this.rules.ignores(path + '/')) {
					folders.push([vscode.Uri.joinPath(dir, name), path]);
				}
			} else if (type & vscode.FileType.File && !this.rules.ignores(path)) {
				out.push(path);
			}
		}
		for (const [uri, path] of folders) {
			await this.walk(uri, path, generation, out, depth + 1);
		}
	}

	private async scan(generation: number): Promise<void> {
		const root = this.root!;
		this.rules = new IgnoreRules();
		this.rules.add(['.fork/']);
		this.rules.add(this.settings.exclude);
		const paths: string[] = [];
		await this.walk(root, '', generation, paths);
		if (generation !== this.generation) {
			return;
		}
		paths.sort(compareForIndexing);
		this.truncated = paths.length > this.settings.maxFiles;
		const selected = paths.slice(0, this.settings.maxFiles);
		this.totalFiles = selected.length;
		this.fire();

		await this.syncEmbedder(false);
		let lastReport = Date.now();
		for (let i = 0; i < selected.length && generation === this.generation; i += READ_CONCURRENCY) {
			await Promise.all(selected.slice(i, i + READ_CONCURRENCY).map(path => this.indexFile(path)));
			if (this.indexedBytes >= this.settings.maxTotalBytes) {
				this.truncated = true;
				this.totalFiles = this.index.fileCount;
				break;
			}
			if (Date.now() - lastReport > 250) {
				lastReport = Date.now();
				this.fire();
			}
			await yieldToHost();
		}
		if (generation !== this.generation) {
			return;
		}
		this.totalFiles = this.index.fileCount;
		this.state = 'ready';
		this.fire();
		void this.runEmbeddings();
	}

	/** Reads and indexes one file; returns false when it was skipped. */
	private async indexFile(path: string): Promise<boolean> {
		const uri = vscode.Uri.joinPath(this.root!, ...path.split('/'));
		let bytes: Uint8Array;
		try {
			const stat = await vscode.workspace.fs.stat(uri);
			if (!(stat.type & vscode.FileType.File) || stat.size > this.settings.maxFileBytes) {
				this.index.removeFile(path);
				return false;
			}
			bytes = await vscode.workspace.fs.readFile(uri);
		} catch {
			this.index.removeFile(path);
			return false;
		}
		if (looksBinary(bytes)) {
			this.index.removeFile(path);
			return false;
		}
		const text = decoder.decode(bytes);
		const chunks = this.index.setFile(path, text);
		this.indexedBytes += bytes.length;
		if (this.embedder) {
			this.attachEmbeddings(path, chunks.map(chunk => chunk.text));
		}
		return true;
	}

	// --- Watching ---------------------------------------------------------------------------

	private watch(root: vscode.Uri): void {
		this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
		const queue = (uri: vscode.Uri) => {
			const path = this.relative(uri);
			if (path === undefined) {
				return;
			}
			this.pending.set(path, uri);
			clearTimeout(this.updateTimer);
			this.updateTimer = setTimeout(() => void this.applyUpdates(), UPDATE_DELAY_MS);
		};
		this.watcher.onDidCreate(queue);
		this.watcher.onDidChange(queue);
		this.watcher.onDidDelete(queue);
	}

	private async applyUpdates(): Promise<void> {
		// Changes made while the first scan runs wait for it, then apply on top.
		await this.scanDone;
		const updates = [...this.pending.keys()];
		this.pending.clear();
		const generation = this.generation;
		if (updates.some(path => IGNORE_FILES.includes(path.split('/').pop()!))) {
			await this.rebuild();
			return;
		}
		for (const path of updates) {
			if (generation !== this.generation) {
				return;
			}
			if (!this.index.hasFile(path) && (this.rules.ignores(path) || this.rules.ignores(path + '/'))) {
				continue; // .git, node_modules, build output: they change all the time.
			}
			let type: vscode.FileType | undefined;
			try {
				type = (await vscode.workspace.fs.stat(vscode.Uri.joinPath(this.root!, ...path.split('/')))).type;
			} catch {
				type = undefined;
			}
			if (type === undefined) {
				// Deleted: the file itself, or a folder and everything indexed under it.
				this.index.removeFile(path);
				this.chunkHashes.delete(path);
				for (const indexed of this.index.paths()) {
					if (indexed.startsWith(path + '/')) {
						this.index.removeFile(indexed);
						this.chunkHashes.delete(indexed);
					}
				}
			} else if (type & vscode.FileType.Directory) {
				if (!this.rules.ignores(path + '/')) {
					const found: string[] = [];
					await this.walk(vscode.Uri.joinPath(this.root!, ...path.split('/')), path, generation, found);
					for (const file of found) {
						await this.addOrUpdate(file);
					}
				}
			} else if (this.rules.ignores(path)) {
				this.index.removeFile(path);
				this.chunkHashes.delete(path);
			} else {
				await this.addOrUpdate(path);
			}
		}
		this.totalFiles = this.index.fileCount;
		this.fire();
		void this.runEmbeddings();
	}

	private async addOrUpdate(path: string): Promise<void> {
		if (!this.index.hasFile(path) && this.index.fileCount >= this.settings.maxFiles) {
			this.truncated = true;
			return;
		}
		if (!await this.indexFile(path)) {
			this.chunkHashes.delete(path);
		}
	}

	// --- Embeddings -------------------------------------------------------------------------

	private embedderSync: Promise<void> = Promise.resolve();

	/** Follows the embedding model chosen in the model store. Calls run one at a time. */
	private syncEmbedder(run = true): Promise<void> {
		return this.embedderSync = this.embedderSync.then(() => this.applyEmbedder(run), error => console.error('[fork-ai] embedding model', error));
	}

	private async applyEmbedder(run: boolean): Promise<void> {
		const id = this.store.embedModelId();
		const config = id ? await this.store.resolve(id) : undefined;
		const cacheName = config ? contentHash(`${config.apiFormat}|${config.baseUrl}|${config.model}`).slice(0, 16) : undefined;
		if (cacheName === this.embedder?.cacheName && id === this.embedder?.modelId) {
			return;
		}
		this.embedAbort?.abort();
		await this.saveCache();
		this.index.clearVectors();
		this.chunkHashes.clear();
		this.embedError = undefined;
		this.vectorCache = new Map();
		this.embedder = config && id && cacheName ? { modelId: id, config, client: createModelClient(config), cacheName } : undefined;
		if (this.embedder) {
			await this.loadCache();
			// Files indexed before the model was set have no hashes yet: queue them all.
			for (const path of this.index.paths()) {
				this.embedQueue.add(path);
			}
		}
		this.fire();
		if (run && this.state === 'ready') {
			void this.runEmbeddings();
		}
	}

	/** Records a file's chunk hashes and attaches cached vectors; queues it if any are missing. */
	private attachEmbeddings(path: string, texts: readonly string[]): void {
		const embedder = this.embedder!;
		const hashes = texts.map(text => contentHash(documentText(embedder.config.model, path, text)));
		this.chunkHashes.set(path, hashes);
		let missing = false;
		hashes.forEach((hash, position) => {
			const vector = this.vectorCache.get(hash);
			if (vector) {
				this.index.setVector(path, position, vector);
			} else {
				missing = true;
			}
		});
		if (missing) {
			this.embedQueue.add(path);
		} else {
			this.embedQueue.delete(path);
		}
	}

	private async runEmbeddings(): Promise<void> {
		if (this.embedRunning || !this.embedder || this.embedError || this.state !== 'ready') {
			return;
		}
		const embedder = this.embedder;
		const abort = new AbortController();
		this.embedAbort = abort;
		this.embedRunning = true;
		this.fire();
		try {
			let batch: { path: string; position: number; hash: string; text: string }[] = [];
			const flush = async () => {
				if (!batch.length) {
					return;
				}
				const vectors = await embedder.client.embed(batch.map(item => item.text), abort.signal);
				batch.forEach((item, i) => {
					const vector = normalize(vectors[i]);
					this.vectorCache.set(item.hash, vector);
					// Only if the file still has this chunk there: it may have changed meanwhile.
					if (this.chunkHashes.get(item.path)?.[item.position] === item.hash) {
						this.index.setVector(item.path, item.position, vector);
					}
				});
				batch = [];
				this.cacheDirty = true;
				this.scheduleCacheSave();
				this.fire();
			};
			while (this.embedQueue.size && !abort.signal.aborted && embedder === this.embedder) {
				const path = this.embedQueue.values().next().value as string;
				this.embedQueue.delete(path);
				if (!this.index.hasFile(path)) {
					continue;
				}
				let hashes = this.chunkHashes.get(path);
				let texts: string[] | undefined;
				const needed = this.index.missingVectors(path);
				if (!needed.length) {
					continue;
				}
				// Read the file again for its chunk text; the index keeps none.
				try {
					const text = decoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.root!, ...path.split('/'))));
					const chunks = chunkFile(path, text);
					if (chunks.length !== this.index.chunkCountOf(path)) {
						continue; // Changed since it was indexed; the watcher queues it again.
					}
					texts = chunks.map(chunk => documentText(embedder.config.model, path, chunk.text));
					if (!hashes) {
						hashes = texts.map(contentHash);
						this.chunkHashes.set(path, hashes);
					}
				} catch {
					continue;
				}
				for (const position of needed) {
					const hash = hashes[position];
					const cached = this.vectorCache.get(hash);
					if (cached) {
						this.index.setVector(path, position, cached);
					} else {
						batch.push({ path, position, hash, text: texts[position] });
						if (batch.length >= EMBED_BATCH) {
							await flush();
						}
					}
				}
				await yieldToHost();
			}
			await flush();
		} catch (error) {
			if (!abort.signal.aborted) {
				this.embedError = messageOf(error);
				void vscode.window.showWarningMessage(`Semantic codebase search is paused: ${this.embedError}`, 'Choose Embedding Model').then(choice => {
					if (choice) {
						void vscode.commands.executeCommand('forkAi.chooseEmbeddingModel');
					}
				});
			}
		} finally {
			this.embedRunning = false;
			if (this.embedAbort === abort) {
				this.embedAbort = undefined;
			}
			this.scheduleCacheSave(0);
			this.fire();
		}
	}

	/** Lets embedding resume after an error, e.g. once Ollama is running again. */
	retryEmbeddings(): void {
		this.embedError = undefined;
		void this.runEmbeddings();
	}

	private cacheUri(): vscode.Uri | undefined {
		return this.storage && this.embedder ? vscode.Uri.joinPath(this.storage, 'embeddings', `${this.embedder.cacheName}.bin`) : undefined;
	}

	private async loadCache(): Promise<void> {
		const uri = this.cacheUri();
		if (!uri) {
			return;
		}
		try {
			const data = decodeVectorCache(await vscode.workspace.fs.readFile(uri));
			if (data && data.model === this.embedder!.config.model) {
				this.vectorCache = data.vectors;
			}
		} catch {
			// No cache yet.
		}
	}

	private scheduleCacheSave(delay = CACHE_SAVE_DELAY_MS): void {
		if (this.cacheTimer && delay) {
			return;
		}
		clearTimeout(this.cacheTimer);
		this.cacheTimer = setTimeout(() => {
			this.cacheTimer = undefined;
			void this.saveCache();
		}, delay);
	}

	/** Writes the vectors of chunks still in the index; vectors of deleted or changed code are dropped. */
	private async saveCache(): Promise<void> {
		const uri = this.cacheUri();
		if (!uri || !this.cacheDirty || !this.storage || this.state === 'scanning') {
			return; // While scanning, the chunk list is incomplete and would drop good vectors.
		}
		this.cacheDirty = false;
		const live = new Map<string, Float32Array>();
		for (const hashes of this.chunkHashes.values()) {
			for (const hash of hashes) {
				const vector = this.vectorCache.get(hash);
				if (vector) {
					live.set(hash, vector);
				}
			}
		}
		try {
			await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.storage, 'embeddings'));
			await vscode.workspace.fs.writeFile(uri, encodeVectorCache(this.embedder!.config.model, live));
		} catch (error) {
			console.error('[fork-ai] could not save the embedding cache', error);
		}
	}

	// --- Search -----------------------------------------------------------------------------

	/** Searches the index and reads each hit's lines (from the open editor when the file is open). */
	async search(query: string, options: { limit?: number; pathPrefix?: string } = {}): Promise<{ snippets: Snippet[]; semantic: boolean }> {
		let queryVector: number[] | undefined;
		const embedder = this.embedder;
		if (embedder && this.index.embeddedCount) {
			try {
				const text = `${embeddingPrefixes(embedder.config.model).query}${query}`;
				[queryVector] = await embedder.client.embed([text], AbortSignal.timeout(QUERY_EMBED_TIMEOUT_MS));
			} catch {
				queryVector = undefined; // Keyword results are still useful.
			}
		}
		const prefix = options.pathPrefix?.trim().replace(/^\.?\/+/, '').replace(/\/+$/, '');
		const hits = this.index.search(query, { limit: options.limit ?? 10, queryVector, pathPrefixes: prefix ? [prefix] : undefined });
		const texts = new Map<string, string | undefined>();
		const snippets: Snippet[] = [];
		for (const hit of hits) {
			const { path } = hit.chunk;
			if (!texts.has(path)) {
				texts.set(path, await this.readText(path));
			}
			const text = texts.get(path);
			if (text !== undefined) {
				snippets.push({ ...hit.chunk, text: sliceLines(text, hit.chunk.startLine, hit.chunk.endLine), via: hit.via });
			}
		}
		return { snippets, semantic: Boolean(queryVector) };
	}

	private async readText(path: string): Promise<string | undefined> {
		const uri = vscode.Uri.joinPath(this.root!, ...path.split('/'));
		const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
		if (open) {
			return open.getText();
		}
		try {
			return decoder.decode(await vscode.workspace.fs.readFile(uri));
		} catch {
			return undefined;
		}
	}

	/** One line on how complete the index is, for tool results and context notes. */
	describe(): string {
		const status = this.status();
		if (status.state === 'off') {
			return 'Codebase indexing is turned off.';
		}
		if (status.state === 'no-folder') {
			return 'No folder is open.';
		}
		const scope = status.state === 'scanning'
			? `The index is still being built (${status.files} of ${status.totalFiles} files so far), so results may be incomplete.`
			: `${status.files} files indexed${status.truncated ? ' (the size limit left some out)' : ''}.`;
		const semantic = status.embeddedChunks && status.chunks
			? ` Ranked by keywords and meaning${status.embeddedChunks < status.chunks ? ` (${Math.round(100 * status.embeddedChunks / status.chunks)}% embedded)` : ''}.`
			: ' Ranked by keywords.';
		return scope + semantic;
	}

	private fire(): void {
		this.statusEmitter.fire();
	}
}
