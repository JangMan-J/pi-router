/**
 * Stable identifiers.
 *
 * Every id is derived from the bytes it names, so two machines, two languages and two future
 * routers compute the same id for the same record. Nothing here reads a clock or a counter.
 *
 *   assignment    asg_<16>  admission event: origin + session + entry (or an explicit key)
 *   project       prj_<12>  project identity: a stable key, not a path
 *   snapshot      snp_<16>  exact input submitted: recipe + canonical bytes
 *   assessment    asm_<16>  one decider's answer to one snapshot
 *   decision      dec_<16>  the policy's output for one assignment + snapshot
 *   representation emb_<16> encoder + version + recipe + input bytes (the cache key itself)
 *   observation   obs_<16>  one later fact about one assignment
 *   retrieval     ret_<16>  one query against one index with one method
 *
 * The 16 hex characters are sha256 truncation. Collision probability is irrelevant at these
 * volumes; if a collision is ever suspected, recompute and compare the full hash stored beside it.
 */
import { createHash } from "node:crypto";

export function sha256(...parts: string[]): string {
	const h = createHash("sha256");
	for (const p of parts) {
		h.update(p);
		h.update("\u0000");
	}
	return h.digest("hex");
}

export function short(hex: string, n = 16): string {
	return hex.slice(0, n);
}

/** Canonical JSON: sorted keys, no whitespace, undefined dropped. Same bytes on every machine. */
export function canonical(value: unknown): string {
	const walk = (v: unknown): unknown => {
		if (v === null || typeof v !== "object") return v === undefined ? null : v;
		if (Array.isArray(v)) return v.map(walk);
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(v as Record<string, unknown>).sort()) {
			const w = walk((v as Record<string, unknown>)[k]);
			if (w !== null || (v as Record<string, unknown>)[k] === null) out[k] = w;
		}
		return out;
	};
	return JSON.stringify(walk(value));
}

export const id = {
	assignment: (admissionKey: string) => `asg_${short(sha256("assignment", "v1", admissionKey))}`,
	project: (projectKey: string) => `prj_${short(sha256("project", "v1", projectKey), 12)}`,
	snapshot: (recipeId: string, recipeVersion: string, input: string) =>
		`snp_${short(sha256("snapshot", "v1", `${recipeId}@${recipeVersion}`, input))}`,
	assessment: (assignmentId: string, snapshotId: string, role: string, backend: string, contractHash: string, attempt: number) =>
		`asm_${short(sha256("assessment", "v1", assignmentId, snapshotId, role, backend, contractHash, String(attempt)))}`,
	decision: (assignmentId: string, snapshotId: string, policyId: string, policyVersion: string, answersDigest: string) =>
		`dec_${short(sha256("decision", "v1", assignmentId, snapshotId, policyId, policyVersion, answersDigest))}`,
	representation: (encoderId: string, encoderVersion: string, recipeId: string, recipeVersion: string, input: string) =>
		`emb_${short(sha256("representation", "v1", `${encoderId}@${encoderVersion}`, `${recipeId}@${recipeVersion}`, input))}`,
	observation: (assignmentId: string, kind: string, source: string, atIso: string, value: unknown) =>
		`obs_${short(sha256("observation", "v1", assignmentId, kind, source, atIso, canonical(value)))}`,
	retrieval: (query: string, index: string, method: string) =>
		`ret_${short(sha256("retrieval", "v1", query, index, method))}`,
};

/**
 * Admission key. A repeated delivery of the same event reuses the assignment; the same text from a
 * different event does not. Historical pi turns supply host/session/entry_id, which makes the
 * 6,633 saved outcome rows joinable to decisions made today.
 */
export function admissionKey(input: {
	origin?: string | null;
	session?: string | null;
	entryId?: string | null;
	request?: string | null;
	explicit?: string | null;
}): string {
	if (input.explicit) return `explicit:${input.explicit}`;
	if (input.session && input.entryId) return `turn:${input.origin ?? "?"}|${input.session}|${input.entryId}`;
	if (input.request != null) return `text:${sha256(input.request)}`;
	throw new Error("ids: an admission needs an explicit key, a session+entry, or request text");
}

/** Wilson 95% interval, so a 2-of-3 rate is not printed as 67%. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
	if (n === 0) return [0, 1];
	const p = k / n;
	const d = 1 + (z * z) / n;
	const c = p + (z * z) / (2 * n);
	const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
	return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}
