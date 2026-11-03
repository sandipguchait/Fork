/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { chunkFile, type Chunk } from './chunk.ts';
import { pathTerms, queryTerms, tokenize } from './tokenize.ts';

const K1 = 1.2;
const B = 0.75;
/** A query word in the file's name counts like this many occurrences in the chunk; in a folder name, like FOLDER_WEIGHT. */
const NAME_WEIGHT = 6;
const FOLDER_WEIGHT = 2;
/** How much the file's other matching chunks add to a chunk's score, so the file about X beats a passing mention. */
const FILE_EVIDENCE = 0.3;
/** Tests, fixtures, typings and generated grammars rank below the code they describe. */
const SECONDARY_WEIGHT = 0.6;
const RRF_K = 60;

/** Where a chunk is. The index keeps no text; callers read the lines from the file. */
export interface ChunkRef {
	readonly path: string;
	/** 1-based, inclusive. */
	readonly startLine: number;
	readonly endLine: number;
}

interface IndexedChunk extends ChunkRef {
	readonly id: number;
	readonly length: number;
	readonly terms: Uint32Array;
	vector?: Float32Array;
}

interface Posting {
	/** Chunk ids, ascending (ids only grow), so removal can binary-search. */
	readonly ids: number[];
	readonly tfs: number[];
}

export interface SearchHit {
	readonly chunk: ChunkRef;
	readonly score: number;
	/** Which rankers found it. */
	readonly via: readonly ('keyword' | 'semantic')[];
}

export interface SearchOptions {
	readonly limit?: number;
	/** The query's embedding, when an embedding model is set; enables hybrid ranking. */
	readonly queryVector?: readonly number[];
	/** Only search paths that start with one of these prefixes. */
	readonly pathPrefixes?: readonly string[];
	/** Chunks per file in the results (default 2), so one big file cannot crowd out the rest. */
	readonly perFile?: number;
}

export function normalize(vector: readonly number[]): Float32Array {
	let norm = 0;
	for (const value of vector) {
		norm += value * value;
	}
	norm = Math.sqrt(norm) || 1;
	return Float32Array.from(vector, value => value / norm);
}

function dot(a: Float32Array, b: Float32Array): number {
	let sum = 0;
	const length = Math.min(a.length, b.length);
	for (let i = 0; i < length; i++) {
		sum += a[i] * b[i];
	}
	return sum;
}

/** Reciprocal rank fusion: rank-based, so BM25 and cosine scores never need comparable scales. */
export function fuse(lists: readonly (readonly number[])[]): Map<number, number> {
	const scores = new Map<number, number>();
	for (const list of lists) {
		list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
	}
	return scores;
}

export function isSecondaryPath(path: string): boolean {
	return /(^|\/)(tests?|__tests__|spec|fixtures?|__mocks__|testdata|componentFixtures)\//i.test(path)
		|| /\.(test|spec|perf|fixture|integrationTest)\.[^/]+$/i.test(path)
		|| /\.d\.ts$|\.tmLanguage(\.json|\.ts)?$|\.snap$/.test(path)
		|| /(^|\/)(package\.nls(\.[\w-]+)?\.json|CHANGELOG\.md|ThirdPartyNotices\.txt|cglicenses\.json|cgmanifest\.json)$/i.test(path);
}

const CODE_EXTENSIONS = new Set([
	'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'swift', 'm', 'mm', 'c', 'h', 'cc',
	'cpp', 'cxx', 'hpp', 'hh', 'cs', 'fs', 'rb', 'php', 'lua', 'dart', 'ex', 'exs', 'erl', 'hs', 'ml', 'clj', 'r', 'jl', 'zig', 'nim',
	'vue', 'svelte', 'astro', 'sh', 'bash', 'zsh', 'ps1', 'sql', 'proto', 'graphql', 'gql', 'css', 'scss', 'less', 'html',
]);

/**
 * The order files are indexed in, so the file and size limits drop the least useful files first:
 * source code, then docs and config, then tests and fixtures; alphabetical within each, which keeps
 * folders together.
 */
export function compareForIndexing(a: string, b: string): number {
	const rank = (path: string) => isSecondaryPath(path) ? 2 : CODE_EXTENSIONS.has(path.slice(path.lastIndexOf('.') + 1).toLowerCase()) ? 0 : 1;
	return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
}

function lowerBound(ids: readonly number[], id: number): number {
	let low = 0;
	let high = ids.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (ids[mid] < id) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	return low;
}

/**
 * The codebase index: BM25 term statistics for every chunk of every indexed file, plus optional
 * embeddings. Kept in memory without the text; files are added, replaced and removed one at a time.
 */
export class CodebaseIndex {
	private nextId = 1;
	private readonly chunks = new Map<number, IndexedChunk>();
	private readonly files = new Map<string, number[]>();
	private readonly termIds = new Map<string, number>();
	private readonly postings: Posting[] = [];
	private totalLength = 0;

	get fileCount(): number {
		return this.files.size;
	}

	get chunkCount(): number {
		return this.chunks.size;
	}

	hasFile(path: string): boolean {
		return this.files.has(path);
	}

	paths(): string[] {
		return [...this.files.keys()];
	}

	private termId(term: string): number {
		let id = this.termIds.get(term);
		if (id === undefined) {
			id = this.postings.length;
			this.termIds.set(term, id);
			this.postings.push({ ids: [], tfs: [] });
		}
		return id;
	}

	/** Indexes a file, replacing what was there. Returns the new chunks with their text, for embedding. */
	setFile(path: string, text: string): Chunk[] {
		this.removeFile(path);
		const chunks = chunkFile(path, text);
		const ids: number[] = [];
		const slash = path.lastIndexOf('/');
		const fromName = pathTerms(path.slice(slash + 1));
		const fromFolders = slash > 0 ? pathTerms(path.slice(0, slash)) : [];
		for (const chunk of chunks) {
			const id = this.nextId++;
			const counts = new Map<string, number>();
			for (const term of tokenize(chunk.text)) {
				counts.set(term, (counts.get(term) ?? 0) + 1);
			}
			for (const term of new Set(fromFolders)) {
				counts.set(term, (counts.get(term) ?? 0) + FOLDER_WEIGHT);
			}
			for (const term of new Set(fromName)) {
				counts.set(term, (counts.get(term) ?? 0) + NAME_WEIGHT);
			}
			let length = 0;
			const terms = new Uint32Array(counts.size);
			let i = 0;
			for (const [term, count] of counts) {
				length += count;
				const termId = this.termId(term);
				terms[i++] = termId;
				const posting = this.postings[termId];
				posting.ids.push(id);
				posting.tfs.push(count);
			}
			this.chunks.set(id, { path, startLine: chunk.startLine, endLine: chunk.endLine, id, length, terms });
			this.totalLength += length;
			ids.push(id);
		}
		this.files.set(path, ids);
		return chunks;
	}

	removeFile(path: string): void {
		const ids = this.files.get(path);
		if (!ids) {
			return;
		}
		for (const id of ids) {
			const chunk = this.chunks.get(id);
			if (!chunk) {
				continue;
			}
			for (const termId of chunk.terms) {
				const posting = this.postings[termId];
				const at = lowerBound(posting.ids, id);
				if (posting.ids[at] === id) {
					posting.ids.splice(at, 1);
					posting.tfs.splice(at, 1);
				}
			}
			this.totalLength -= chunk.length;
			this.chunks.delete(id);
		}
		this.files.delete(path);
	}

	/** Attaches embeddings to a file's chunks, in chunk order. */
	setVectors(path: string, vectors: readonly (readonly number[] | undefined)[]): void {
		(this.files.get(path) ?? []).forEach((id, index) => {
			const chunk = this.chunks.get(id);
			const vector = vectors[index];
			if (chunk && vector) {
				chunk.vector = normalize(vector);
			}
		});
	}

	/** Attaches one already-normalized embedding to the chunk at `position` in the file's chunk order. */
	setVector(path: string, position: number, vector: Float32Array): void {
		const id = this.files.get(path)?.[position];
		const chunk = id === undefined ? undefined : this.chunks.get(id);
		if (chunk) {
			chunk.vector = vector;
		}
	}

	chunkCountOf(path: string): number {
		return this.files.get(path)?.length ?? 0;
	}

	/** Positions (in chunk order) of a file's chunks that have no embedding yet. */
	missingVectors(path: string): number[] {
		const missing: number[] = [];
		(this.files.get(path) ?? []).forEach((id, index) => {
			if (!this.chunks.get(id)?.vector) {
				missing.push(index);
			}
		});
		return missing;
	}

	get embeddedCount(): number {
		let count = 0;
		for (const chunk of this.chunks.values()) {
			count += chunk.vector ? 1 : 0;
		}
		return count;
	}

	/** Drops every embedding, e.g. when the embedding model changes. */
	clearVectors(): void {
		for (const chunk of this.chunks.values()) {
			chunk.vector = undefined;
		}
	}

	private keywordRanking(query: string, allowed: (chunk: IndexedChunk) => boolean, depth: number): number[] {
		const terms = queryTerms(query);
		if (!terms.length || !this.chunks.size) {
			return [];
		}
		const n = this.chunks.size;
		const averageLength = this.totalLength / n;
		const scores = new Map<number, number>();
		for (const term of terms) {
			const termId = this.termIds.get(term);
			const posting = termId === undefined ? undefined : this.postings[termId];
			if (!posting?.ids.length) {
				continue;
			}
			const df = posting.ids.length;
			const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
			for (let i = 0; i < df; i++) {
				const id = posting.ids[i];
				const chunk = this.chunks.get(id)!;
				const tf = posting.tfs[i];
				scores.set(id, (scores.get(id) ?? 0) + idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * chunk.length / averageLength)));
			}
		}

		// File-level evidence: the best chunk of a file that keeps matching beats a lone mention.
		const byFile = new Map<string, number[]>();
		for (const [id, score] of scores) {
			const chunk = this.chunks.get(id)!;
			if (!allowed(chunk)) {
				scores.delete(id);
				continue;
			}
			const weighted = isSecondaryPath(chunk.path) ? score * SECONDARY_WEIGHT : score;
			scores.set(id, weighted);
			let list = byFile.get(chunk.path);
			if (!list) {
				list = [];
				byFile.set(chunk.path, list);
			}
			list.push(weighted);
		}
		const fileBonus = new Map<string, number>();
		for (const [path, list] of byFile) {
			if (list.length > 1) {
				list.sort((a, b) => b - a);
				let rest = 0;
				for (let i = 1; i < Math.min(list.length, 6); i++) {
					rest += list[i];
				}
				fileBonus.set(path, FILE_EVIDENCE * rest / Math.min(list.length - 1, 5));
			}
		}
		const final: [number, number][] = [];
		for (const [id, score] of scores) {
			final.push([id, score + (fileBonus.get(this.chunks.get(id)!.path) ?? 0)]);
		}
		return final.sort((a, b) => b[1] - a[1]).slice(0, depth).map(([id]) => id);
	}

	private semanticRanking(queryVector: readonly number[], allowed: (chunk: IndexedChunk) => boolean, depth: number): number[] {
		const query = normalize(queryVector);
		const scored: [number, number][] = [];
		for (const chunk of this.chunks.values()) {
			if (chunk.vector && allowed(chunk)) {
				scored.push([chunk.id, dot(query, chunk.vector)]);
			}
		}
		return scored.sort((a, b) => b[1] - a[1]).slice(0, depth).map(([id]) => id);
	}

	/** Keyword search, fused with semantic search when a query vector is given. */
	search(query: string, options: SearchOptions = {}): SearchHit[] {
		const limit = options.limit ?? 10;
		const perFileLimit = options.perFile ?? 2;
		const prefixes = options.pathPrefixes?.filter(Boolean);
		const allowed = (chunk: IndexedChunk) => !prefixes?.length || prefixes.some(prefix => chunk.path.startsWith(prefix));
		const depth = Math.max(100, limit * 10);
		const keyword = this.keywordRanking(query, allowed, depth);
		const semantic = options.queryVector ? this.semanticRanking(options.queryVector, allowed, depth) : [];
		const fused = fuse(semantic.length ? [keyword, semantic] : [keyword]);
		const inKeyword = new Set(keyword);
		const inSemantic = new Set(semantic);

		const hits: SearchHit[] = [];
		const perFile = new Map<string, number>();
		for (const [id, score] of [...fused.entries()].sort((a, b) => b[1] - a[1])) {
			const chunk = this.chunks.get(id)!;
			const count = perFile.get(chunk.path) ?? 0;
			if (count >= perFileLimit) {
				continue;
			}
			perFile.set(chunk.path, count + 1);
			hits.push({
				chunk: { path: chunk.path, startLine: chunk.startLine, endLine: chunk.endLine },
				score,
				via: [...(inKeyword.has(id) ? ['keyword' as const] : []), ...(inSemantic.has(id) ? ['semantic' as const] : [])],
			});
			if (hits.length >= limit) {
				break;
			}
		}
		return hits;
	}
}
