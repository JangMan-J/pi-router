/**
 * One routing pass: admit -> snapshot -> assess -> decide -> record -> embed.
 *
 * The decision path is what has to be sub-second, so it contains a paired concurrent decider
 * pass across two distinct model families and pure code for reconciliation and tier mapping.
 * Embeddings run after the decision is recorded and never gate it, which is the point of the
 * diagram: request, project-summary and contextualised representations are useful for calibration
 * and retrieval later, not for this turn's choice.
 */
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { loadPipelineConfig, type PipelineConfig } from "./pipeline-config.ts";
import { createHash } from "node:crypto";
import { type Config, globMatch, loadConfig, parseRef } from "../../router/src/config.ts";
import {
	activeBackends,
	type Answers,
	type AskPairResult,
	type AskResult,
	type Contract,
	Deciders,
	compactAnswers,
	loadContract,
	type PairAssessment,
} from "../../router/src/deciders.ts";
import { admit, addContextItem, cardSnapshot, recipeText, type Recipe } from "./admit.ts";
import { insert, type Db } from "./db.ts";
import { type EmbedHooks, represent, type EncoderSpec } from "./embed.ts";
import { admissionKey, canonical, id as ids, sha256 } from "./ids.ts";
import { enqueue } from "./jobs.ts";
import { selectInitial, sessionChoice, type SessionPick } from "./decide.ts";

export type { PipelineConfig };

/** A bench card: the fields of bench/data/*.jsonl the pipeline needs. */
export interface Card {
	id?: string;
	host?: string;
	session?: string;
	entry_id?: string;
	meta?: { current_model?: string | null; subagent?: boolean; turn0?: boolean; trouble?: boolean };
	state: {
		project?: string;
		user_message: string;
		signals?: { user_turn_index?: number; tool_errors_last_5?: number; repeated_error_fingerprint_count?: number };
		[key: string]: unknown;
	};
}

export type AskFn = (role: "goal", state: unknown, hasHistory: boolean) => Promise<AskResult | AskPairResult>;

export interface RouteDeps {
	db: Db;
	cfg: PipelineConfig;
	routerConfig: Config;
	contracts: { goal: Contract; axes?: Contract };
	ask: AskFn;
	available: (key: string) => boolean;
	embed: boolean;
	hooks?: EmbedHooks;
	now?: () => Date;
	level?: "low" | "medium" | "high";
	projectSummary?: { text: string; revision?: number } | null;
}

export { loadPipelineConfig } from "./pipeline-config.ts";

export interface CatalogueEntry {
	provider: string;
	model: string;
}

export function loadCatalogue(path: string): CatalogueEntry[] {
	const raw = JSON.parse(readFileSync(path, "utf8")) as { models?: CatalogueEntry[] };
	return raw.models ?? [];
}

export function makeAvailable(routerConfig: Config, catalogue: CatalogueEntry[]): (key: string) => boolean {
	const have = new Set(catalogue.map((c) => `${c.provider}/${c.model}`));
	const excluded = (routerConfig.excluded ?? []).map((e) => e.model).filter((m): m is string => typeof m === "string");
	return (key: string) => {
		if (!key.includes("/")) return false;
		const ref = parseRef(key);
		if (!have.has(ref.key)) return false;
		for (const p of excluded) if (globMatch(p, ref.key)) return false;
		return true;
	};
}

/** meta.current_model may be a bare id; the policy wants provider/id. */
export function qualifyModel(model: string | null | undefined, routerConfig: Config, catalogue: CatalogueEntry[]): string | null {
	if (!model) return null;
	if (model.includes("/")) return model;
	for (const tier of Object.keys(routerConfig.tiers) as (keyof Config["tiers"])[]) {
		for (const ref of routerConfig.tiers[tier]) {
			if (parseRef(ref).id === model) return parseRef(ref).key;
		}
	}
	for (const p of Object.values(routerConfig.profiles ?? {})) {
		for (const ref of p.models) {
			if (parseRef(ref).id === model) return parseRef(ref).key;
		}
	}
	const hit = catalogue.find((c) => c.model === model);
	return hit ? `${hit.provider}/${hit.model}` : model;
}

export interface RouteResult {
	assignmentId: string;
	snapshotId: string;
	decisionId: string;
	model: string;
	tier: string;
	thinking: string;
	action: string;
	lane: string | null;
	reasons: string[];
	decisionMs: number;
	embedMs: number;
	assessments: { role: string; backend: string | null; ms: number; ok: boolean; skipped?: string }[];
	representations: { representationId: string; encoder: string; recipe: string; cached: boolean; encodeMs: number }[];
	fallback: boolean;
}

function normalizePairResult(res: AskResult | AskPairResult, deps: RouteDeps): PairAssessment[] {
	if ("assessments" in res) return res.assessments;
	const call = res.calls.at(-1) ?? { backend: res.backend ?? "none", contract: deps.contracts.goal.name, ms: 0, ok: res.answers !== null };
	const backend = res.backend ?? call.backend ?? "none";
	return [
		{
			backend,
			model: deps.routerConfig.backends[backend]?.model ?? null,
			family: deps.routerConfig.backends[backend]?.family ?? null,
			answers: res.answers,
			call,
		},
	];
}

export async function routeCard(card: Card, deps: RouteDeps): Promise<RouteResult> {
	const now = deps.now ?? (() => new Date());
	const iso = () => now().toISOString();
	const configId = deps.cfg.version;
	const projectKey = typeof card.state.project === "string" && card.state.project ? card.state.project : "unknown";

	const a = admit(deps.db, {
		admissionKey: admissionKey({ origin: card.host, session: card.session, entryId: card.entry_id, request: card.state.user_message }),
		origin: card.host ?? null,
		session: card.session ?? null,
		entryId: card.entry_id ?? null,
		projectKey,
		projectName: projectKey,
		request: card.state.user_message,
		configId,
		now: iso(),
	});
	const snap = cardSnapshot(deps.db, a.assignmentId, card.state);

	let summaryItem: { itemId: string; revision: number } | null = null;
	if (deps.projectSummary?.text) {
		summaryItem = addContextItem(deps.db, {
			projectId: a.projectId,
			kind: "project_summary",
			source: "supplied",
			text: deps.projectSummary.text,
			now: iso(),
		});
	}

	const signals = (card.state.signals ?? {}) as NonNullable<Card["state"]["signals"]>;
	const hasHistory = Number(signals.user_turn_index ?? 0) > 0;
	const level = deps.level ?? "medium";
	const t0 = performance.now();

	const assessments: RouteResult["assessments"] = [];
	const rows: { role: "goal"; assessment: PairAssessment; attempt: number }[] = [];

	const askPair = async (role: "goal"): Promise<PairAssessment[]> => {
		const res = await deps.ask(role, card.state, hasHistory);
		const pair = normalizePairResult(res, deps);
		pair.forEach((pa, idx) => {
			rows.push({ role, assessment: pa, attempt: idx + 1 });
			assessments.push({
				role,
				backend: pa.backend && pa.backend !== "none" ? pa.backend : null,
				ms: pa.call.ms,
				ok: pa.answers !== null,
				skipped: pa.call.skipped,
			});
		});
		return pair;
	};

	// One selection per session, made on the first card that arrives for it. Later cards keep it.
	const chosen0 = sessionChoice(deps.db, card.session ?? null);
	let pick: SessionPick;
	if (chosen0) {
		pick = {
			model: chosen0.model,
			provider: chosen0.model.includes("/") ? chosen0.model.slice(0, chosen0.model.indexOf("/")) : "unknown",
			thinking: chosen0.thinking as SessionPick["thinking"],
			tier: chosen0.tier as SessionPick["tier"],
			action: "keep",
			rule: "session:keep_initial_selection",
			reasons: ["selected_at:initial"],
			basis: "session_keep",
			disagreement: false,
		};
	} else {
		const classifier = (deps.cfg.initial_mode ?? "classifier") === "classifier";
		let goalInputs: { backend: string; answers: Answers | null }[] | null = null;
		if (classifier) {
			const pair = await askPair("goal");
			goalInputs = pair.map((pa) => ({
				backend: pa.backend,
				answers: pa.answers,
			}));
		}
		pick = selectInitial({
			config: deps.routerConfig,
			level,
			available: (k: string) => deps.available(k),
			explicitModelChange: (card.state as { explicit_model?: string }).explicit_model ?? null,
			goalAnswers: goalInputs,
			classified: classifier,
		});
	}
	const decisionMs = performance.now() - t0;
	recordAssessments(deps, a.assignmentId, snap.snapshotId, rows, iso);
	const policyVersion = deps.cfg.policy.version ?? "v2-2026-10-28";
	const sessionDecisionId = ids.decision(
		a.assignmentId,
		snap.snapshotId,
		"session",
		policyVersion,
		sha256("session", canonical({ model: pick.model, rule: pick.rule, basis: pick.basis })),
	);
	insert(deps.db, "decisions", {
		decision_id: sessionDecisionId,
		assignment_id: a.assignmentId,
		snapshot_id: snap.snapshotId,
		policy_id: "session",
		policy_version: policyVersion,
		rule_id: pick.rule,
		action: pick.action,
		model: pick.model,
		provider: pick.provider,
		thinking: pick.thinking,
		tier: pick.tier,
		lane: null,
		reasons_json: JSON.stringify(pick.reasons),
		propensity: 1,
		disagreement: pick.disagreement ? 1 : 0,
		fallback: pick.action === "no_model" ? 1 : 0,
		decision_ms: Math.round(decisionMs * 10) / 10,
		basis: pick.basis,
		created_utc: iso(),
	});
	insert(deps.db, "observations", {
		observation_id: ids.observation(a.assignmentId, "environment", "pipeline", iso(), environmentDigest(deps.cfg, deps.routerConfig, deps.contracts)),
		assignment_id: a.assignmentId,
		kind: "environment",
		source: "pipeline",
		method: "routeCard@1",
		at_utc: iso(),
		value_json: JSON.stringify(environmentDigest(deps.cfg, deps.routerConfig, deps.contracts)),
	});
	const reps0 = embedAll(deps, a.assignmentId, card);
	if (summaryItem) void summaryItem;
	return {
		assignmentId: a.assignmentId,
		snapshotId: snap.snapshotId,
		decisionId: sessionDecisionId,
		model: pick.model,
		tier: pick.tier,
		thinking: pick.thinking,
		action: pick.action,
		lane: null,
		reasons: pick.reasons,
		decisionMs: Math.round(decisionMs * 10) / 10,
		embedMs: reps0.embedMs,
		assessments,
		representations: reps0.representations,
		fallback: pick.action === "no_model",
	};
}

export interface Environment {
	node: string;
	platform: string;
	host: string;
	pipeline_config: string;
	pipeline_config_sha256: string;
	router_config: string;
	router_config_sha256: string;
	contracts: { goal: string };
	encoders: string[];
	deciders: { backend: string; model: string | null; host: string }[];
	db_schema: number;
}

let environmentCache: Environment | null = null;

/** One environment fingerprint per process; every decision row points at it. */
export function environmentDigest(cfg: PipelineConfig, routerConfig: Config, contracts: { goal: Contract }): Environment {
	if (environmentCache) return environmentCache;
	const hashFile = (p: string) => {
		try {
			return createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16);
		} catch {
			return "missing";
		}
	};
	environmentCache = {
		node: process.version,
		platform: `${process.platform}/${process.arch}`,
		host: hostname(),
		pipeline_config: cfg.version,
		pipeline_config_sha256: hashFile(deps_config_path()),
		router_config: routerConfig.version,
		router_config_sha256: hashFile(cfg.router_config),
		contracts: { goal: contracts.goal.hash },
		encoders: cfg.encoders.map((e) => `${e.id}@${e.version}`),
		deciders: cfg.deciders.order.map((id) => {
			const b = routerConfig.backends[id];
			let host = "?";
			try {
				host = new URL(b?.url ?? "").host;
			} catch {
				/* leave ? */
			}
			return { backend: id, model: b?.model ?? null, host };
		}),
		db_schema: 1,
	};
	return environmentCache;
}

function deps_config_path(): string {
	return new URL("../config.json", import.meta.url).pathname;
}

/** Representations for one assignment. Cache-first; a hit costs a select, not an encode. */
function embedAll(deps: RouteDeps, assignmentId: string, card: Card): { representations: RouteResult["representations"]; embedMs: number } {
	const representations: RouteResult["representations"] = [];
	if (!deps.embed) return { representations, embedMs: 0 };
	const embedStart = performance.now();
	const texts: { recipe: Recipe; text: string | null }[] = deps.cfg.recipes.map((recipe) => ({
		recipe,
		text: recipeText(recipe, { request: card.state.user_message, project_summary: deps.projectSummary?.text ?? null }),
	}));
	if (deps.projectSummary?.text) {
		texts.push({ recipe: { id: "project-summary-item", version: "1", source: "project_summary" }, text: deps.projectSummary.text });
	}
	for (const { recipe, text } of texts) {
		if (!text) continue;
		const clipped = text.slice(0, deps.cfg.embed.max_chars);
		for (const spec of deps.cfg.encoders) {
			if ((spec as { backend?: string }).backend === "http") {
				if ((spec as { enabled?: boolean }).enabled !== false) {
					enqueue(deps.db, [{ encoder: spec, recipe, text: clipped, source: { record: "assignment", id: assignmentId } }]);
				}
				continue;
			}
			const r = represent(deps.db, spec as unknown as EncoderSpec, recipe, clipped, { record: "assignment", id: assignmentId }, deps.hooks);
			representations.push({
				representationId: r.representationId,
				encoder: `${r.encoderId}@${r.encoderVersion}`,
				recipe: `${r.recipeId}@${r.recipeVersion}`,
				cached: r.cached,
				encodeMs: Math.round(r.encodeMs * 100) / 100,
			});
		}
	}
	return { representations, embedMs: Math.round((performance.now() - embedStart) * 10) / 10 };
}

/** One row per decider call in the paired review. */
function recordAssessments(
	deps: RouteDeps,
	assignmentId: string,
	snapshotId: string,
	rows: { role: "goal"; assessment: PairAssessment; attempt: number }[],
	iso: () => string,
): void {
	for (const { role, assessment, attempt } of rows) {
		const contract = deps.contracts.goal;
		const backend = assessment.backend && assessment.backend !== "none" ? assessment.backend : null;
		insert(deps.db, "assessments", {
			assessment_id: ids.assessment(assignmentId, snapshotId, role, assessment.backend ?? "none", contract.hash, attempt),
			snapshot_id: snapshotId,
			assignment_id: assignmentId,
			role,
			backend,
			model: assessment.model ?? (backend ? deps.routerConfig.backends[backend]?.model : null) ?? null,
			contract: contract.name,
			contract_hash: contract.hash,
			attempt,
			started_utc: iso(),
			ms: assessment.call.ms ?? 0,
			ok: assessment.answers ? 1 : 0,
			status: assessment.call.status ?? null,
			error: assessment.call.error ?? null,
			answers_json: assessment.answers ? JSON.stringify(compactAnswers(assessment.answers)) : null,
			raw_json: assessment.answers ? JSON.stringify(assessment.answers) : null,
		});
	}
}

/** Wire the real deciders: paired concurrent call across up to two distinct families, breaker on failure, never throws. */
export function realAsk(cfg: PipelineConfig, routerConfig: Config, contracts: { goal: Contract; axes?: Contract }): AskFn {
	const deciders = new Deciders(routerConfig.backends, { breakerMs: routerConfig.breaker_ms });
	const contract = contracts.axes ?? contracts.goal;
	return (_role, state, hasHistory) =>
		deciders.askPair(cfg.deciders?.order ?? activeBackends(routerConfig.backends), contract, state, hasHistory);
}

export function loadContracts(cfg: PipelineConfig): { goal: Contract; axes: Contract } {
	const c = loadContract(cfg.questions.axes ?? cfg.questions.goal);
	return { goal: c, axes: c };
}

export function loadRouterConfig(cfg: PipelineConfig): Config {
	return loadConfig(cfg.router_config);
}
