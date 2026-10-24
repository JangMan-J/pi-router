/** config.json: types, loading and the small parsers the policy needs. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROUTER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

export const TIERS = ["basic", "general", "deep"] as const;
export type Tier = (typeof TIERS)[number];
export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** A condition on one answer: a list of allowed choices, or a comparison such as ">=0.7" or ">=theta". */
export type Condition = string[] | string;

export interface Lane {
	id: string;
	model: string;
	when: Record<string, Condition>;
	why?: string;
}

export interface NeverRule {
	id: string;
	models: string[];
	when_any: Record<string, Condition>;
	why?: string;
}

export interface Thresholds {
	new_goal: number;
	user_rejection: number;
	false_success: number;
	provenance?: string;
}

export interface BackendConfig {
	url: string;
	model?: string;
	timeout_ms: number;
	auth?: { scheme: string; auth_json_provider?: string; env?: string };
}

export interface Config {
	version: string;
	tiers: Record<Tier, string[]>;
	tier_from_difficulty: { basic_below: number; general_below: number };
	unknown_model_tier: Tier;
	fallback_tier: Tier;
	lanes: Lane[];
	never: NeverRule[];
	probation: { model: string }[];
	excluded: { model: string }[];
	repeated_error_threshold: number;
	thresholds: Record<string, Thresholds>;
	backends: Record<string, BackendConfig>;
	arms: Record<string, number>;
	breaker_ms: number;
	prior: { path: string; epsilon: number; min_n: number };
	contracts: { history: string; goal: string };
	log_path: string;
}

/** `provider/id:thinking` split into its parts; `key` is `provider/id`. */
export interface ModelRef {
	provider: string;
	id: string;
	thinking?: Thinking;
	key: string;
}

export function parseRef(ref: string): ModelRef {
	const slash = ref.indexOf("/");
	if (slash <= 0) throw new Error(`router: bad model ref ${ref}`);
	const colon = ref.lastIndexOf(":");
	const hasLevel = colon > slash;
	const provider = ref.slice(0, slash);
	const id = ref.slice(slash + 1, hasLevel ? colon : undefined);
	return { provider, id, key: `${provider}/${id}`, ...(hasLevel ? { thinking: ref.slice(colon + 1) as Thinking } : {}) };
}

export const expandHome = (p: string): string => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
export const routerPath = (p: string): string => (isAbsolute(expandHome(p)) ? expandHome(p) : join(ROUTER_DIR, p));

/** `*` matches any run of characters; everything else is literal. */
export function globMatch(pattern: string, value: string): boolean {
	const re = new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
	return re.test(value);
}

/**
 * Whether `value` satisfies `cond`. A list holds when it contains the value; a comparison holds on a
 * number. `theta` in a comparison means the backend's threshold for the same question. A missing value
 * never satisfies a condition.
 */
export function holds(cond: Condition, value: unknown, theta?: number): boolean {
	if (value === undefined || value === null) return false;
	if (Array.isArray(cond)) return cond.includes(value as string);
	const m = /^\s*(>=|<=|>|<|==)\s*(theta|-?\d+(?:\.\d+)?)\s*$/.exec(cond);
	if (!m || typeof value !== "number") return false;
	const rhs = m[2] === "theta" ? theta : Number(m[2]);
	if (rhs === undefined) return false;
	switch (m[1]) {
		case ">=":
			return value >= rhs;
		case "<=":
			return value <= rhs;
		case ">":
			return value > rhs;
		case "<":
			return value < rhs;
		default:
			return value === rhs;
	}
}

export function loadConfig(path = process.env.ROUTER_AUTO_CONFIG ?? join(ROUTER_DIR, "config.json")): Config {
	const config = JSON.parse(readFileSync(path, "utf8")) as Config;
	validateConfig(config);
	return config;
}

/** Fail at load, not mid-turn, on a config the policy cannot use. */
export function validateConfig(config: Config): void {
	for (const tier of TIERS) {
		if (!Array.isArray(config.tiers?.[tier]) || !config.tiers[tier].length) throw new Error(`router: tier ${tier} is empty`);
		config.tiers[tier].forEach(parseRef);
	}
	for (const lane of config.lanes ?? []) parseRef(lane.model);
	for (const t of [config.unknown_model_tier, config.fallback_tier]) {
		if (!TIERS.includes(t)) throw new Error(`router: unknown tier ${t}`);
	}
	for (const arm of Object.keys(config.arms)) {
		if (!config.backends[arm]) throw new Error(`router: arm ${arm} has no backend`);
		if (!config.thresholds[arm]) throw new Error(`router: backend ${arm} has no thresholds`);
	}
}
