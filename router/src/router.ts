/**
 * router/auto (session@v2) — selects a model on the initial user turn from a paired 3-axis review
 * (depth, width, urgency) across two distinct decision-model families, matched against configurable
 * profiles in `config.profiles` (with optional `.anchor/router-stub.md` tag routing), then keeps that
 * model across normal continuation turns.
 *
 * Continuation turns run a fast local two-stage pivot check (`src/pivot.ts`):
 *   - Stage 1: deterministic telemetry trouble thresholds + bi-encoder cosine (`Qwen3-Embedding-0.6B`)
 *     against `goal_anchor` (anchored by `<cwd>/.anchor/router-stub.md` when present).
 *   - Stage 2: cross-encoder reranker (`Qwen3-Reranker-0.6B`), invoked only when Stage 1 detects
 *     ambiguous semantic drift or soft instability.
 *   - Only confirmed pivots re-run the paired 3-axis decider pass (`action: "pivot"`).
 *
 * What else moves:
 *   - retry after a provider failure (overload, rate limit, 5xx, timeout, auth): another provider in
 *     the same profile/tier. That is a request-level fact, not a re-evaluation.
 *   - an explicit model change by the user: pi records it; the next user turn adopts it.
 *
 * The selection rests on the reconciled 3-axis decider review (`basis: "judgement"`) or, when depth
 * remains unknown / no decider answers, on the configured fallback profile/tier (`basis: "declared"`).
 * Both raw decider readings, the reconciled axes, and any inter-decider disagreement are recorded.
 */
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import {
	type Config,
	type DepthLevel,
	globMatch,
	loadTagMappings,
	type ModelRef,
	type ProfileConfig,
	type ProfileWhen,
	parseRef,
	resolvePivotConfig,
	routerPath,
} from "./config.ts";
import { activeBackends, type Answers, type AskPairResult, type Contract, Deciders, compactAnswers, loadContract, type PairAssessment } from "./deciders.ts";
import { fileLogger, type LogLine, stateHash } from "./log.ts";
import { checkPivot, loadProjectStubInfo, type PivotCheckInput, type PivotCheckResult } from "./pivot.ts";
import { type BranchEntry, buildLiveState, type CardState, clip } from "./state.ts";
import { recordLiveTurn } from "./records.ts";

export const AXIS_NAMES = ["depth", "width", "urgency"] as const;
export type AxisName = (typeof AXIS_NAMES)[number];
export const KNOWN_AXIS_LEVELS = ["0", "1", "2", "3"] as const;
export type KnownAxisLevel = (typeof KNOWN_AXIS_LEVELS)[number];
export type AxisLevel = DepthLevel;

export interface AxisReading {
	depth: AxisLevel;
	width: AxisLevel;
	urgency: AxisLevel;
}

export interface ReconciledAxes extends AxisReading {
	status: "complete" | "partial" | "none";
	disagreement: boolean;
	readings: ({ backend: string } & AxisReading)[];
}

export interface SessionState {
	v: 1;
	/** Physical model this session selected, provider/id. */
	model: string;
	thinking: string;
	tier: "basic" | "general" | "deep";
	/** Named 3-axis profile from config.profiles (null when basis === "explicit"). */
	profile: string | null;
	lane: null;
	/** The 3-axis review read on initial turn or most recent pivot. */
	axes: ReconciledAxes | null;
	/** What the selection rested on. */
	basis: "judgement" | "declared" | "explicit";
	last: { action: string; reasons: string[] };
	/** Active goal prompt text for turn-to-turn pivot detection. */
	goal_anchor?: string | null;
	/** Optional project summary stub loaded from `<cwd>/.anchor/router-stub.md`. */
	project_stub?: string | null;
	/** Optional OpenRouter task_type tag declared in `<cwd>/.anchor/router-stub.md`. */
	project_tag?: string | null;
	/** Cached Qwen3-Embedding-0.6B vector for `goal_anchor` (plus `project_stub` when present) so continuation turns only embed the new prompt. */
	goal_embedding?: number[] | null;
	/** Legacy fields, tolerated when a session carries old state. */
	goal?: unknown;
	arm?: string;
	arm_p?: number;
}

export type Level = "low" | "medium" | "high";
export type Tier = "basic" | "general" | "deep";
const TIERS: Tier[] = ["basic", "general", "deep"];

export interface SessionRouteCtx {
	cwd: string;
	modelRegistry: {
		find(provider: string, modelId: string): Model<Api> | undefined;
		hasConfiguredAuth(model: Model<Api>): boolean;
	};
	sessionManager: { getBranch(): readonly unknown[]; getHeader(): { cwd?: string } | null; getSessionId(): string };
	ui?: { notify(message: string, type?: "info" | "warning" | "error"): void };
}

type Request = ModelRouteRequest<SessionState>;
type Route = ModelRoute<SessionState>;

export type ProviderFault = "overload" | "rate_limit" | "server" | "timeout" | "auth" | "context" | "other" | null;

/** Classify a provider failure from its own text. Facts only. */
export function classifyError(message: string | null | undefined): ProviderFault {
	const s = (message ?? "").toLowerCase();
	if (!s) return null;
	if (/unauthori[sz]ed|forbidden|invalid api key|authentication|401|403/.test(s)) return "auth";
	if (/rate limit|too many requests|quota|429/.test(s)) return "rate_limit";
	if (/timeout|timed out|etimedout|408/.test(s)) return "timeout";
	if (/overload|capacity|busy|529/.test(s)) return "overload";
	if (/\b5\d\d\b|server error|bad gateway|service unavailable|upstream/.test(s)) return "server";
	if (/context length|too many tokens|context window|prompt is too long/.test(s)) return "context";
	return "other";
}

const rank = (t: Tier) => TIERS.indexOf(t);
export const clampTier = (t: Tier, level: Level): Tier => {
	if (level === "low" && rank(t) > rank("general")) return "general";
	if (level === "high" && rank(t) < rank("general")) return "general";
	return t;
};
export const levelOf = (thinking: string | undefined): Level =>
	thinking === "low" || thinking === "minimal" || thinking === "off" ? "low" : thinking === "high" || thinking === "xhigh" || thinking === "max" ? "high" : "medium";

export function isKnownLevel(v: unknown): v is KnownAxisLevel {
	return v === "0" || v === "1" || v === "2" || v === "3";
}

export function parseAxisLevel(v: unknown): AxisLevel {
	if (isKnownLevel(v) || v === "unknown") return v;
	return "unknown";
}

export function readAxes(answers: Record<string, { choice?: string }> | Answers | null | undefined): AxisReading | null {
	if (!answers) return null;
	const a = answers as Record<string, { choice?: unknown } | undefined>;
	return {
		depth: parseAxisLevel(a.depth?.choice),
		width: parseAxisLevel(a.width?.choice),
		urgency: parseAxisLevel(a.urgency?.choice),
	};
}

/**
 * Reconcile paired 3-axis decider readings:
 *   - depth and width take max(a, b) across known levels ("0".."3")
 *   - urgency takes min(a, b) across known levels ("0".."3")
 *   - if only one review returns a known level, use it and mark status = "partial"
 *   - if neither returns a known level, retain "unknown"
 *   - disagreement is true when two deciders both returned known levels on an axis and differed
 */
export function reconcileAxes(
	inputs: { backend: string; answers: Record<string, { choice?: string }> | Answers | null | undefined }[],
): ReconciledAxes {
	const readings: ({ backend: string } & AxisReading)[] = [];
	for (const item of inputs) {
		const r = readAxes(item.answers);
		if (r) readings.push({ backend: item.backend, ...r });
	}
	if (readings.length === 0) {
		return { depth: "unknown", width: "unknown", urgency: "unknown", status: "none", disagreement: false, readings: [] };
	}
	const reconcileOne = (axis: AxisName, mode: "max" | "min"): { value: AxisLevel; partial: boolean; disagreed: boolean } => {
		const vals = readings.map((r) => r[axis]);
		const known = vals.filter(isKnownLevel).map(Number);
		if (known.length === 0) return { value: "unknown", partial: true, disagreed: false };
		const picked = mode === "max" ? Math.max(...known) : Math.min(...known);
		const disagreed = new Set(known).size > 1;
		const partial = readings.length < 2 || known.length < readings.length;
		return { value: String(picked) as KnownAxisLevel, partial, disagreed };
	};
	const d = reconcileOne("depth", "max");
	const w = reconcileOne("width", "max");
	const u = reconcileOne("urgency", "min");
	const anyKnown = d.value !== "unknown" || w.value !== "unknown" || u.value !== "unknown";
	const allComplete = readings.length >= 2 && !d.partial && !w.partial && !u.partial;
	const status: ReconciledAxes["status"] = !anyKnown ? "none" : allComplete ? "complete" : "partial";
	const disagreement = d.disagreed || w.disagreed || u.disagreed;
	return {
		depth: d.value,
		width: w.value,
		urgency: u.value,
		status,
		disagreement,
		readings,
	};
}

/** Map reconciled depth ("0".."3" | "unknown") to a tier. */
export const tierFromDepth = (depth: AxisLevel | null, config: Config): Tier => {
	if (!depth || depth === "unknown") return config.fallback_tier;
	return config.tier_from_depth?.[depth] ?? (depth === "0" ? "basic" : depth === "3" ? "deep" : "general");
};

export function matchesProfile(
	axes: Pick<AxisReading, "depth" | "width" | "urgency">,
	when: ProfileWhen | undefined,
): boolean {
	if (!when) return false;
	if (when.depth && !when.depth.includes(axes.depth)) return false;
	if (when.width && !when.width.includes(axes.width)) return false;
	if (when.urgency && !when.urgency.includes(axes.urgency)) return false;
	return Boolean(when.depth || when.width || when.urgency);
}

/**
 * Match reconciled (depth, width, urgency) against `config.profiles` in declaration order.
 * When `axes` is null or `axes.depth === "unknown"`, or when no profile matches, return `config.fallback_profile`.
 */
export function resolveProfile(
	axes: Pick<AxisReading, "depth" | "width" | "urgency"> | null | undefined,
	config: Config,
): { id: string; profile: ProfileConfig } {
	const fallbackId = config.fallback_profile;
	const fallback = config.profiles[fallbackId];
	if (!axes || axes.depth === "unknown") {
		return { id: fallbackId, profile: fallback };
	}
	for (const [id, profile] of Object.entries(config.profiles)) {
		if (matchesProfile(axes, profile.when)) {
			return { id, profile };
		}
	}
	return { id: fallbackId, profile: fallback };
}

export function createRouter(deps: {
	config: Config;
	deciders?: Deciders;
	contracts?: { goal?: Contract; axes?: Contract };
	log?: (line: LogLine) => void;
	pivotFetch?: typeof fetch;
	pivot?: (input: PivotCheckInput) => Promise<PivotCheckResult>;
}) {
	const { config } = deps;
	const deciders = deps.deciders ?? new Deciders(config.backends, { breakerMs: config.breaker_ms });
	const goalContract = deps.contracts?.axes ?? deps.contracts?.goal ?? loadContract(routerPath(config.contracts.axes ?? config.contracts.goal));
	const log = deps.log ?? fileLogger(routerPath(config.log_path));
	const pivotConfig = resolvePivotConfig(config);
	const runPivotCheck = deps.pivot ?? checkPivot;
	const now = () => new Date();

	const available = (ctx: SessionRouteCtx) => (ref: ModelRef) => {
		const m = ctx.modelRegistry.find(ref.provider, ref.id);
		return !!m && ctx.modelRegistry.hasConfiguredAuth(m);
	};
	const physical = (ctx: SessionRouteCtx, ref: ModelRef): Model<Api> => {
		const m = ctx.modelRegistry.find(ref.provider, ref.id);
		if (!m) throw new Error(`session router: ${ref.key} is not in the catalog`);
		return m;
	};
	const excluded = (key: string) => (config.excluded ?? []).some((e) => typeof e.model === "string" && globMatch(e.model, key));

	const pickFromList = (
		ctx: SessionRouteCtx,
		list: readonly string[],
		tier: Tier,
		skipProvider?: string,
	): { key: string; thinking: ModelThinkingLevel; tier: Tier } | null => {
		const ok = available(ctx);
		for (const raw of list) {
			const ref = parseRef(raw);
			if (excluded(ref.key)) continue;
			if (skipProvider && ref.provider === skipProvider) continue;
			if (!ok(ref)) continue;
			return { key: ref.key, thinking: (ref.thinking ?? "medium") as ModelThinkingLevel, tier };
		}
		return null;
	};
	const pickIn = (ctx: SessionRouteCtx, tier: Tier, skipProvider?: string): { key: string; thinking: ModelThinkingLevel; tier: Tier } | null =>
		pickFromList(ctx, config.tiers[tier], tier, skipProvider);
	const pickProfile = (
		ctx: SessionRouteCtx,
		profile: ProfileConfig,
		skipProvider?: string,
		projectTag?: string | null,
	): { key: string; thinking: ModelThinkingLevel; tier: Tier; tagApplied?: boolean } | null => {
		if (projectTag) {
			const mappings = loadTagMappings(config);
			const defaultThinking = (profile.models[0] ? parseRef(profile.models[0]).thinking : undefined) ?? "medium";
			const tagBucket: Tier = profile.tier === "deep" || defaultThinking === "high" ? "deep" : profile.tier;
			const tagModels = mappings?.tags?.[projectTag]?.[tagBucket];
			if (Array.isArray(tagModels) && tagModels.length > 0) {
				const tagRefs = tagModels.map((m) => (m.includes(":") ? m : `${m}:${defaultThinking}`));
				const fromTag = pickFromList(ctx, tagRefs, profile.tier, skipProvider);
				if (fromTag) return { ...fromTag, tagApplied: true };
			}
		}
		return pickFromList(ctx, profile.models, profile.tier, skipProvider);
	};
	const pickDefault = (ctx: SessionRouteCtx, level: Level): { key: string; thinking: ModelThinkingLevel; tier: Tier } | null => {
		const fb = config.profiles?.[config.fallback_profile];
		if (fb && clampTier(fb.tier, level) === fb.tier) {
			const m = pickProfile(ctx, fb);
			if (m) return m;
		}
		return pickIn(ctx, clampTier(config.fallback_tier, level));
	};
	const tierOf = (key: string): Tier => {
		for (const tier of TIERS) for (const raw of config.tiers[tier]) if (parseRef(raw).key === key) return tier;
		for (const profile of Object.values(config.profiles ?? {})) {
			for (const raw of profile.models) if (parseRef(raw).key === key) return profile.tier;
		}
		return config.unknown_model_tier;
	};

	const notify = (ctx: SessionRouteCtx, message: string, type: "info" | "warning" = "info") => {
		try {
			ctx.ui?.notify(message, type);
		} catch {
			/* no UI */
		}
	};

	/** Keep whatever the session already has: previous dispatch, stored state, else the declared tier. */
	function sticky(request: Request, ctx: SessionRouteCtx): Route {
		if (request.previous) return { model: request.previous.model, thinkingLevel: request.previous.thinkingLevel ?? "medium" };
		const s = request.state;
		if (s?.model) {
			const ref = parseRef(s.model);
			const m = ctx.modelRegistry.find(ref.provider, ref.id);
			if (m) return { model: m, thinkingLevel: (s.thinking as ModelThinkingLevel) ?? "medium", state: s };
		}
		const fallback = pickDefault(ctx, levelOf(request.thinkingLevel));
		if (!fallback) throw new Error("session router: no model in the fallback tier has credentials");
		return { model: physical(ctx, parseRef(fallback.key)), thinkingLevel: fallback.thinking };
	}

	/** A kept turn is still a live turn: record it, but never let the record change the route. */
	function recordKeep(
		state: SessionState,
		ctx: SessionRouteCtx,
		card: CardState,
		entryId: string | null,
		reasons: string[] = ["selected_at:initial"],
	): void {
		try {
			void recordLiveTurn({
				session: ctx.sessionManager.getSessionId(),
				entryId,
				request: card.user_message,
				card,
				project: card.project ?? null,
				projectSummary: state.project_stub ?? null,
				model: state.model,
				thinking: state.thinking,
				tier: state.tier,
				action: "keep",
				basis: "session_keep",
				rule: "session:keep_initial_selection",
				reasons,
				routerConfigVersion: config.version,
			});
		} catch {
			/* bookkeeping is never allowed to break a route */
		}
	}

	async function runPair(card: unknown, signal?: AbortSignal): Promise<AskPairResult> {
		const order = activeBackends(config.backends);
		if (typeof deciders.askPair === "function") {
			return deciders.askPair(order, goalContract, card, false, signal);
		}
		// Fallback for single-call test doubles that only implement ask().
		const single = await deciders.ask(order, goalContract, card, false, signal);
		const call = single.calls.at(-1) ?? { backend: single.backend ?? "none", contract: goalContract.name, ms: 0, ok: single.answers !== null };
		const assessments: PairAssessment[] = single.backend || single.calls.length
			? [
					{
						backend: single.backend ?? call.backend,
						model: config.backends[single.backend ?? ""]?.model ?? null,
						family: config.backends[single.backend ?? ""]?.family ?? null,
						answers: single.answers,
						call,
					},
				]
			: [];
		return { assessments, calls: single.calls };
	}

	async function evaluateAndSelect(
		request: Request,
		ctx: SessionRouteCtx,
		card: CardState,
		entryId: string | null,
		action: "initial" | "pivot",
		projectStub: string | null,
		projectTag: string | null,
		pivotRes?: PivotCheckResult,
	): Promise<Route> {
		const t0 = performance.now();
		const level = levelOf(request.thinkingLevel);
		const pair = await runPair(card, request.signal);
		const axes = reconcileAxes(pair.assessments.map((a) => ({ backend: a.backend, answers: a.answers })));
		const basis: SessionState["basis"] = axes.depth !== "unknown" ? "judgement" : "declared";
		const { id: profileId, profile } = resolveProfile(axes, config);
		const clampedTier = clampTier(profile.tier, level);
		const fallbackTier = clampTier(config.fallback_tier, level);
		const fallbackProfile = config.profiles[config.fallback_profile];
		const picked =
			clampedTier === profile.tier
				? (pickProfile(ctx, profile, undefined, projectTag) ?? pickIn(ctx, clampedTier) ?? pickIn(ctx, fallbackTier))
				: ((fallbackProfile && fallbackProfile.tier === clampedTier ? pickProfile(ctx, fallbackProfile, undefined, projectTag) : null) ??
					pickIn(ctx, clampedTier) ??
					pickIn(ctx, fallbackTier));
		if (!picked) throw new Error("session router: no model in any tier has credentials");

		const reasons = [
			...(pivotRes ? pivotRes.reasons : []),
			`depth:${axes.depth}`,
			`width:${axes.width}`,
			`urgency:${axes.urgency}`,
			`status:${axes.status}`,
			...(axes.disagreement ? ["disagreement"] : []),
			`profile:${profileId}`,
			...((picked as { tagApplied?: boolean }).tagApplied && projectTag ? [`tag:${projectTag}`] : []),
			`tier:${picked.tier}`,
			`basis:${basis}`,
		];

		const state: SessionState = {
			v: 1,
			model: picked.key,
			thinking: picked.thinking,
			tier: picked.tier,
			profile: profileId,
			lane: null,
			axes,
			basis,
			goal_anchor: clip(card.user_message, 600) || null,
			project_stub: projectStub,
			project_tag: projectTag,
			// When a project stub is present, leave goal_embedding null on pivot so the next turn embeds the composite `${goal_anchor}\n\n---\n${project_stub}`.
			goal_embedding: projectStub ? null : (pivotRes?.messageEmbedding ?? null),
			last: { action, reasons },
		};
		const backendsUsed = pair.assessments.filter((a) => a.answers !== null).map((a) => a.backend);
		log({
			ts: now().toISOString(),
			session: ctx.sessionManager.getSessionId(),
			entry: entryId,
			reason: "user",
			basis,
			level: request.thinkingLevel,
			backends: backendsUsed,
			decider_ms: Math.round(pair.calls.reduce((s, c) => Math.max(s, c.ms), 0) * 10) / 10,
			...(pivotRes
				? {
						pivot_stage: pivotRes.stage,
						pivot_ms: pivotRes.ms,
						pivot_cosine: pivotRes.cosine ?? null,
						pivot_rerank: pivotRes.rerankScore ?? null,
					}
				: {}),
			assessments: pair.assessments.map((a) => ({ backend: a.backend, ok: a.call.ok, ms: a.call.ms, answers: compactAnswers(a.answers) })),
			axes,
			profile: state.profile,
			chosen: `${state.model}:${state.thinking}`,
			tier: state.tier,
			action,
			reasons: state.last.reasons,
			state_hash: stateHash(state),
			route_ms: Math.round((performance.now() - t0) * 10 + (pivotRes?.ms ?? 0) * 10) / 10,
			config: config.version,
			contract: goalContract.hash,
		});
		notify(ctx, `router/auto → ${state.model}:${state.thinking} (${action}/${basis}: ${state.last.reasons.join(", ")})`);
		void recordLiveTurn({
			session: ctx.sessionManager.getSessionId(),
			entryId,
			request: card.user_message,
			card,
			project: card.project ?? null,
			projectSummary: projectStub,
			model: state.model,
			thinking: state.thinking,
			tier: state.tier,
			action,
			basis,
			rule:
				basis === "judgement"
					? clampedTier === profile.tier
						? `${action}:profile:${profileId}`
						: `${action}:tier:${picked.tier}`
					: `${action}:${basis}`,
			reasons: state.last.reasons,
			disagreement: axes.disagreement,
			assessments: pair.assessments.map((a, idx) => ({
				backend: a.backend,
				model: a.model,
				contract: goalContract.name,
				contractHash: goalContract.hash,
				attempt: idx + 1,
				ms: a.call.ms,
				ok: a.answers !== null,
				status: a.call.status ?? null,
				error: a.call.error ?? null,
				answers: compactAnswers(a.answers),
				raw: a.answers,
			})),
			contractHash: goalContract.hash,
			decisionMs: performance.now() - t0 + (pivotRes?.ms ?? 0),
			routerConfigVersion: config.version,
		});
		return { model: physical(ctx, parseRef(state.model)), thinkingLevel: state.thinking as ModelThinkingLevel, state };
	}

	async function selectInitial(request: Request, ctx: SessionRouteCtx): Promise<Route> {
		const level = levelOf(request.thinkingLevel);
		const branch = ctx.sessionManager.getBranch() as BranchEntry[];
		const cwd = ctx.sessionManager.getHeader()?.cwd ?? ctx.cwd;
		const { summary: projectStub, tag: projectTag } = loadProjectStubInfo(cwd, pivotConfig.stub_path);
		const { state: card, entryId } = buildLiveState(
			{ cwd },
			branch,
			request.messages as unknown as Record<string, unknown>[],
		);

		// A model that already produced a response when router/auto was selected is the user's
		// explicit choice. Adopt it and ask nothing: that is a fact, not an assessment.
		if (request.previous) {
			const key = `${request.previous.model.provider}/${request.previous.model.id}`;
			const state: SessionState = {
				v: 1,
				model: key,
				thinking: request.previous.thinkingLevel ?? "medium",
				tier: clampTier(tierOf(key), level),
				profile: null,
				lane: null,
				axes: null,
				basis: "explicit",
				goal_anchor: clip(card.user_message, 600) || null,
				project_stub: projectStub,
				project_tag: projectTag,
				goal_embedding: null,
				last: { action: "initial", reasons: ["adopted_working_model"] },
			};
			void recordLiveTurn({
				session: ctx.sessionManager.getSessionId(),
				entryId,
				request: card.user_message,
				card,
				project: card.project ?? null,
				projectSummary: projectStub,
				model: state.model,
				thinking: state.thinking,
				tier: state.tier,
				action: "initial",
				basis: "explicit",
				rule: "initial:explicit",
				reasons: state.last.reasons,
				routerConfigVersion: config.version,
			});
			return { model: request.previous.model, thinkingLevel: (state.thinking as ModelThinkingLevel) ?? "medium", state };
		}

		return evaluateAndSelect(request, ctx, card, entryId, "initial", projectStub, projectTag);
	}

	function routeRetry(request: Request, ctx: SessionRouteCtx): Route {
		const failed = request.failed;
		if (!failed) return sticky(request, ctx);
		const key = `${failed.model.provider}/${failed.model.id}`;
		const fault = classifyError(failed.message.errorMessage);
		if (fault === "overload" || fault === "rate_limit" || fault === "server" || fault === "timeout" || fault === "auth") {
			const prev = request.state;
			const prevProfile = prev?.profile ? config.profiles[prev.profile] : undefined;
			const tier = prev?.tier ?? tierOf(key);
			const alt =
				(prevProfile && prevProfile.tier === tier ? pickProfile(ctx, prevProfile, failed.model.provider, prev?.project_tag) : null) ??
				pickIn(ctx, tier, failed.model.provider) ??
				pickIn(ctx, clampTier(tier, "medium"), failed.model.provider);
			if (alt) {
				const next: SessionState = {
					v: 1,
					model: alt.key,
					thinking: alt.thinking,
					tier: alt.tier,
					profile: prev?.profile ?? null,
					lane: null,
					axes: prev?.axes ?? null,
					basis: prev?.basis ?? "declared",
					goal_anchor: prev?.goal_anchor ?? null,
					project_stub: prev?.project_stub ?? null,
					project_tag: prev?.project_tag ?? null,
					goal_embedding: prev?.goal_embedding ?? null,
					last: { action: "retry_other_provider", reasons: [`error:${fault}`, `from:${key}`] },
				};
				log({
					ts: now().toISOString(),
					session: ctx.sessionManager.getSessionId(),
					reason: "retry",
					fault,
					from: key,
					to: alt.key,
					tier: next.tier,
					profile: next.profile,
					state_hash: stateHash(next),
				});
				notify(ctx, `router/auto: ${failed.model.id} ${fault} → ${alt.key}`, "warning");
				return { model: physical(ctx, parseRef(alt.key)), thinkingLevel: alt.thinking, state: next };
			}
		}
		return { model: failed.model, thinkingLevel: failed.thinkingLevel ?? "medium" };
	}

	async function route(request: Request, ctx: SessionRouteCtx): Promise<Route> {
		switch (request.reason) {
			case "direct": {
				if (request.previous) return { model: request.previous.model, thinkingLevel: request.previous.thinkingLevel ?? "medium" };
				const ref = pickDefault(ctx, levelOf(request.thinkingLevel));
				if (!ref) throw new Error("session router: no model has credentials");
				return { model: physical(ctx, parseRef(ref.key)), thinkingLevel: ref.thinking };
			}
			case "continuation":
				return sticky(request, ctx);
			case "retry":
				return routeRetry(request, ctx);
			default: {
				if (request.state?.v === 1 && request.state.model) {
					const ref = parseRef(request.state.model);
					const m = ctx.modelRegistry.find(ref.provider, ref.id);
					if (m) {
						try {
							const branch = ctx.sessionManager.getBranch() as BranchEntry[];
							const cwd = ctx.sessionManager.getHeader()?.cwd ?? ctx.cwd;
							const stubInfo = loadProjectStubInfo(cwd, pivotConfig.stub_path);
							const projectStub = stubInfo.summary ?? request.state.project_stub ?? null;
							const projectTag = stubInfo.tag ?? request.state.project_tag ?? null;
							const stubChanged = projectStub !== (request.state.project_stub ?? null);
							const { state: card, entryId } = buildLiveState(
								{ cwd },
								branch,
								request.messages as unknown as Record<string, unknown>[],
							);
							const anchor = request.state.goal_anchor || card.previous_user_message || "";
							const pivotRes = await runPivotCheck({
								card,
								goalAnchor: anchor,
								projectStub,
								goalEmbedding: stubChanged ? null : (request.state.goal_embedding ?? null),
								config: pivotConfig,
								signal: request.signal,
								fetchImpl: deps.pivotFetch,
							});
							if (pivotRes.pivot) {
								return await evaluateAndSelect(request, ctx, card, entryId, "pivot", projectStub, projectTag, pivotRes);
							}
							const keptState: SessionState = {
								...request.state,
								goal_anchor: pivotRes.goalAnchor || anchor || request.state.goal_anchor || null,
								project_stub: projectStub,
								project_tag: projectTag,
								goal_embedding: pivotRes.goalEmbedding ?? request.state.goal_embedding ?? null,
								last: { action: "keep", reasons: pivotRes.reasons },
							};
							recordKeep(keptState, ctx, card, entryId, pivotRes.reasons);
							return { model: m, thinkingLevel: (keptState.thinking as ModelThinkingLevel) ?? "medium", state: keptState };
						} catch {
							return { model: m, thinkingLevel: (request.state.thinking as ModelThinkingLevel) ?? "medium", state: request.state };
						}
					}
				}
				try {
					return await selectInitial(request, ctx);
				} catch (e) {
					log({
						ts: now().toISOString(),
						session: ctx.sessionManager.getSessionId(),
						reason: "user",
						action: "fallback",
						error: String((e as Error)?.message ?? e).slice(0, 300),
					});
					return sticky(request, ctx);
				}
			}
		}
	}

	return { route, deciders, contracts: { goal: goalContract, axes: goalContract } };
}

export const createSessionRouter = createRouter;
