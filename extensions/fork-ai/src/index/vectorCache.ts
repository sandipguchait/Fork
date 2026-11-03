/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';

// Embeddings cached on disk by content hash, so a restart or a reindex embeds only what changed.
// Layout: "FKV1", u32 header length, JSON header {model, dims, count}, count 20-byte SHA-1 hashes,
// then count × dims little-endian float32 values.

const MAGIC = 'FKV1';
const HASH_BYTES = 20;

export function contentHash(text: string): string {
	return createHash('sha1').update(text).digest('hex');
}

export interface VectorCacheData {
	readonly model: string;
	readonly dims: number;
	readonly vectors: Map<string, Float32Array>;
}

export function encodeVectorCache(model: string, vectors: ReadonlyMap<string, Float32Array>): Uint8Array {
	const entries = [...vectors].filter(([hash]) => /^[0-9a-f]{40}$/.test(hash));
	const dims = entries[0]?.[1].length ?? 0;
	const usable = entries.filter(([, vector]) => vector.length === dims);
	const header = Buffer.from(JSON.stringify({ model, dims, count: usable.length }), 'utf8');
	const out = Buffer.alloc(8 + header.length + usable.length * (HASH_BYTES + dims * 4));
	out.write(MAGIC, 0, 'latin1');
	out.writeUInt32LE(header.length, 4);
	header.copy(out, 8);
	let offset = 8 + header.length;
	for (const [hash] of usable) {
		Buffer.from(hash, 'hex').copy(out, offset);
		offset += HASH_BYTES;
	}
	for (const [, vector] of usable) {
		for (const value of vector) {
			out.writeFloatLE(value, offset);
			offset += 4;
		}
	}
	return new Uint8Array(out.buffer, out.byteOffset, out.length);
}

/** Undefined when the bytes are not a cache this version wrote, or are cut short. */
export function decodeVectorCache(bytes: Uint8Array): VectorCacheData | undefined {
	const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (data.length < 8 || data.toString('latin1', 0, 4) !== MAGIC) {
		return undefined;
	}
	const headerLength = data.readUInt32LE(4);
	let header: { model?: unknown; dims?: unknown; count?: unknown };
	try {
		header = JSON.parse(data.toString('utf8', 8, 8 + headerLength));
	} catch {
		return undefined;
	}
	const { model, dims, count } = header;
	if (typeof model !== 'string' || typeof dims !== 'number' || typeof count !== 'number') {
		return undefined;
	}
	let offset = 8 + headerLength;
	if (data.length < offset + count * (HASH_BYTES + dims * 4)) {
		return undefined;
	}
	const hashes: string[] = [];
	for (let i = 0; i < count; i++) {
		hashes.push(data.toString('hex', offset, offset + HASH_BYTES));
		offset += HASH_BYTES;
	}
	const vectors = new Map<string, Float32Array>();
	for (const hash of hashes) {
		const vector = new Float32Array(dims);
		for (let d = 0; d < dims; d++) {
			vector[d] = data.readFloatLE(offset);
			offset += 4;
		}
		vectors.set(hash, vector);
	}
	return { model, dims, vectors };
}
