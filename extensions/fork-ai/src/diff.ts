/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

// Line diff for inline edits. The review shows each change as the old lines (red) followed by the
// new lines (green), both in the document, so every change can be accepted or rejected on its own.

export type DiffOp =
	| { readonly type: 'equal'; readonly line: string }
	| { readonly type: 'removed'; readonly line: string }
	| { readonly type: 'added'; readonly line: string };

/** Myers diff over lines: the shortest edit script, so unchanged lines stay unchanged. */
export function diffLines(before: readonly string[], after: readonly string[]): DiffOp[] {
	const n = before.length;
	const m = after.length;
	const max = n + m;
	const offset = max;
	const v = new Array<number>(2 * max + 2).fill(0);
	const trace: number[][] = [];

	outer:
	for (let d = 0; d <= max; d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
			let y = x - k;
			while (x < n && y < m && before[x] === after[y]) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) {
				trace.push(v.slice());
				break outer;
			}
		}
	}

	// Walk the trace backwards to recover the script.
	const ops: DiffOp[] = [];
	let x = n;
	let y = m;
	for (let d = trace.length - 2; d >= 0 && (x > 0 || y > 0); d--) {
		const row = trace[d];
		const k = x - y;
		const prevK = k === -d || (k !== d && row[offset + k - 1] < row[offset + k + 1]) ? k + 1 : k - 1;
		const prevX = row[offset + prevK];
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			ops.push({ type: 'equal', line: before[--x] });
			y--;
		}
		if (d > 0) {
			if (x === prevX) {
				ops.push({ type: 'added', line: after[--y] });
			} else {
				ops.push({ type: 'removed', line: before[--x] });
			}
		}
	}
	return ops.reverse();
}

export interface Hunk {
	/** Offset of the hunk's first line in the combined layout. */
	readonly offset: number;
	readonly removed: number;
	readonly added: number;
}

export interface CombinedLayout {
	/** Unchanged lines, and each change as its old lines followed by its new lines. */
	readonly lines: string[];
	readonly hunks: Hunk[];
}

/** Lays out a review: runs of changes become hunks of removed-then-added lines. */
export function combine(before: readonly string[], after: readonly string[]): CombinedLayout {
	const ops = diffLines(before, after);
	const lines: string[] = [];
	const hunks: Hunk[] = [];
	let i = 0;
	while (i < ops.length) {
		if (ops[i].type === 'equal') {
			lines.push(ops[i].line);
			i++;
			continue;
		}
		const removed: string[] = [];
		const added: string[] = [];
		while (i < ops.length && ops[i].type !== 'equal') {
			(ops[i].type === 'removed' ? removed : added).push(ops[i].line);
			i++;
		}
		hunks.push({ offset: lines.length, removed: removed.length, added: added.length });
		lines.push(...removed, ...added);
	}
	return { lines, hunks };
}

/** Applies a decision to a combined layout; used by tests to check accept and reject round-trip. */
export function resolve(layout: CombinedLayout, decide: (hunk: Hunk, index: number) => 'accept' | 'reject'): string[] {
	const out: string[] = [];
	let cursor = 0;
	layout.hunks.forEach((hunk, index) => {
		out.push(...layout.lines.slice(cursor, hunk.offset));
		const removedLines = layout.lines.slice(hunk.offset, hunk.offset + hunk.removed);
		const addedLines = layout.lines.slice(hunk.offset + hunk.removed, hunk.offset + hunk.removed + hunk.added);
		out.push(...(decide(hunk, index) === 'accept' ? addedLines : removedLines));
		cursor = hunk.offset + hunk.removed + hunk.added;
	});
	out.push(...layout.lines.slice(cursor));
	return out;
}

/** Lines added and removed between two versions of a file, for the "files changed" summary. */
export function countChanges(before: string | null, after: string | null): { added: number; removed: number } {
	const split = (text: string | null) => text === null || text === '' ? [] : text.split(/\r?\n/);
	let added = 0;
	let removed = 0;
	for (const op of diffLines(split(before), split(after))) {
		if (op.type === 'added') {
			added++;
		} else if (op.type === 'removed') {
			removed++;
		}
	}
	return { added, removed };
}
