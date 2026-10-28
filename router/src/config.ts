/** config.json: types, loading and the small parsers the policy needs. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROUTER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

export const TIERS = ["basic", "general", "deep"] as const;
export type Tier = (typeof TIERS)[number];
export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const DEPTH_LEVELS = ["0", "1", "2", "3", "unknown"] as const;
export type DepthLevel = (typeof DEPTH_LEVELS)[number];

export interface BackendConfig {
	url: string;
	model?: string;
	/** Model family identifier so paired decider calls select distinct families. */
	family?: string;
	timeout_ms: number;
	auth?: {
		scheme: string;
		auth_json_provider?: string;
		env?: string;
		/** A file holding only the key, e.g. ~/.config/baseten/api_key (mode 600). */
		key_file?: string;
	};
	/** A configured backend switched off is skipped by every caller. */
	enabled?: boolean;
	note?: string;
}

export interface ProfileWhen {
	depth?: DepthLevel[];
	width?: DepthLevel[];
	urgency?: DepthLevel[];
}

export interface ProfileConfig {
	tier: Tier;
	models: string[];
	when?: ProfileWhen;
	why?: string;
}

export interface PivotConfig {
	enabled: boolean;
	/** Relative path from workspace cwd to the project summary stub file. */
	stub_path: string;
	embed_url: string;
	embed_model: string;
	rerank_url: string;
	rerank_model: string;
	timeout_ms: number;
	/** Stage 1 bi-encoder cosine at or above which continuation is kept immediately (when no soft instability). */
	embed_keep_threshold: number;
	/** Stage 1 bi-encoder cosine below which a substantive message with low lexical overlap pivots immediately. */
	embed_pivot_threshold: number;
	/** Stage 2 cross-encoder relevance score below which a pivot is confirmed. */
	rerank_threshold: number;
	/** Hard telemetry instability thresholds that trigger an immediate pivot re-evaluation. */
	repeated_error_threshold: number;
	tool_errors_threshold: number;
	tests_failed_threshold: number;
}

export const DEFAULT_PIVOT_CONFIG: PivotConfig = {
	enabled: true,
	stub_path: ".anchor/router-stub.md",
	embed_url: "http://127.0.0.1:8081/v1/embeddings",
	embed_model: "qwen3-embedding-0.6b",
	rerank_url: "http://127.0.0.1:8082/v1/rerank",
	rerank_model: "qwen3-reranker-0.6b",
	timeout_ms: 800,
	embed_keep_threshold: 0.62,
	embed_pivot_threshold: 0.25,
	rerank_threshold: 0.35,
	repeated_error_threshold: 2,
	tool_errors_threshold: 3,
	tests_failed_threshold: 2,
};

export interface TagRoutingConfig {
	enabled: boolean;
	mappings_path: string;
}

export interface TagMappings {
	as_of?: string;
	source?: string;
	tags: Record<string, Partial<Record<Tier, string[]>>>;
}

export const DEFAULT_TAG_ROUTING_CONFIG: TagRoutingConfig = {
	enabled: true,
	mappings_path: "tag-mappings.json",
};

export interface Config {
	version: string;
	profiles: Record<string, ProfileConfig>;
	fallback_profile: string;
	tiers: Record<Tier, string[]>;
	tier_from_depth: Record<DepthLevel, Tier>;
	unknown_model_tier: Tier;
	fallback_tier: Tier;
	excluded: { model: string }[];
	backends: Record<string, BackendConfig>;
	breaker_ms: number;
	contracts: { goal: string; axes?: string };
	pivot?: Partial<PivotConfig>;
	tag_routing?: Partial<TagRoutingConfig>;
	log_path: string;
}

export function resolvePivotConfig(config: Config): PivotConfig {
	return { ...DEFAULT_PIVOT_CONFIG, ...(config.pivot ?? {}) };
}

export function resolveTagRoutingConfig(config: Config): TagRoutingConfig {
	return { ...DEFAULT_TAG_ROUTING_CONFIG, ...(config.tag_routing ?? {}) };
}

const tagMappingsCache = new Map<string, { mtimeMs: number; data: TagMappings }>();

/** Load dynamic `(tag, tier) -> models[]` mappings synced from `auto-router-probe`, cached by file mtime. */
export function loadTagMappings(config: Config): TagMappings | null {
	const tr = resolveTagRoutingConfig(config);
	if (!tr.enabled || !tr.mappings_path) return null;
	const fullPath = routerPath(tr.mappings_path);
	try {
		if (!existsSync(fullPath)) return null;
		const st = statSync(fullPath);
		const cached = tagMappingsCache.get(fullPath);
		if (cached && cached.mtimeMs === st.mtimeMs) return cached.data;
		const parsed = JSON.parse(readFileSync(fullPath, "utf8")) as TagMappings;
		if (!parsed || typeof parsed.tags !== "object") return null;
		tagMappingsCache.set(fullPath, { mtimeMs: st.mtimeMs, data: parsed });
		return parsed;
	} catch {
		return null;
	}
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

export function loadConfig(path = process.env.ROUTER_AUTO_CONFIG ?? join(ROUTER_DIR, "config.json")): Config {
	const config = JSON.parse(readFileSync(path, "utf8")) as Config;
	if (config.contracts) {
		const contractPath = config.contracts.axes ?? config.contracts.goal;
		if (contractPath) {
			config.contracts.goal = contractPath;
			config.contracts.axes = contractPath;
		}
	}
	validateConfig(config);
	return config;
}

/** Fail at load, not mid-turn, on a config the policy cannot use. */
export function validateConfig(config: Config): void {
	for (const tier of TIERS) {
		if (!Array.isArray(config.tiers?.[tier]) || !config.tiers[tier].length) throw new Error(`router: tier ${tier} is empty`);
		config.tiers[tier].forEach(parseRef);
	}
	if (!config.profiles || typeof config.profiles !== "object" || !Object.keys(config.profiles).length) {
		throw new Error("router: profiles is empty");
	}
	if (!config.fallback_profile || !config.profiles[config.fallback_profile]) {
		throw new Error(`router: unknown fallback_profile ${config.fallback_profile}`);
	}
	for (const [id, profile] of Object.entries(config.profiles)) {
		if (!TIERS.includes(profile.tier)) throw new Error(`router: profile ${id} has unknown tier ${profile.tier}`);
		if (!Array.isArray(profile.models) || !profile.models.length) throw new Error(`router: profile ${id} has no models`);
		profile.models.forEach(parseRef);
		if (profile.when !== undefined) {
			if (!profile.when || typeof profile.when !== "object" || Array.isArray(profile.when)) {
				throw new Error(`router: profile ${id} has invalid when`);
			}
			for (const k of Object.keys(profile.when)) {
				if (k !== "depth" && k !== "width" && k !== "urgency") {
					throw new Error(`router: profile ${id} has unknown when axis ${k}`);
				}
			}
			for (const axis of ["depth", "width", "urgency"] as const) {
				const list = profile.when[axis];
				if (list !== undefined) {
					if (!Array.isArray(list) || !list.length || list.some((lvl) => !DEPTH_LEVELS.includes(lvl))) {
						throw new Error(`router: profile ${id} has invalid when.${axis}`);
					}
				}
			}
		}
	}
	for (const t of [config.unknown_model_tier, config.fallback_tier]) {
		if (!TIERS.includes(t)) throw new Error(`router: unknown tier ${t}`);
	}
	for (const lvl of DEPTH_LEVELS) {
		const mapped = config.tier_from_depth?.[lvl];
		if (!mapped || !TIERS.includes(mapped)) throw new Error(`router: tier_from_depth[${lvl}] is invalid`);
	}
	for (const [id, backend] of Object.entries(config.backends ?? {})) {
		if (!backend.url) throw new Error(`router: backend ${id} has no url`);
		if (!(backend.timeout_ms > 0)) throw new Error(`router: backend ${id} has no timeout_ms`);
	}
	if (!config.contracts?.goal && !config.contracts?.axes) {
		throw new Error("router: contracts.goal is missing");
	}
	if (config.pivot !== undefined) {
		const p = resolvePivotConfig(config);
		if (!(p.timeout_ms > 0)) throw new Error("router: pivot.timeout_ms must be > 0");
		if (p.embed_keep_threshold < p.embed_pivot_threshold) {
			throw new Error("router: pivot.embed_keep_threshold must be >= pivot.embed_pivot_threshold");
		}
	}
}
