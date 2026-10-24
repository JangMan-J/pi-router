/**
 * Optional outcome prior (~/.local/share/route-prior/prior.json, built by another job):
 * {"version","generated_at","models":{"<provider>/<id>":{alpha,beta,n}},"cells":{"<provider>/<id>|<task>":{alpha,beta,n}}}
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

/** The prior if the file exists and parses; re-read only when its mtime changes. */
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
		if (p && typeof p.models === "object" && typeof p.cells === "object") prior = p;
	} catch {
		prior = null;
	}
	cache = { path, mtimeMs, prior };
	return prior;
}

const mean = (b: Beta) => b.alpha / (b.alpha + b.beta);
const usable = (b: Beta | undefined): b is Beta => !!b && b.alpha > 0 && b.beta > 0;

/** Posterior mean for a model on a task: the task cell when it has min_n outcomes, else the model, else 0.5. */
export function score(prior: Prior, key: string, task: string | null, minN: number): { mean: number; source: "cell" | "model" | "none" } {
	const cell = task ? prior.cells[`${key}|${task}`] : undefined;
	if (usable(cell) && cell.n >= minN) return { mean: mean(cell), source: "cell" };
	const model = prior.models[key];
	if (usable(model)) return { mean: mean(model), source: "model" };
	return { mean: 0.5, source: "none" };
}

export interface Choice {
	index: number;
	/** Probability that this policy picks this candidate on this turn. */
	propensity: number;
	explored: boolean;
	scores?: number[];
}

/**
 * Pick among candidates (config order). No prior: the first, propensity 1. With a prior: the best
 * posterior mean (ties go to config order), except with probability epsilon a uniform pick.
 */
export function choose(
	keys: readonly string[],
	prior: Prior | null,
	task: string | null,
	epsilon: number,
	minN: number,
	rng: () => number,
): Choice {
	if (!prior || keys.length <= 1) return { index: 0, propensity: 1, explored: false };
	const scores = keys.map((k) => score(prior, k, task, minN).mean);
	const greedy = scores.indexOf(Math.max(...scores));
	const explored = rng() < epsilon;
	const index = explored ? Math.min(keys.length - 1, Math.floor(rng() * keys.length)) : greedy;
	const propensity = (index === greedy ? 1 - epsilon : 0) + epsilon / keys.length;
	return { index, propensity, explored, scores: scores.map((s) => Math.round(s * 1e4) / 1e4) };
}
