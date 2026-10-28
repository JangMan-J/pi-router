/**
 * Best-effort bridge to the pipeline record store.
 *
 * The router must never fail because of bookkeeping, and the router must not depend on the pipeline
 * at load time (the store, its SQLite driver and its config may be absent on another machine). So the
 * import is dynamic, cached, and every failure is swallowed after one warning.
 *
 * Encoding is enqueued by the pipeline, not performed here; the turn pays one insert, not a model call.
 */
export interface LiveAssessmentRecord {
	backend: string | null;
	model?: string | null;
	contract?: string;
	contractHash: string;
	attempt?: number;
	ms: number;
	ok: boolean;
	status?: number | null;
	error?: string | null;
	answers?: unknown;
	raw?: unknown;
}

export interface LiveTurnRecord {
	session: string | null;
	entryId: string | null;
	request: string;
	card: unknown;
	project?: string | null;
	projectSummary?: string | null;
	model: string;
	thinking: string;
	tier: string;
	action?: "initial" | "pivot" | "keep";
	basis: "judgement" | "declared" | "explicit" | "session_keep";
	rule: string;
	reasons: string[];
	disagreement?: boolean;
	assessments?: LiveAssessmentRecord[];
	answers?: unknown;
	contractHash?: string | null;
	deciderBackend?: string | null;
	deciderMs?: number;
	decisionMs?: number;
	routerConfigVersion?: string | null;
}

type Recorder = (turn: LiveTurnRecord) => unknown;

let loader: Promise<Recorder | null> | null = null;
let warned = false;

async function load(): Promise<Recorder | null> {
	if (loader) return loader;
	loader = (async () => {
		try {
			// @ts-ignore -- the pipeline is a sibling package; it may not exist on every machine.
			const mod = await import("../../pipeline/src/record.ts");
			return mod.recordTurn as Recorder;
		} catch (e) {
			return null;
		}
	})();
	return loader;
}

/** Record one turn. Never throws. */
export async function recordLiveTurn(turn: LiveTurnRecord): Promise<void> {
	if (process.env.PIPELINE_RECORDS === "off") return;
	try {
		const record = await load();
		if (!record) {
			if (!warned) {
				warned = true;
				console.warn("router/auto: pipeline store unavailable; routing continues without records");
			}
			return;
		}
		record(turn);
	} catch (e) {
		if (!warned) {
			warned = true;
			console.warn(`router/auto: record failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
		}
	}
}
