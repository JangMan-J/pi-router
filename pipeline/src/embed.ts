/**
 * Representations: one dense encoder, one sparse encoder, both versioned, both cached by
 * (encoder, version, recipe, version, input bytes).
 *
 * The shipped dense encoder is `hash-ngram@1`: signed feature hashing over word unigrams,
 * word bigrams and character 4-grams, 512 dims, L2-normalised. It is deterministic, needs no
 * network, no model download and no GPU, and it takes about 0.3 ms per 1k characters. It is a
 * lexical encoder, not a semantic one: swapping in a trained encoder means adding `encoder_id`
 * `bge-small-en-v15` or `qwen3-embedding-0.6b` with the same interface. Old vectors are never
 * compared to new ones because the encoder id and version are part of the cache key.
 *
 * The sparse encoder is `bm25@1`: a term-frequency map, scored with k1=1.2 b=0.75 at query time.
 * BM25 is not a model call and is recorded as its own method.
 */
import { createHash } from "node:crypto";
import { insert, type Db } from "./db.ts";
import { id as ids, sha256 } from "./ids.ts";

export interface DenseEncoderSpec {
	id: string;
	version: string;
	kind: "dense";
	dim: number;
}
export interface SparseEncoderSpec {
	id: string;
	version: string;
	kind: "sparse";
	max_terms: number;
}
export type EncoderSpec = DenseEncoderSpec | SparseEncoderSpec;

export interface EmbedHooks {
	/** Called once per real encode; tests use it to prove cache hits do not encode. */
	onEncode?: (spec: EncoderSpec, text: string) => void;
}

const WORD = /[\p{L}\p{N}_]+/gu;

export function tokenize(text: string): string[] {
	return (text.toLowerCase().normalize("NFKC").match(WORD) ?? []).filter((t) => t.length > 1 || /\d/.test(t));
}

/** FNV-1a, 32-bit. Deterministic across machines and languages, fast enough to run per feature. */
function hash32(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

export function encodeDense(spec: DenseEncoderSpec, text: string): Float32Array {
	const v = new Float32Array(spec.dim);
	const words = tokenize(text);
	const add = (feature: string, weight: number) => {
		const h = hash32(feature);
		const idx = h % spec.dim;
		const sign = (h >>> 31) === 1 ? -1 : 1;
		v[idx] += sign * weight;
	};
	for (let i = 0; i < words.length; i++) {
		add(`w:${words[i]}`, 1);
		if (i + 1 < words.length) add(`b:${words[i]}_${words[i + 1]}`, 0.5);
		const w = words[i];
		if (w.length >= 4) {
			for (let j = 0; j + 4 <= w.length && j < 12; j++) add(`c:${w.slice(j, j + 4)}`, 0.25);
		}
	}
	let norm = 0;
	for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
	norm = Math.sqrt(norm);
	if (norm > 0) for (let i = 0; i < v.length; i++) v[i] /= norm;
	return v;
}

export function encodeSparse(spec: SparseEncoderSpec, text: string): Map<string, number> {
	const tf = new Map<string, number>();
	for (const t of tokenize(text)) tf.set(t, (tf.get(t) ?? 0) + 1);
	if (tf.size <= spec.max_terms) return tf;
	const kept = [...tf.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, spec.max_terms);
	return new Map(kept);
}

export function cosine(a: Float32Array, b: Float32Array): number {
	let d = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) d += a[i] * b[i];
	return d;
}

export interface Represented {
	representationId: string;
	encoderId: string;
	encoderVersion: string;
	recipeId: string;
	recipeVersion: string;
	inputSha256: string;
	dim: number;
	cached: boolean;
	encodeMs: number;
}

/**
 * Get or create a representation. The cache key *is* the id, so a hit needs no vector compare and
 * two processes cannot write the same vector twice.
 */
export function represent(
	db: Db,
	spec: EncoderSpec,
	recipe: { id: string; version: string },
	text: string,
	source: { record: string; id: string },
	hooks: EmbedHooks = {},
): Represented {
	const inputSha = sha256("input", text);
	const representationId = ids.representation(spec.id, spec.version, recipe.id, recipe.version, text);
	const existing = db
		.prepare("select dim from representations where representation_id = ?")
		.get(representationId) as { dim: number } | undefined;
	if (existing) {
		insert(db, "representation_links", {
			representation_id: representationId,
			assignment_id: source.record === "assignment" ? source.id : null,
			snapshot_id: source.record === "snapshot" ? source.id : null,
			created_utc: new Date().toISOString(),
		});
		return {
			representationId,
			encoderId: spec.id,
			encoderVersion: spec.version,
			recipeId: recipe.id,
			recipeVersion: recipe.version,
			inputSha256: inputSha,
			dim: existing.dim,
			cached: true,
			encodeMs: 0,
		};
	}
	const t0 = performance.now();
	hooks.onEncode?.(spec, text);
	let dim: number;
	let vector: Uint8Array;
	if (spec.kind === "dense") {
		const v = encodeDense(spec, text);
		dim = v.length;
		vector = new Uint8Array(v.buffer.slice(0));
	} else {
		const tf = encodeSparse(spec, text);
		dim = tf.size;
		vector = new TextEncoder().encode(JSON.stringify([...tf.entries()]));
	}
	const encodeMs = performance.now() - t0;
	insert(db, "representations", {
		representation_id: representationId,
		encoder_id: spec.id,
		encoder_version: spec.version,
		recipe_id: recipe.id,
		recipe_version: recipe.version,
		input_sha256: inputSha,
		source_record: source.record,
		source_id: source.id,
		dim,
		vector,
		created_utc: new Date().toISOString(),
	});
	insert(db, "representation_links", {
		representation_id: representationId,
		assignment_id: source.record === "assignment" ? source.id : null,
		snapshot_id: source.record === "snapshot" ? source.id : null,
		created_utc: new Date().toISOString(),
	});
	return {
		representationId,
		encoderId: spec.id,
		encoderVersion: spec.version,
		recipeId: recipe.id,
		recipeVersion: recipe.version,
		inputSha256: inputSha,
		dim,
		cached: false,
		encodeMs,
	};
}

export function loadDense(db: Db, representationId: string): Float32Array | null {
	const row = db.prepare("select vector, dim from representations where representation_id = ?").get(representationId) as
		| { vector: Uint8Array; dim: number }
		| undefined;
	if (!row) return null;
	const copy = new Uint8Array(row.vector);
	return new Float32Array(copy.buffer, copy.byteOffset, row.dim);
}

export function loadSparse(db: Db, representationId: string): Map<string, number> | null {
	const row = db.prepare("select vector from representations where representation_id = ?").get(representationId) as
		| { vector: Uint8Array }
		| undefined;
	if (!row) return null;
	return new Map(JSON.parse(new TextDecoder().decode(row.vector)) as [string, number][]);
}

/** BM25 over the stored sparse maps. Corpus statistics come from the rows actually scored. */
export function bm25(
	query: string,
	docs: { representationId: string; terms: Map<string, number> }[],
	k1 = 1.2,
	b = 0.75,
): { representationId: string; score: number }[] {
	const q = tokenize(query);
	if (!q.length || !docs.length) return [];
	const df = new Map<string, number>();
	let totalLen = 0;
	for (const d of docs) {
		let len = 0;
		for (const [t, c] of d.terms) {
			len += c;
			if (q.includes(t)) df.set(t, (df.get(t) ?? 0) + 1);
		}
		totalLen += len;
	}
	const avgdl = totalLen / docs.length || 1;
	const N = docs.length;
	const scored = docs.map((d) => {
		let len = 0;
		for (const c of d.terms.values()) len += c;
		let score = 0;
		for (const t of q) {
			const tf = d.terms.get(t) ?? 0;
			if (!tf) continue;
			const n = df.get(t) ?? 0;
			const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
			score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * len) / avgdl));
		}
		return { representationId: d.representationId, score };
	});
	return scored.filter((s) => s.score > 0).sort((a, b2) => b2.score - a.score);
}

export function contentHash(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}
