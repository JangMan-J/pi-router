/**
 * Optional outcome prior (~/.local/share/route-prior/prior.json, built by another job):
 * {"version","generated_at","models":{"<provider>/<id>":{alpha,beta,n}},"cells":{"<provider>/<id>|<task>":{alpha,beta,n}}}
 * alpha = 1 + good, beta = 1 + bad, n = good + bad (outcomes of labelled turns).
 * Without it, a tier is tried in config order.
 */
import { readFileSync, statSync } from "node:fs";

export interface Beta {
	alpha: number;
	beta: number;
	n: number;
}

export interface Prior {
	version?: string;
	generated_at?: string;
	models: Record<string, Beta>;
	cells: Record<string, Beta>;
}

let cache: { path: string; mtimeMs: number; prior: Prior | null } | undefined;

/** The prior if the file exists, parses and has entries; re-read only when its mtime changes. */
export function loadPrior(path: string): Prior | null {
	let mtimeMs: number;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		cache = undefined;
		return null;
	}
	if (cache?.path === path && cache.mtimeMs === mtimeMs) return cache.prior;
	let prior: Prior | null = null;
	try {
		const p = JSON.parse(readFileSync(path, "utf8"));
		// A prior without entries carries no information: keep config order and do not explore.
		const entries = p && typeof p.models === "object" && typeof p.cells === "object" ? Object.keys(p.models).length + Object.keys(p.cells).length : 0;
		if (entries > 0) prior = p;
	} catch {
		prior = null;
	}
	cache = { path, mtimeMs, prior };
	return prior;
}

/**
 * 95% Wilson interval of a rate. The prior's Beta parameters are alpha = 1 + good, beta = 1 + bad,
 * so a model's bad count is beta - 1 out of n.
 */
export function wilson(k: number, n: number, z = 1.96): { lo: number; hi: number } {
	if (n <= 0) return { lo: 0, hi: 1 };
	const p = k / n;
	const z2 = z * z;
	const center = (p + z2 / (2 * n)) / (1 + z2 / n);
	const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
	return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;
const badOf = (b: Beta | undefined) => (b ? { bad: Math.max(0, b.beta - 1), n: b.n } : { bad: 0, n: 0 });

export interface Demotion {
	model: string;
	/** `cell:<task>` when both models have min_n outcomes on the task, else `model`. */
	basis: string;
	n: number;
	bad_lo: number;
	ref: string;
	ref_n: number;
	ref_bad_hi: number;
}

/**
 * Models in `keys` that are credibly worse than the best-supported model of `tier` (most outcomes at
 * model level; it need not be a candidate itself, e.g. the current model or one without credentials): their 95% Wilson lower bound on the bad rate is above its 95% upper bound. A model
 * with fewer than min_n outcomes is never demoted. The outcomes are associations (Jang picks models
 * per task), so the prior only removes options that are clearly bad; it does not rank the rest.
 */
export function demotions(
	keys: readonly string[],
	prior: Prior,
	task: string | null,
	minN: number,
	tier: readonly string[] = keys,
): { ref: string | null; demoted: Demotion[] } {
	let ref: string | null = null;
	for (const k of tier) if ((prior.models[k]?.n ?? 0) > (ref ? (prior.models[ref]?.n ?? 0) : 0)) ref = k;
	if (!ref) return { ref: null, demoted: [] };
	const demoted: Demotion[] = [];
	for (const k of keys) {
		if (k === ref || (prior.models[k]?.n ?? 0) < minN) continue;
		const cell = task ? prior.cells[`${k}|${task}`] : undefined;
		const refCell = task ? prior.cells[`${ref}|${task}`] : undefined;
		const byCell = !!cell && !!refCell && cell.n >= minN && refCell.n >= minN;
		const own = badOf(byCell ? cell : prior.models[k]);
		const theirs = badOf(byCell ? refCell : prior.models[ref]);
		const lo = wilson(own.bad, own.n).lo;
		const hi = wilson(theirs.bad, theirs.n).hi;
		if (lo > hi) {
			demoted.push({ model: k, basis: byCell ? `cell:${task}` : "model", n: own.n, bad_lo: round4(lo), ref, ref_n: theirs.n, ref_bad_hi: round4(hi) });
		}
	}
	return { ref, demoted };
}

export interface Choice {
	index: number;
	/** Probability that this policy picks this candidate on this turn. */
	propensity: number;
	explored: boolean;
	/** Best-supported model the others were compared with, when a prior is present. */
	ref?: string | null;
	demoted: Demotion[];
}

/**
 * Pick among candidates in config order. No prior: the first, propensity 1, no exploration. With a
 * prior: credibly bad models are removed, the first remaining model is the default, and with
 * probability epsilon the pick is uniform over the remaining models (the randomized picks are what
 * give causal evidence). The propensity of the chosen model is returned.
 */
export function choose(
	keys: readonly string[],
	prior: Prior | null,
	task: string | null,
	epsilon: number,
	minN: number,
	rng: () => number,
	tier: readonly string[] = keys,
): Choice {
	if (!prior) return { index: 0, propensity: 1, explored: false, demoted: [] };
	const { ref, demoted } = demotions(keys, prior, task, minN, tier);
	const out = new Set(demoted.map((d) => d.model));
	const pool = keys.map((_, i) => i).filter((i) => !out.has(keys[i]));
	const greedy = pool[0];
	const explored = epsilon > 0 && pool.length > 1 && rng() < epsilon;
	const index = explored ? pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))] : greedy;
	const propensity = (index === greedy ? 1 - epsilon : 0) + epsilon / pool.length;
	return { index, propensity, explored, ref, demoted };
}
