/**
 * The live adapter's writer. Narrow on purpose: it takes plain values, writes the same rows the CLI
 * writes, and imports nothing from ../router. The router calls it after it has already decided, so a
 * failure here can never change a routing decision — every call is wrapped by the caller.
 *
 * Encoding is not done here. It is enqueued: one insert per uncached representation, drained later by
 * `cli.ts embed`. That keeps the turn free of encoder latency, local or remote.
 */
import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { addContextItem } from "./admit.ts";
import { openDb, insert, type Db } from "./db.ts";
import { canonical, id as ids, sha256 } from "./ids.ts";
import { enqueue, type QueuedEncoder } from "./jobs.ts";
import { loadPipelineConfig, type PipelineConfig } from "./pipeline-config.ts";

export interface LiveAssessment {
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

export interface LiveTurn {
	/** pi session file name or id. */
	session: string | null;
	entryId: string | null;
	origin?: string | null;
	/** The exact user request text. */
	request: string;
	/** The card the router used, recorded verbatim as the decider input. */
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
	assessments?: LiveAssessment[];
	answers?: unknown;
	contractHash?: string | null;
	deciderBackend?: string | null;
	deciderMs?: number;
	decisionMs?: number;
	routerConfigVersion?: string | null;
	extraEncoders?: QueuedEncoder[];
}

export interface Recorded {
	assignmentId: string;
	decisionId: string;
	queued: number;
	already: number;
}

let cache: { db: Db; cfg: PipelineConfig; path: string } | null = null;

function recorder(): { db: Db; cfg: PipelineConfig } {
	if (cache) return cache;
	const cfg = loadPipelineConfig();
	const path = cfg.db.startsWith("~/") ? `${process.env.HOME}${cfg.db.slice(1)}` : cfg.db;
	const db = openDb(path);
	cache = { db, cfg, path };
	return cache;
}

/** Build the enqueue items for one assignment: request text, plus contextual text when a summary exists. */
export function embedItems(cfg: PipelineConfig, request: string, assignmentId: string, summary: string | null = null): Parameters<typeof enqueue>[1] {
	const items: Parameters<typeof enqueue>[1] = [];
	const texts: { recipe: { id: string; version: string }; text: string | null }[] = cfg.recipes.map((r) => {
		if (r.source === "request") return { recipe: r, text: request };
		if (r.source === "project_summary") return { recipe: r, text: summary };
		return { recipe: r, text: request && summary ? `${request}${r.join ?? "\n\n"}${summary}` : null };
	});
	for (const { recipe, text } of texts) {
		if (!text) continue;
		const clipped = text.slice(0, cfg.embed.max_chars);
		for (const enc of cfg.encoders) {
			if ((enc as { enabled?: boolean }).enabled === false) continue;
			items.push({ encoder: enc, recipe, text: clipped, source: { record: "assignment", id: assignmentId } });
		}
	}
	return items;
}

export function recordTurn(t: LiveTurn): Recorded {
	const { db, cfg } = recorder();
	const now = new Date().toISOString();
	const admission = `turn:${t.origin ?? "pi"}|${t.session ?? "unknown"}|${t.entryId ?? sha256("req", t.request)}`;
	const assignmentId = ids.assignment(admission);
	const projectKey = t.project ?? null;
	const projectId = projectKey ? ids.project(projectKey) : null;
	if (projectId && projectKey) {
		insert(db, "projects", { project_id: projectId, project_key: projectKey, name: projectKey, first_seen_utc: now });
	}
	insert(db, "assignments", {
		assignment_id: assignmentId,
		admission_key: admission,
		origin: t.origin ?? "pi",
		session: t.session,
		entry_id: t.entryId,
		project_id: projectId,
		parent_assignment_id: null,
		request_text: t.request,
		request_sha256: sha256("request", t.request),
		created_utc: now,
		config_id: cfg.version,
	});
	const input = canonical(t.card);
	const snapshotId = ids.snapshot("card-state", "1", input);
	insert(db, "snapshots", {
		snapshot_id: snapshotId,
		assignment_id: assignmentId,
		recipe_id: "card-state",
		recipe_version: "1",
		input_sha256: sha256("input", input),
		input_json: input,
		chars: input.length,
		created_utc: now,
	});
	insert(db, "snapshot_links", { snapshot_id: snapshotId, assignment_id: assignmentId, created_utc: now });

	if (t.assessments && t.assessments.length > 0) {
		for (let i = 0; i < t.assessments.length; i++) {
			const a = t.assessments[i];
			const contractHash = a.contractHash ?? t.contractHash ?? "none";
			const attempt = a.attempt ?? i + 1;
			insert(db, "assessments", {
				assessment_id: ids.assessment(assignmentId, snapshotId, "goal", a.backend ?? "none", contractHash, attempt),
				snapshot_id: snapshotId,
				assignment_id: assignmentId,
				role: "goal",
				backend: a.backend,
				model: a.model ?? null,
				contract: a.contract ?? "live-v2-axes",
				contract_hash: contractHash,
				attempt,
				started_utc: now,
				ms: a.ms,
				ok: a.ok ? 1 : 0,
				status: a.status ?? null,
				error: a.error ?? null,
				answers_json: a.answers ? JSON.stringify(a.answers) : null,
				raw_json: a.raw ? JSON.stringify(a.raw) : a.answers ? JSON.stringify(a.answers) : null,
			});
		}
	} else if (t.deciderBackend !== undefined) {
		const contractHash = t.contractHash ?? "none";
		insert(db, "assessments", {
			assessment_id: ids.assessment(assignmentId, snapshotId, "goal", t.deciderBackend ?? "none", contractHash, 1),
			snapshot_id: snapshotId,
			assignment_id: assignmentId,
			role: "goal",
			backend: t.deciderBackend,
			model: null,
			contract: "live-v2-axes",
			contract_hash: contractHash,
			attempt: 1,
			started_utc: now,
			ms: t.deciderMs ?? 0,
			ok: t.answers ? 1 : 0,
			status: null,
			error: null,
			answers_json: t.answers ? JSON.stringify(t.answers) : null,
			raw_json: t.answers ? JSON.stringify(t.answers) : null,
		});
	}

	const policyVersion = cfg.policy?.version ?? "v2-2026-10-28";
	const decisionId = ids.decision(
		assignmentId,
		snapshotId,
		"session",
		policyVersion,
		sha256("session", canonical({ model: t.model, rule: t.rule, basis: t.basis })),
	);
	insert(db, "decisions", {
		decision_id: decisionId,
		assignment_id: assignmentId,
		snapshot_id: snapshotId,
		policy_id: "session",
		policy_version: policyVersion,
		rule_id: t.rule,
		action: t.action ?? (t.basis === "session_keep" ? "keep" : t.rule.startsWith("pivot:") ? "pivot" : "initial"),
		model: t.model,
		provider: t.model.includes("/") ? t.model.slice(0, t.model.indexOf("/")) : "unknown",
		thinking: t.thinking,
		tier: t.tier,
		lane: null,
		reasons_json: JSON.stringify(t.reasons),
		propensity: 1,
		disagreement: t.disagreement ? 1 : 0,
		fallback: 0,
		decision_ms: t.decisionMs ?? 0,
		basis: t.basis,
		created_utc: now,
	});

	const environment = {
		node: process.version,
		platform: `${process.platform}/${process.arch}`,
		host: hostname(),
		pipeline_config: cfg.version,
		router_config: t.routerConfigVersion ?? null,
		encoders: cfg.encoders.filter((e) => (e as { enabled?: boolean }).enabled !== false).map((e) => `${e.id}@${e.version}:${e.backend ?? "local"}`),
		schema: 2,
	};
	insert(db, "observations", {
		observation_id: ids.observation(assignmentId, "environment", "pipeline-live", now, environment),
		assignment_id: assignmentId,
		kind: "environment",
		source: "pipeline-live",
		method: "recordTurn@1",
		at_utc: now,
		value_json: JSON.stringify(environment),
	});

	const q = enqueue(db, embedItems(cfg, t.request, assignmentId, t.projectSummary ?? null));
	if (t.projectSummary) {
		addContextItem(db, {
			projectId,
			kind: "project_summary",
			source: ".anchor/router-stub.md",
			text: t.projectSummary,
			now,
		});
	}
	return { assignmentId, decisionId, queued: q.queued, already: q.already };
}

/** Used by tests and by `cli.ts embed --drain`. */
export function openRecorderForTest(cfgPath: string) {
	const cfg = loadPipelineConfig(cfgPath);
	const db = openDb(":memory:");
	cache = { db, cfg, path: ":memory:" };
	return { db, cfg };
}

export { createHash };
