/**
 * Durable encode queue.
 *
 * The live router must never wait for an encoder, and a remote encoder can fail or be down without
 * losing work. So an enqueue is one insert: the representation id is the cache key, the text is the
 * exact recipe output, and a worker drains the queue whenever it can. A job whose representation
 * already exists is never enqueued again (the id is the primary key).
 *
 * Local and remote encoders are interchangeable: `encodeText()` dispatches on the encoder's `backend`
 * field, and the encoder id plus version stay inside the representation id, so vectors from two
 * backends never mix in one index.
 */
import { insert, type Db } from "./db.ts";
import { encodeDense, encodeSparse, type EncoderSpec } from "./embed.ts";
import { id as ids, sha256 } from "./ids.ts";

export interface QueuedEncoder {
	id: string;
	version: string;
	kind: "dense" | "sparse";
	/** dense only */
	dim?: number;
	/** sparse only */
	max_terms?: number;
	/** "local" runs in process (hash-ngram, bm25); "http" calls a serving endpoint. */
	backend?: "local" | "http";
	api?: "ollama" | "tei" | "openai";
	url?: string;
	model?: string;
	timeout_ms?: number;
	/** A configured but switched-off encoder is skipped by enqueue and never drained. */
	enabled?: boolean;
	note?: string;
}

export interface EnqueueItem {
	encoder: QueuedEncoder;
	recipe: { id: string; version: string };
	text: string;
	source: { record: "assignment" | "snapshot"; id: string };
}

export function enqueue(db: Db, items: EnqueueItem[]): { queued: number; already: number } {
	let queued = 0;
	let already = 0;
	const now = new Date().toISOString();
	for (const item of items) {
		if (item.encoder.enabled === false) continue;
		const representationId = ids.representation(item.encoder.id, item.encoder.version, item.recipe.id, item.recipe.version, item.text);
		const exists =
			db.prepare("select 1 as x from representations where representation_id = ?").get(representationId) ??
			db.prepare("select 1 as x from embed_jobs where representation_id = ?").get(representationId);
		if (exists) {
			already++;
			continue;
		}
		insert(db, "embed_jobs", {
			job_id: `job_${sha256("job", representationId).slice(0, 16)}`,
			representation_id: representationId,
			encoder_id: item.encoder.id,
			encoder_version: item.encoder.version,
			recipe_id: item.recipe.id,
			recipe_version: item.recipe.version,
			input_sha256: sha256("input", item.text),
			text: item.text,
			source_record: item.source.record,
			source_id: item.source.id,
			status: "pending",
			attempts: 0,
			created_utc: now,
			updated_utc: now,
		});
		queued++;
	}
	return { queued, already };
}

/** Call a serving endpoint. Three shapes cover the usual local servers. */
export async function encodeRemote(spec: QueuedEncoder, text: string, fetchImpl: typeof fetch = fetch): Promise<Float32Array> {
	if (!spec.url) throw new Error(`encoder ${spec.id}: remote backend without a url`);
	const api = spec.api ?? "ollama";
	const timeout = AbortSignal.timeout(spec.timeout_ms ?? 5000);
	if (api === "ollama") {
		const res = await fetchImpl(`${spec.url.replace(/\/$/, "")}/api/embed`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: spec.model ?? spec.id, input: text }),
			signal: timeout,
		});
		if (!res.ok) throw new Error(`encoder ${spec.id}: HTTP ${res.status}`);
		const j = (await res.json()) as { embeddings?: number[][] };
		const v = j.embeddings?.[0];
		if (!v) throw new Error(`encoder ${spec.id}: no embedding in response`);
		return normalize(new Float32Array(v));
	}
	if (api === "tei") {
		const res = await fetchImpl(`${spec.url.replace(/\/$/, "")}/embed`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ inputs: text }),
			signal: timeout,
		});
		if (!res.ok) throw new Error(`encoder ${spec.id}: HTTP ${res.status}`);
		const j = (await res.json()) as number[][] | { embeddings: number[][] };
		const v = Array.isArray(j) ? j[0] : j.embeddings?.[0];
		if (!v) throw new Error(`encoder ${spec.id}: no embedding in response`);
		return normalize(new Float32Array(v));
	}
	const res = await fetchImpl(`${spec.url.replace(/\/$/, "")}/v1/embeddings`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: spec.model ?? spec.id, input: text }),
		signal: timeout,
	});
	if (!res.ok) throw new Error(`encoder ${spec.id}: HTTP ${res.status}`);
	const j = (await res.json()) as { data?: { embedding: number[] }[] };
	const v = j.data?.[0]?.embedding;
	if (!v) throw new Error(`encoder ${spec.id}: no embedding in response`);
	return normalize(new Float32Array(v));
}

/** One request for many texts. Ollama, TEI and OpenAI all accept an array on the same route. */
export async function encodeRemoteBatch(spec: QueuedEncoder, texts: string[], fetchImpl: typeof fetch = fetch): Promise<Float32Array[]> {
	if (!spec.url) throw new Error(`encoder ${spec.id}: remote backend without a url`);
	const api = spec.api ?? "ollama";
	const timeout = AbortSignal.timeout((spec.timeout_ms ?? 5000) * Math.max(1, Math.ceil(texts.length / 4)));
	const base = spec.url.replace(/\/$/, "");
	const json = { "content-type": "application/json" };
	if (api === "tei") {
		const res = await fetchImpl(`${base}/embed`, { method: "POST", headers: json, body: JSON.stringify({ inputs: texts }), signal: timeout });
		if (!res.ok) throw new Error(`encoder ${spec.id}: HTTP ${res.status}`);
		const j = (await res.json()) as number[][] | { embeddings: number[][] };
		const list = Array.isArray(j) ? j : j.embeddings;
		if (!list || list.length !== texts.length) throw new Error(`encoder ${spec.id}: ${list?.length ?? 0} embeddings for ${texts.length} inputs`);
		return list.map((v) => normalize(new Float32Array(v)));
	}
	if (api === "ollama") {
		const res = await fetchImpl(`${base}/api/embed`, { method: "POST", headers: json, body: JSON.stringify({ model: spec.model ?? spec.id, input: texts }), signal: timeout });
		if (!res.ok) throw new Error(`encoder ${spec.id}: HTTP ${res.status}`);
		const j = (await res.json()) as { embeddings?: number[][] };
		if (!j.embeddings || j.embeddings.length !== texts.length) throw new Error(`encoder ${spec.id}: ${j.embeddings?.length ?? 0} embeddings for ${texts.length} inputs`);
		return j.embeddings.map((v) => normalize(new Float32Array(v)));
	}
	const res = await fetchImpl(`${base}/v1/embeddings`, { method: "POST", headers: json, body: JSON.stringify({ model: spec.model ?? spec.id, input: texts }), signal: timeout });
	if (!res.ok) throw new Error(`encoder ${spec.id}: HTTP ${res.status}`);
	const j = (await res.json()) as { data?: { embedding: number[]; index?: number }[] };
	if (!j.data || j.data.length !== texts.length) throw new Error(`encoder ${spec.id}: ${j.data?.length ?? 0} embeddings for ${texts.length} inputs`);
	return j.data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => normalize(new Float32Array(d.embedding)));
}

function normalize(v: Float32Array): Float32Array {
	let n = 0;
	for (let i = 0; i < v.length; i++) n += v[i] * v[i];
	n = Math.sqrt(n);
	if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
	return v;
}

export function encodeLocal(spec: QueuedEncoder, text: string): { vector: Uint8Array; dim: number } {
	if (spec.kind === "dense") {
		const v = encodeDense({ id: spec.id, version: spec.version, kind: "dense", dim: spec.dim ?? 512 }, text);
		return { vector: new Uint8Array(v.buffer.slice(0)), dim: v.length };
	}
	const tf = encodeSparse({ id: spec.id, version: spec.version, kind: "sparse", max_terms: spec.max_terms ?? 512 }, text);
	return { vector: new TextEncoder().encode(JSON.stringify([...tf.entries()])), dim: tf.size };
}

export interface DrainResult {
	done: number;
	failed: number;
	encoded: { jobId: string; encoder: string; ms: number; cached: boolean }[];
}

/** Drain up to `limit` pending jobs. A failed job stays pending with its error and attempt count. */
export async function drain(
	db: Db,
	encoders: QueuedEncoder[],
	opts: { limit?: number; fetchImpl?: typeof fetch; batch?: number } = {},
): Promise<DrainResult> {
	const limit = opts.limit ?? 100;
	const batchSize = Math.max(1, opts.batch ?? 8);
	const rows = db
		.prepare("select * from embed_jobs where status = 'pending' order by created_utc limit ?")
		.all(limit) as Record<string, string | number>[];
	const byId = new Map(encoders.map((e) => [`${e.id}@${e.version}`, e]));
	const out: DrainResult = { done: 0, failed: 0, encoded: [] };
	const now = () => new Date().toISOString();

	const finish = (row: Record<string, string | number>, representationId: string, spec: QueuedEncoder, dim: number, vector: Uint8Array, ms: number) => {
		insert(db, "representations", {
			representation_id: representationId,
			encoder_id: String(row.encoder_id),
			encoder_version: String(row.encoder_version),
			recipe_id: String(row.recipe_id),
			recipe_version: String(row.recipe_version),
			input_sha256: String(row.input_sha256),
			source_record: String(row.source_record),
			source_id: String(row.source_id),
			dim,
			vector,
			created_utc: now(),
		});
		insert(db, "representation_links", {
			representation_id: representationId,
			assignment_id: row.source_record === "assignment" ? String(row.source_id) : null,
			snapshot_id: row.source_record === "snapshot" ? String(row.source_id) : null,
			created_utc: now(),
		});
		db.prepare("update embed_jobs set status = 'done', attempts = attempts + 1, updated_utc = ? where job_id = ?").run(now(), String(row.job_id));
		out.done++;
		out.encoded.push({ jobId: String(row.job_id), encoder: `${spec.id}@${spec.version}`, ms, cached: false });
	};

	// Group by encoder so an HTTP backend gets one request for many texts instead of one each.
	const groups = new Map<string, { spec: QueuedEncoder; rows: Record<string, string | number>[] }>();
	for (const row of rows) {
		const spec = byId.get(`${row.encoder_id}@${row.encoder_version}`);
		if (!spec) {
			db.prepare("update embed_jobs set status = 'failed', error = ?, attempts = attempts + 1, updated_utc = ? where job_id = ?").run("encoder not configured", now(), String(row.job_id));
			out.failed++;
			continue;
		}
		const key = `${spec.id}@${spec.version}`;
		const g = groups.get(key) ?? { spec, rows: [] };
		g.rows.push(row);
		groups.set(key, g);
	}

	for (const { spec, rows: groupRows } of groups.values()) {
		const isHttp = (spec.backend ?? "local") === "http";
		for (let i = 0; i < groupRows.length; i += batchSize) {
			const chunk = groupRows.slice(i, i + batchSize);
			const t0 = performance.now();
			try {
				if (isHttp) {
					const vectors = await encodeRemoteBatch(spec, chunk.map((r) => String(r.text)), opts.fetchImpl ?? fetch);
					const ms = Math.round((performance.now() - t0) * 10) / 10;
					chunk.forEach((row, k) => {
						const v = vectors[k];
						finish(row, String(row.representation_id), spec, v.length, new Uint8Array(v.buffer.slice(0)), ms / chunk.length);
					});
				} else {
					for (const row of chunk) {
						const representationId = String(row.representation_id);
						const exists = db.prepare("select dim, vector from representations where representation_id = ?").get(representationId) as { dim: number; vector: Uint8Array } | undefined;
						if (exists) {
							db.prepare("update embed_jobs set status = 'done', attempts = attempts + 1, updated_utc = ? where job_id = ?").run(now(), String(row.job_id));
							out.done++;
							out.encoded.push({ jobId: String(row.job_id), encoder: `${spec.id}@${spec.version}`, ms: 0, cached: true });
							continue;
						}
						const t1 = performance.now();
						const r = encodeLocal(spec, String(row.text));
						finish(row, representationId, spec, r.dim, r.vector, Math.round((performance.now() - t1) * 100) / 100);
					}
				}
			} catch (e) {
				for (const row of chunk) {
					db.prepare("update embed_jobs set status = 'pending', error = ?, attempts = attempts + 1, updated_utc = ? where job_id = ?").run(
						String((e as Error)?.message ?? e).slice(0, 300),
						now(),
						String(row.job_id),
					);
					out.failed++;
				}
			}
		}
	}
	return out;
}
