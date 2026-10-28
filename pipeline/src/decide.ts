/**
 * Session decision policy (session@v2): one selection per session, made when the session's first
 * user turn arrives, from a paired 3-axis decider review (depth, width, urgency) over that turn's
 * prompt and context. Every later turn keeps that model. Nothing is re-evaluated: no history
 * questions, no fault detection, no new-goal detection, no prior, no task taxonomy, no lanes.
 *
 * Three bases are recorded for the initial pick:
 *
 *   basis "explicit"  the caller or the user named a model; it is obeyed.
 *   basis "judgement" paired decider pass over the initial card (depth, width, urgency),
 *                     reconciled conservatively (max on depth/width, min on urgency), matched
 *                     against configured profiles in `config.profiles`.
 *   basis "declared"  the configured fallback profile / default tier, when no decider is
 *                     configured, calls fail, or reconciled depth remains "unknown".
 *
 * A later provider failure is not a re-evaluation: it is a request-level fact and only swaps to
 * another provider in the same tier, leaving the session's choice intact.
 */
import { type Config, loadConfig, parseRef, type Thinking, type Tier, TIERS } from "../../router/src/config.ts";
import type { Answers } from "../../router/src/deciders.ts";
import {
	type AxisLevel,
	type AxisReading,
	matchesProfile,
	type ReconciledAxes,
	readAxes,
	reconcileAxes,
	resolveProfile,
	tierFromDepth,
} from "../../router/src/router.ts";
import { type Db } from "./db.ts";

export type { AxisLevel, AxisReading, ReconciledAxes };
export { matchesProfile, readAxes, reconcileAxes, resolveProfile, tierFromDepth };

export type RawAxisInput = Record<string, { choice?: string }> | Answers | null | undefined;

export interface ParsedAxes {
	profile: string | null;
	tier: "basic" | "general" | "deep" | null;
	depth: AxisLevel;
	width: AxisLevel;
	urgency: AxisLevel;
	status: "complete" | "partial" | "none";
	disagreement: boolean;
	axes: ReconciledAxes;
	reasons: string[];
}

let defaultConfigCache: Config | null = null;
function getDefaultConfig(): Config {
	if (!defaultConfigCache) defaultConfigCache = loadConfig();
	return defaultConfigCache;
}

export function parseAnswers(
	inputs: RawAxisInput | { backend: string; answers: RawAxisInput }[],
	config?: Config,
): ParsedAxes {
	const list = !inputs
		? []
		: Array.isArray(inputs)
			? inputs
			: [{ backend: "single", answers: inputs }];
	const r = reconcileAxes(list);
	const resolved = r.depth === "unknown" ? null : resolveProfile(r, config ?? getDefaultConfig());
	const profile = resolved ? resolved.id : null;
	const tier = resolved ? resolved.profile.tier : null;
	const reasons = [
		`depth:${r.depth}`,
		`width:${r.width}`,
		`urgency:${r.urgency}`,
		`status:${r.status}`,
		...(r.disagreement ? ["disagreement"] : []),
		...(profile ? [`profile:${profile}`] : []),
	];
	return {
		profile,
		tier,
		depth: r.depth,
		width: r.width,
		urgency: r.urgency,
		status: r.status,
		disagreement: r.disagreement,
		axes: r,
		reasons,
	};
}

export interface SessionPick {
	model: string;
	provider: string;
	thinking: Thinking;
	tier: Tier;
	profile?: string | null;
	action: "initial" | "keep" | "retry_other_provider" | "no_model";
	rule: string;
	reasons: string[];
	basis: "explicit" | "judgement" | "declared" | "session_keep";
	disagreement?: boolean;
	axes?: ReconciledAxes | null;
}

/** The model this session already selected, if any. The earliest decision is the session's choice. */
export function sessionChoice(db: Db, session: string | null): { model: string; thinking: string; tier: string } | null {
	if (!session) return null;
	const row = db
		.prepare(
			`select d.model as model, d.thinking as thinking, d.tier as tier
       from decisions d join assignments a on a.assignment_id = d.assignment_id
       where a.session = ? order by d.rowid asc limit 1`,
		)
		.get(session) as { model: string; thinking: string; tier: string } | undefined;
	return row ?? null;
}

const rank = (t: Tier) => TIERS.indexOf(t);
const clamp = (t: Tier, level: "low" | "medium" | "high"): Tier => {
	if (level === "low" && rank(t) > rank("general")) return "general";
	if (level === "high" && rank(t) < rank("general")) return "general";
	return t;
};

function memberFromList(list: readonly string[], available: (k: string) => boolean): { key: string; thinking: Thinking } | null {
	for (const raw of list) {
		const r = parseRef(raw);
		if (available(r.key)) return { key: r.key, thinking: (r.thinking ?? "medium") as Thinking };
	}
	return null;
}

function member(config: Config, tier: Tier, available: (k: string) => boolean): { key: string; thinking: Thinking } | null {
	return memberFromList(config.tiers[tier], available);
}

export interface InitialInput {
	config: Config;
	level: "low" | "medium" | "high";
	available: (key: string) => boolean;
	/** Present only when the caller named a model. */
	explicitModelChange?: string | null;
	/** Decider answers for the 3-axis contract (single or paired), when a pass was made. */
	goalAnswers?: RawAxisInput | { backend: string; answers: RawAxisInput }[];
	/** Whether a decider pass was attempted at all. */
	classified: boolean;
}

/** The one selection a session gets. */
export function selectInitial(i: InitialInput): SessionPick {
	const { config, level, available } = i;
	const thinkingOf = (key: string): Thinking => {
		for (const tier of TIERS) for (const raw of config.tiers[tier]) {
			const r = parseRef(raw);
			if (r.key === key) return (r.thinking ?? "medium") as Thinking;
		}
		for (const p of Object.values(config.profiles ?? {})) for (const raw of p.models) {
			const r = parseRef(raw);
			if (r.key === key) return (r.thinking ?? "medium") as Thinking;
		}
		return "medium";
	};
	const tierOf = (key: string): Tier => {
		for (const tier of TIERS) for (const raw of config.tiers[tier]) if (parseRef(raw).key === key) return tier;
		for (const p of Object.values(config.profiles ?? {})) for (const raw of p.models) if (parseRef(raw).key === key) return p.tier;
		return config.unknown_model_tier;
	};

	if (i.explicitModelChange && available(i.explicitModelChange)) {
		const ref = parseRef(i.explicitModelChange);
		return {
			model: ref.key,
			provider: ref.provider,
			thinking: ref.thinking ?? thinkingOf(ref.key),
			tier: clamp(tierOf(ref.key), level),
			profile: null,
			action: "initial",
			rule: "initial:explicit",
			reasons: [`model_change:${ref.key}`],
			basis: "explicit",
			disagreement: false,
			axes: null,
		};
	}

	let parsedDisagreement = false;
	let parsedAxes: ReconciledAxes | null = null;
	if (i.classified && i.goalAnswers) {
		const g = parseAnswers(i.goalAnswers, config);
		parsedDisagreement = g.disagreement;
		parsedAxes = g.axes;
		if (g.tier !== null && g.profile !== null) {
			const { id: profileId, profile } = resolveProfile(g.axes, config);
			const clampedTier = clamp(profile.tier, level);
			const fbProfile = config.profiles?.[config.fallback_profile];
			const m =
				clampedTier === profile.tier
					? (memberFromList(profile.models, available) ?? member(config, clampedTier, available))
					: ((fbProfile && fbProfile.tier === clampedTier ? memberFromList(fbProfile.models, available) : null) ??
						member(config, clampedTier, available));
			if (m) {
				return {
					model: m.key,
					provider: parseRef(m.key).provider,
					thinking: m.thinking,
					tier: clampedTier,
					profile: profileId,
					action: "initial",
					rule: clampedTier === profile.tier ? `initial:profile:${profileId}` : `initial:tier:${clampedTier}`,
					reasons: g.reasons,
					basis: "judgement",
					disagreement: g.disagreement,
					axes: g.axes,
				};
			}
		}
	}

	const fbProfile = config.profiles?.[config.fallback_profile];
	const tier = clamp(fbProfile?.tier ?? config.fallback_tier, level);
	const m =
		(fbProfile && fbProfile.tier === tier ? memberFromList(fbProfile.models, available) : null) ??
		member(config, tier, available);
	if (!m) {
		return {
			model: "unknown/none",
			provider: "unknown",
			thinking: "medium",
			tier,
			profile: config.fallback_profile ?? null,
			action: "no_model",
			rule: "initial:no_model",
			reasons: ["no credentials in any configured tier"],
			basis: "declared",
			disagreement: parsedDisagreement,
			axes: parsedAxes,
		};
	}
	return {
		model: m.key,
		provider: parseRef(m.key).provider,
		thinking: m.thinking,
		tier,
		profile: config.fallback_profile ?? null,
		action: "initial",
		rule: `initial:declared_tier:${tier}`,
		reasons: [
			...(config.fallback_profile ? [`profile:${config.fallback_profile}`] : []),
			i.classified ? "decider gave no usable answers" : "no decider configured",
		],
		basis: "declared",
		disagreement: parsedDisagreement,
		axes: parsedAxes,
	};
}
