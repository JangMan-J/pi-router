/**
 * Routing policy v1. Pure: given the decider answers, signals and router state it returns the model,
 * with reason codes. Keeping the working model is the default, because a switch drops the prompt
 * cache (cache-read share 0.99 -> 0.00 at a median 76.5k-token prompt).
 */
import { type Config, globMatch, holds, type ModelRef, parseRef, TIERS, type Thinking, type Thresholds, type Tier } from "./config.ts";
import type { Answers } from "./deciders.ts";
import { choose, type Prior } from "./prior.ts";
import type { Signals } from "./state.ts";

export type Level = "low" | "medium" | "high";
export type Action = "pick" | "keep" | "escalate" | "lateral" | "repick" | "lane" | "move" | "retry_switch" | "fallback";

export interface GoalSummary {
	task: string | null;
	difficulty: number | null;
	spec_clear: number | null;
}

/** Router state stored on the session branch. */
export interface RouterState {
	v: 1;
	/** A/B arm: the decision backend tried first for this session. */
	arm: string;
	arm_p: number;
	/** Physical model the router last chose, provider/id. */
	model: string;
	thinking: string;
	tier: Tier;
	lane: string | null;
	/** Answers of the latest goal questions; the task holds until the goal changes. */
	goal: GoalSummary | null;
	/** The decision that put `model` in place. Keeps leave it unchanged, so they store no new state. */
	last: { action: Action; reasons: string[] };
}

export interface Decision {
	ref: ModelRef & { thinking: Thinking };
	tier: Tier;
	lane: string | null;
	action: Action;
	reasons: string[];
	propensity: number;
	explored?: boolean;
}

export interface Env {
	config: Config;
	/** In the catalog, with credentials. */
	available: (ref: ModelRef) => boolean;
	prior: Prior | null;
	rng: () => number;
}

export interface TurnInput {
	level: Level;
	/** Physical model doing the work: the latest response, else the router's last pick. */
	current: { key: string; thinking?: string } | null;
	state?: RouterState;
	signals: Signals;
	/** History answers; null when not asked or every backend failed. */
	history: Answers | null;
	/** Goal answers; null when not asked or every backend failed. */
	goal: Answers | null;
	thresholds: Thresholds;
	/** First routed turn of a session that already has a working model (router/auto selected mid-session): keep it. */
	adopt?: boolean;
}

const rank = (t: Tier) => TIERS.indexOf(t);
const tierAt = (i: number): Tier => TIERS[Math.max(0, Math.min(TIERS.length - 1, i))];

export const levelOf = (thinking: string | undefined): Level =>
	thinking === "low" || thinking === "minimal" || thinking === "off" ? "low" : thinking === "high" || thinking === "xhigh" || thinking === "max" ? "high" : "medium";

/** `low` caps at general (cost saver); `high` floors at general (quality). */
export function clampTier(tier: Tier, level: Level): Tier {
	if (level === "low" && rank(tier) > rank("general")) return "general";
	if (level === "high" && rank(tier) < rank("general")) return "general";
	return tier;
}

/** Tier for a goal from its difficulty score; `high` re-picks one tier higher. */
export function tierForGoal(config: Config, goal: GoalSummary, level: Level): Tier {
	const d = goal.difficulty;
	const { basic_below, general_below } = config.tier_from_difficulty;
	let tier: Tier = d === null ? config.fallback_tier : d < basic_below ? "basic" : d < general_below ? "general" : "deep";
	if (level === "high") tier = tierAt(rank(tier) + 1);
	return clampTier(tier, level);
}

/** Config tier of a model; the entry with the same thinking level wins (astra is general at medium, deep at high). */
export function tierOfModel(config: Config, key: string, thinking?: string): Tier {
	let first: Tier | undefined;
	for (const tier of TIERS) {
		for (const ref of config.tiers[tier].map(parseRef)) {
			if (ref.key !== key) continue;
			if (ref.thinking === thinking) return tier;
			first ??= tier;
		}
	}
	return first ?? config.unknown_model_tier;
}

/** Thinking level the config gives a model, if any entry names it. */
function configThinking(config: Config, key: string): Thinking | undefined {
	for (const ref of [...TIERS.flatMap((t) => config.tiers[t]), ...config.lanes.map((l) => l.model)].map(parseRef)) {
		if (ref.key === key && ref.thinking) return ref.thinking;
	}
	return undefined;
}

export const family = (key: string): string => key.slice(key.indexOf("/") + 1).replace(/^~/, "").split(/[-_.]/)[0];

export function goalSummary(goal: Answers | null): GoalSummary | null {
	if (!goal) return null;
	const num = (k: string, f: "score" | "noul") => {
		const v = (goal[k] as Record<string, unknown> | undefined)?.[f];
		return typeof v === "number" ? v : null;
	};
	const task = (goal.task as { choice?: unknown } | undefined)?.choice;
	return { task: typeof task === "string" ? task : null, difficulty: num("difficulty", "score"), spec_clear: num("spec_clear", "noul") };
}

type Flat = Record<string, string | number | null>;

/** Answers as plain values for conditions: fresh history answers plus the goal in force. */
function flatten(history: Answers | null, goal: GoalSummary | null): Flat {
	const flat: Flat = { ...(goal ?? {}) };
	for (const [k, a] of Object.entries(history ?? {})) {
		const v = (a as { noul?: unknown }).noul;
		if (typeof v === "number") flat[k] = v;
	}
	return flat;
}

/** Why the router may not use a model on this turn, or null. */
export function blocked(config: Config, key: string, flat: Flat, thresholds: Thresholds): string | null {
	if (config.excluded.some((e) => globMatch(parseRef(e.model).key, key))) return "excluded";
	if (config.probation.some((e) => globMatch(parseRef(e.model).key, key))) return "probation";
	for (const rule of config.never) {
		if (!rule.models.some((m) => globMatch(m, key))) continue;
		for (const [q, cond] of Object.entries(rule.when_any)) {
			if (holds(cond, flat[q], (thresholds as unknown as Record<string, number>)[q])) return `never:${rule.id}:${q}`;
		}
	}
	return null;
}

function laneFor(env: Env, flat: Flat, thresholds: Thresholds): { id: string; ref: ModelRef } | null {
	for (const lane of env.config.lanes) {
		const theta = thresholds as unknown as Record<string, number>;
		if (!Object.entries(lane.when).every(([q, cond]) => holds(cond, flat[q], theta[q]))) continue;
		const ref = parseRef(lane.model);
		if (blocked(env.config, ref.key, flat, thresholds) || !env.available(ref)) continue;
		return { id: lane.id, ref };
	}
	return null;
}

interface PickOptions {
	exclude?: string;
	/** Lateral move: start after this model in config order and prefer another family. */
	lateralFrom?: string;
	task: string | null;
}

/** Choose within `tier`; if it has no usable model, the tiers above, then below. */
function pickTier(env: Env, tier: Tier, flat: Flat, thresholds: Thresholds, opts: PickOptions): Omit<Decision, "action" | "lane"> | null {
	const order = [rank(tier), ...[1, 2].map((d) => rank(tier) + d), ...[1, 2].map((d) => rank(tier) - d)].filter((i) => i >= 0 && i < TIERS.length);
	for (const i of order) {
		const t = TIERS[i];
		let refs = env.config.tiers[t].map(parseRef);
		if (opts.lateralFrom) {
			const at = refs.findIndex((r) => r.key === opts.lateralFrom);
			if (at >= 0) refs = [...refs.slice(at + 1), ...refs.slice(0, at)];
			const fam = family(opts.lateralFrom);
			refs = [...refs.filter((r) => family(r.key) !== fam), ...refs.filter((r) => family(r.key) === fam)];
		}
		const seen = new Set<string>();
		const cands = refs.filter((r) => {
			const ok = r.key !== opts.exclude && !seen.has(r.key) && !blocked(env.config, r.key, flat, thresholds) && env.available(r);
			if (ok) seen.add(r.key);
			return ok;
		});
		if (!cands.length) continue;
		const c = opts.lateralFrom
			? { index: 0, propensity: 1, explored: false }
			: choose(cands.map((r) => r.key), env.prior, opts.task, env.config.prior.epsilon, env.config.prior.min_n, env.rng);
		const ref = cands[c.index];
		return {
			ref: { ...ref, thinking: ref.thinking ?? "medium" },
			tier: t,
			reasons: [...(t !== tier ? [`tier_empty:${tier}`] : []), ...(c.explored ? ["explore"] : []), ...(env.prior && !opts.lateralFrom ? ["prior"] : [])],
			propensity: c.propensity,
			...(c.explored ? { explored: true } : {}),
		};
	}
	return null;
}

/** Agent-fault reasons on this turn. */
export function faults(input: Pick<TurnInput, "history" | "signals" | "thresholds">, config: Config): string[] {
	const out: string[] = [];
	const noul = (k: string) => (input.history?.[k] as { noul?: number } | undefined)?.noul;
	const rej = noul("user_rejection");
	const fs = noul("false_success");
	if (rej !== undefined && rej >= input.thresholds.user_rejection) out.push("user_rejection");
	if (fs !== undefined && fs >= input.thresholds.false_success) out.push("false_success");
	if (input.signals.repeated_error_fingerprint_count >= config.repeated_error_threshold) out.push("repeated_errors");
	return out;
}

export function isNewGoal(input: Pick<TurnInput, "history" | "thresholds">): boolean {
	const v = (input.history?.new_goal as { noul?: number } | undefined)?.noul;
	return v !== undefined && v >= input.thresholds.new_goal;
}

/** Whether this turn needs the goal questions: nothing to keep yet, or the goal changed. */
export function needsGoal(input: TurnInput): boolean {
	return !input.current || (!input.adopt && isNewGoal(input));
}

/** The routing decision for a user turn. */
export function decideTurn(input: TurnInput, env: Env): Decision {
	const { config } = env;
	const goalNow = goalSummary(input.goal);
	const goalInForce = goalNow ?? input.state?.goal ?? null;
	const flat = flatten(input.history, goalInForce);
	const task = goalInForce?.task ?? null;
	const th = input.thresholds;
	const asPick = (p: Omit<Decision, "action" | "lane"> | null, action: Action, reasons: string[], lane: string | null = null): Decision | null =>
		p && { ...p, action, lane, reasons: [...reasons, ...p.reasons] };
	const lanePick = (lane: { id: string; ref: ModelRef }, action: Action, reasons: string[]): Decision => ({
		ref: { ...lane.ref, thinking: lane.ref.thinking ?? "medium" },
		tier: tierOfModel(config, lane.ref.key, lane.ref.thinking),
		lane: lane.id,
		action,
		reasons: [...reasons, `lane:${lane.id}`],
		propensity: 1,
	});

	// 1. Nothing to keep: pick from the goal.
	if (!input.current) {
		const reasons = ["first_turn"];
		if (goalNow) {
			const lane = laneFor(env, flat, th);
			if (lane) return lanePick(lane, "pick", reasons);
		}
		const tier = goalNow ? tierForGoal(config, goalNow, input.level) : clampTier(config.fallback_tier, input.level);
		reasons.push(goalNow ? `difficulty:${goalNow.difficulty}` : "no_decider", `tier:${tier}`);
		const p = asPick(pickTier(env, tier, flat, th, { task }), "pick", reasons);
		if (!p) throw new Error("router: no tier model is available (credentials?)");
		return p;
	}

	// 2. Later turns: keep unless the agent is at fault or the goal changed.
	const cur = input.current;
	const curTier = input.state?.model === cur.key ? input.state.tier : tierOfModel(config, cur.key, cur.thinking);
	const keep = (reasons: string[]): Decision => ({
		ref: { ...parseRef(cur.key), thinking: (cur.thinking ?? configThinking(config, cur.key) ?? "medium") as Thinking },
		tier: curTier,
		lane: input.state?.model === cur.key ? input.state.lane : null,
		action: "keep",
		reasons,
		propensity: 1,
	});
	const fault = faults(input, config);
	const newGoal = isNewGoal(input);
	let result: Decision | null = null;

	if (input.adopt) {
		result = keep(["adopt"]);
	} else if (fault.length) {
		const reasons = ["agent_fault", ...fault, ...(newGoal ? ["new_goal"] : [])];
		let target = clampTier(tierAt(rank(curTier) + 1), input.level);
		if (newGoal && goalNow) {
			const lane = laneFor(env, flat, th);
			if (lane && lane.ref.key !== cur.key) return lanePick(lane, "lane", reasons);
			const rep = tierForGoal(config, goalNow, input.level);
			if (rank(rep) > rank(target)) target = rep;
		}
		result =
			rank(target) > rank(curTier)
				? asPick(pickTier(env, target, flat, th, { exclude: cur.key, task }), "escalate", [...reasons, `tier:${curTier}->${target}`])
				: asPick(pickTier(env, target, flat, th, { exclude: cur.key, lateralFrom: cur.key, task }), target === curTier ? "lateral" : "move", [
						...reasons,
						`tier:${curTier}->${target}`,
					]);
		result ??= keep([...reasons, "no_alternative"]);
	} else if (newGoal) {
		const reasons = ["new_goal"];
		if (!goalNow) {
			result = keep([...reasons, "no_decider"]);
		} else {
			const lane = laneFor(env, flat, th);
			const rep = tierForGoal(config, goalNow, input.level);
			if (lane && lane.ref.key !== cur.key) return lanePick(lane, "lane", reasons);
			if (lane) result = keep([...reasons, `lane:${lane.id}`, "same_model"]);
			else if (rep === curTier) result = keep([...reasons, `tier:${rep}`, "same_tier"]);
			else
				result =
					asPick(pickTier(env, rep, flat, th, { exclude: cur.key, task }), "repick", [...reasons, `tier:${curTier}->${rep}`]) ??
					keep([...reasons, "no_alternative"]);
		}
	} else {
		result = keep(["keep"]);
	}

	// A kept model must still be allowed on this turn and fit the selected level.
	if (result.action === "keep") {
		const why = blocked(config, cur.key, flat, th);
		const clamped = clampTier(curTier, input.level);
		if (why) {
			const tier = clampTier("general", input.level);
			return asPick(pickTier(env, tier, flat, th, { exclude: cur.key, task }), "move", [...result.reasons, why, `tier:${curTier}->${tier}`]) ?? result;
		}
		if (clamped !== curTier) {
			return asPick(pickTier(env, clamped, flat, th, { exclude: cur.key, task }), "move", [...result.reasons, `level_${input.level}`, `tier:${curTier}->${clamped}`]) ?? result;
		}
	}
	return result;
}

const OVERLOAD = /\b(?:429|5\d\d)\b|overloaded|rate[ _-]?limit|too many requests|service unavailable|internal server error|bad gateway|gateway time-?out|capacity|temporarily unavailable/i;

/** Whether a failed request's error is provider trouble (overload, rate limit, 5xx) rather than the request. */
export const isOverload = (errorMessage: string | undefined): boolean => !!errorMessage && OVERLOAD.test(errorMessage);

/** A same-tier alternative to a model whose provider is overloaded; another provider first. */
export function retryAlternative(env: Env, failed: { key: string; thinking?: string }): Decision | null {
	const { config } = env;
	const tier = tierOfModel(config, failed.key, failed.thinking);
	const provider = failed.key.slice(0, failed.key.indexOf("/"));
	const refs = config.tiers[tier].map(parseRef).filter((r) => r.key !== failed.key && !blocked(config, r.key, {}, { new_goal: 1, user_rejection: 1, false_success: 1 }) && env.available(r));
	const ref = refs.find((r) => r.provider !== provider) ?? refs[0];
	if (!ref) return null;
	return { ref: { ...ref, thinking: ref.thinking ?? "medium" }, tier, lane: null, action: "retry_switch", reasons: ["overload"], propensity: 1 };
}

/** First available model of a tier (for requests outside the agent loop with nothing to stay on). */
export function firstAvailable(env: Env, tier: Tier): (ModelRef & { thinking: Thinking }) | null {
	const ref = env.config.tiers[tier].map(parseRef).find((r) => !blocked(env.config, r.key, {}, { new_goal: 1, user_rejection: 1, false_success: 1 }) && env.available(r));
	return ref ? { ...ref, thinking: ref.thinking ?? "medium" } : null;
}

/** Session A/B arm by config weight, with its propensity. */
export function pickArm(arms: Record<string, number>, rng: () => number): { arm: string; p: number } {
	const entries = Object.entries(arms).filter(([, w]) => w > 0);
	const total = entries.reduce((s, [, w]) => s + w, 0);
	let x = rng() * total;
	for (const [arm, w] of entries) {
		if (x < w) return { arm, p: w / total };
		x -= w;
	}
	const [arm, w] = entries[entries.length - 1];
	return { arm, p: w / total };
}
