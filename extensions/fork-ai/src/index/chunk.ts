/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

export interface Chunk {
	readonly path: string;
	/** 1-based, inclusive. */
	readonly startLine: number;
	readonly endLine: number;
	readonly text: string;
}

export const TARGET_LINES = 60;
export const MAX_LINES = 120;
export const MAX_CHUNK_CHARS = 4000;
const OVERLAP_LINES = 8;

/**
 * A line that starts a top-level unit in most languages: a declaration at column 0, or a test
 * block. Chunks break before these lines so a function stays together.
 */
const TOP_LEVEL_START = /^(export\s+|pub(\(\w+\))?\s+|async\s+|static\s+|public\s+|private\s+|protected\s+|internal\s+|abstract\s+|final\s+|default\s+|declare\s+)*(function\*?|class|interface|type|enum|const|let|var|def|fn|func|struct|impl|trait|module|namespace|object|record|package|mod|macro_rules!|@\w+|describe|it|test|suite)\b/;

function isBoundary(line: string): boolean {
	return TOP_LEVEL_START.test(line) || /^#{1,3} /.test(line);
}

/** Splits a run of lines into windows of at most MAX_LINES / MAX_CHUNK_CHARS, overlapping a little. */
function windows(lines: readonly string[], first: number, last: number): [number, number][] {
	const out: [number, number][] = [];
	let start = first;
	while (start <= last) {
		let end = start;
		let chars = 0;
		while (end <= last && end - start < MAX_LINES && chars + lines[end].length < MAX_CHUNK_CHARS) {
			chars += lines[end].length + 1;
			end++;
		}
		end = Math.max(end - 1, start);
		out.push([start, end]);
		if (end >= last) {
			break;
		}
		start = Math.max(end + 1 - OVERLAP_LINES, start + 1);
	}
	return out;
}

/**
 * Splits a file into chunks along top-level declarations, packing small neighbours together up
 * to TARGET_LINES and cutting long units into overlapping windows.
 */
export function chunkFile(path: string, text: string): Chunk[] {
	const lines = text.split(/\r?\n/);
	if (lines.length && lines[lines.length - 1] === '') {
		lines.pop();
	}
	if (!lines.length) {
		return [];
	}

	// Units: [start, end] line ranges that begin at a boundary.
	const units: [number, number][] = [];
	let unitStart = 0;
	for (let i = 1; i < lines.length; i++) {
		if (isBoundary(lines[i]) && i > unitStart) {
			units.push([unitStart, i - 1]);
			unitStart = i;
		}
	}
	units.push([unitStart, lines.length - 1]);

	// Pack small units together; split big ones.
	const ranges: [number, number][] = [];
	let packStart = -1;
	let packEnd = -1;
	const flush = () => {
		if (packStart !== -1) {
			ranges.push(...windows(lines, packStart, packEnd));
			packStart = packEnd = -1;
		}
	};
	for (const [start, end] of units) {
		const size = end - start + 1;
		if (size > TARGET_LINES) {
			flush();
			ranges.push(...windows(lines, start, end));
			continue;
		}
		if (packStart !== -1 && end - packStart + 1 > TARGET_LINES) {
			flush();
		}
		if (packStart === -1) {
			packStart = start;
		}
		packEnd = end;
	}
	flush();

	return ranges
		.map(([start, end]) => ({ path, startLine: start + 1, endLine: end + 1, text: lines.slice(start, end + 1).join('\n') }))
		.filter(chunk => chunk.text.trim().length > 0);
}
