/**
 * Retrieval, kept separate per representation kind. Dense and sparse lists are returned side by
 * side, never fused into one score: the two miss different things and a fused number would hide
 * which one produced a hit.
 *
 * Three indexes exist because the recipes differ, not because the store differs:
 *   request      request text only
 *   project      project-summary text only
 *   contextual   request + summary under one explicit recipe
 */
import { type Db } from "./db.ts";
import { bm25, cosine, encodeDense, encodeSparse, loadDense, loadSparse, type EncoderSpec } from "./embed.ts";
import { encodeRemoteBatch, type QueuedEncoder } from "./jobs.ts";
import { id as ids, sha256 } from "./ids.ts";
import { insert } from "./db.ts";

export interface ConsultHit {
	representationId: string;
	assignmentId: string | null;
	score: number;
	decision: { model: string; tier: string; action: string; decisionId: string } | null;
	outcome: { label: string | null; task: string | null; reasons: unknown } | null;
}

export interface ConsultResult {
	encoder: string;
	querySha256: string;
	index: string;
	dense: ConsultHit[];
	sparse: ConsultHit[];
	scanned: number;
	ms: number;
}

export interface ConsultOpts {
	text: string;
	index?: "request" | "project" | "contextual";
	k?: number;
	encoders: (EncoderSpec | QueuedEncoder)[];
	/** Dense encoder to score with. Falls back to one that already has rows. */
	encoder?: string | null;
	/** Injected for tests; defaults to global fetch. */
	fetchImpl?: typeof fetch;
	projectId?: string | null;
}

const RECIPE_OF: Record<string, string> = { request: "request-text", project: "project-summary", contextual: "contextual" };

type Row = { representation_id: string; encoder_id: string; encoder_version: string; vector: Uint8Array; dim: number; assignment_id: string | null };

function decorate(db: Db, hits: { representationId: string; score: number }[]): ConsultHit[] {
	const out: ConsultHit[] = [];
	for (const h of hits) {
		const link = db
			.prepare("select assignment_id from representation_links where representation_id = ?")
			.get(h.representationId) as { assignment_id: string | null } | undefined;
		const assignmentId = link?.assignment_id ?? null;
		let decision: ConsultHit["decision"] = null;
		let outcome: ConsultHit["outcome"] = null;
		if (assignmentId) {
			const d = db
				.prepare("select decision_id, model, tier, action from decisions where assignment_id = ? order by created_utc desc limit 1")
				.get(assignmentId) as { decision_id: string; model: string; tier: string; action: string } | undefined;
			if (d) decision = { decisionId: d.decision_id, model: d.model, tier: d.tier, action: d.action };
			const o = db
				.prepare("select value_json from observations where assignment_id = ? and kind = 'outcome' limit 1")
				.get(assignmentId) as { value_json: string } | undefined;
			if (o) {
				const v = JSON.parse(o.value_json) as { label?: string; task?: string; reasons?: unknown };
				outcome = { label: v.label ?? null, task: v.task ?? null, reasons: v.reasons ?? null };
			}
		}
		out.push({ ...h, assignmentId, decision, outcome });
	}
	return out;
}

export async function consult(db: Db, opts: ConsultOpts): Promise<ConsultResult> {
	const t0 = performance.now();
	const recipeId = RECIPE_OF[opts.index ?? "request"];
	const k = opts.k ?? 8;
	const sparseSpec = opts.encoders.find((e) => e.kind === "sparse");
	const denseCandidates = opts.encoders.filter((e) => e.kind === "dense");
	if (!denseCandidates.length) throw new Error("consult: no dense encoder configured");
	const hasRows = (id: string) =>
		Number((db.prepare("select count(*) n from representations where encoder_id = ? and recipe_id = ?").get(id, recipeId) as { n: number }).n) > 0;
	const wanted = opts.encoder ? denseCandidates.find((e) => e.id === opts.encoder) : undefined;
	const denseSpec = (wanted && hasRows(wanted.id) ? wanted : denseCandidates.find((e) => hasRows(e.id))) ?? wanted ?? denseCandidates[0];
	if (denseSpec.kind !== "dense") throw new Error("consult: dense encoder has the wrong kind");

	const rows = db
		.prepare(
			`select r.representation_id, r.encoder_id, r.encoder_version, r.vector, r.dim, l.assignment_id
         from representations r
         left join representation_links l on l.representation_id = r.representation_id
         where r.recipe_id = ?`,
		)
		.all(recipeId) as Row[];

	// The query must be produced by the same backend that produced the stored vectors. Encoders are
	// not interchangeable: hash-ngram's feature hashing and a transformer produce different spaces.
	const spec = denseSpec as QueuedEncoder;
	const qv =
		(spec.backend ?? "local") === "http"
			? (await encodeRemoteBatch(spec, [opts.text], opts.fetchImpl ?? fetch))[0]
			: encodeDense(denseSpec as never, opts.text);
	const dense = rows
		.filter((r) => r.encoder_id === denseSpec.id)
		.map((r) => ({
			representationId: r.representation_id,
			score: Math.round(cosine(qv, floatsOf(r.vector)) * 10000) / 10000,
		}))
		.sort((a, b) => b.score - a.score)
		.slice(0, k);

	let sparse: { representationId: string; score: number }[] = [];
	if (sparseSpec && sparseSpec.kind === "sparse") {
		sparse = bm25(
			opts.text,
			rows
				.filter((r) => r.encoder_id === sparseSpec.id)
				.map((r) => ({ representationId: r.representation_id, terms: loadSparse(db, r.representation_id) ?? new Map() })),
		)
			.slice(0, k)
			.map((h) => ({ representationId: h.representationId, score: Math.round(h.score * 10000) / 10000 }));
	}

	const ms = performance.now() - t0;
	const querySha256 = sha256("query", opts.text);
	insert(db, "retrievals", {
		retrieval_id: ids.retrieval(querySha256, opts.index ?? "request", `dense:${denseSpec.id}@${denseSpec.version}`),
		query_sha256: querySha256,
		index_name: opts.index ?? "request",
		method: `dense:${denseSpec.id}@${denseSpec.version}+sparse:${sparseSpec?.id ?? "none"}`,
		filters_json: JSON.stringify({ recipe: recipeId, project: opts.projectId ?? null }),
		returned_json: JSON.stringify({ dense, sparse }),
		ms: Math.round(ms * 10) / 10,
		created_utc: new Date().toISOString(),
	});
	return {
		encoder: `${denseSpec.id}@${denseSpec.version}`,
		querySha256,
		index: opts.index ?? "request",
		dense: decorate(db, dense),
		sparse: decorate(db, sparse),
		scanned: rows.length,
		ms: Math.round(ms * 10) / 10,
	};
}

/** BLOBs come back as Uint8Array views; copy so the Float32Array starts at a 4-byte boundary. */
function floatsOf(bytes: Uint8Array): Float32Array {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return new Float32Array(copy.buffer);
}

export const _unusedLoaders = { loadDense, loadSparse, encodeSparse };
