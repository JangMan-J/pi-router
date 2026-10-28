#!/usr/bin/env node
/**
 * Syncs the latest `auto-router-probe` sweep (`data/<YYYY-MM-DD>/`) into
 * `router/tag-mappings.json`, normalizing OpenRouter permaslugs to `pi`
 * catalogue keys (`provider/id`) and filtering out uncatalogued or excluded models.
 *
 * Usage:
 *   node router/scripts/sync-probe-mappings.ts [probe_data_dir]
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { globMatch, loadConfig, type Tier } from "../src/config.ts";

const ROUTER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PROBE_ROOT = resolve(ROUTER_DIR, "../../auto-router-probe/data");
const CATALOGUE_PATH = resolve(ROUTER_DIR, "../pipeline/catalogue.json");
const OUT_PATH = join(ROUTER_DIR, "tag-mappings.json");

export interface TagTierMap {
	basic: string[];
	general: string[];
	deep: string[];
}

export interface TagMappingsFile {
	as_of: string;
	source: string;
	notes: string;
	tags: Record<string, TagTierMap>;
}

const EXPLICIT_SLUG_MAP: Record<string, string> = {
	"anthropic/claude-opus-5.5": "anthropic/claude-opus-5-5",
	"anthropic/claude-sonnet-5.5": "anthropic/claude-sonnet-5-5",
	"anthropic/claude-haiku-5.5": "anthropic/claude-haiku-5-5",
	"anthropic/claude-4.6-opus": "anthropic/claude-opus-4-6",
	"anthropic/claude-4.5-sonnet": "anthropic/claude-sonnet-4-5",
	"anthropic/claude-fable-5.1": "anthropic/claude-fable-5-1",
	"google/gemini-2.5-flash": "antigravity/gemini-2.5-flash",
	"google/gemini-3.1-flash-lite": "antigravity/gemini-3.1-flash-lite",
	"google/gemini-3.5-flash": "antigravity/gemini-3.5-flash",
	"google/gemini-3.5-flash-lite": "antigravity/gemini-3.5-flash-lite",
	"google/gemini-3.8-flash": "antigravity/gemini-3.8-flash",
	"google/gemini-4-argon": "antigravity/gemini-4-argon",
	"meta/muse-wonder": "meta/muse-wonder-1.0",
	"moonshotai/kimi-k3": "kimi-coding/k3",
	"moonshotai/kimi-k3.1-pro": "kimi-coding/k3.1-pro",
	"openai/gpt-6-astra": "openai-codex/gpt-6-astra",
	"openai/gpt-6-astra-pro": "openai-codex/gpt-6-astra",
	"openai/gpt-6-luna": "openai-codex/gpt-6-luna",
	"openai/gpt-6-sol": "openai-codex/gpt-6-sol",
	"openai/gpt-6.1-sol": "openai-codex/gpt-6.1-sol",
	"openai/gpt-6.1-terra": "openai-codex/gpt-6.1-terra",
	"x-ai/grok-4.7": "xai/grok-4.7",
	"x-ai/grok-4.6": "xai/grok-4.6",
	"x-ai/grok-4.5": "xai/grok-4.5",
};

const PROVIDER_MAP: Record<string, string> = {
	anthropic: "anthropic",
	google: "antigravity",
	"x-ai": "xai",
	openai: "openai-codex",
	moonshotai: "kimi-coding",
	meta: "meta",
};

export function normalizeOpenRouterSlug(
	rawSlug: string,
	catalogueSet: ReadonlySet<string>,
): string | null {
	const stripped = rawSlug.trim().replace(/-\d{8}$/, "");
	const explicit = EXPLICIT_SLUG_MAP[stripped];
	if (explicit && catalogueSet.has(explicit)) return explicit;
	if (catalogueSet.has(stripped)) return stripped;

	const slash = stripped.indexOf("/");
	if (slash <= 0) return null;
	const orProvider = stripped.slice(0, slash);
	const orModel = stripped.slice(slash + 1);
	const piProvider = PROVIDER_MAP[orProvider] ?? orProvider;

	for (const candidateModel of [orModel, orModel.replace(/\./g, "-")]) {
		const candidate = `${piProvider}/${candidateModel}`;
		if (catalogueSet.has(candidate)) return candidate;
	}
	return null;
}

function findLatestSweepDir(rootDir: string): string {
	if (!existsSync(rootDir)) throw new Error(`probe root not found: ${rootDir}`);
	// If passed a specific date directory directly
	if (existsSync(join(rootDir, "responses")) || existsSync(join(rootDir, "tag-sweep"))) {
		return rootDir;
	}
	const dirs = readdirSync(rootDir)
		.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && statSync(join(rootDir, d)).isDirectory())
		.sort();
	if (!dirs.length) throw new Error(`no dated sweep directories in ${rootDir}`);
	return join(rootDir, dirs[dirs.length - 1]);
}

export function buildTagMappings(sweepDir: string): TagMappingsFile {
	const config = loadConfig();
	const catalogueRaw = JSON.parse(readFileSync(CATALOGUE_PATH, "utf8")) as {
		models?: { provider: string; model: string }[];
	};
	const catalogueSet = new Set((catalogueRaw.models ?? []).map((m) => `${m.provider}/${m.model}`));
	const isExcluded = (key: string) =>
		(config.excluded ?? []).some((e) => typeof e.model === "string" && globMatch(e.model, key));

	const respDir = existsSync(join(sweepDir, "responses"))
		? join(sweepDir, "responses")
		: join(sweepDir, "tag-sweep");
	if (!existsSync(respDir)) {
		throw new Error(`no responses/ or tag-sweep/ directory inside ${sweepDir}`);
	}

	const tags: Record<string, TagTierMap> = {};
	const ensureTag = (t: string): TagTierMap => {
		if (!tags[t]) tags[t] = { basic: [], general: [], deep: [] };
		return tags[t];
	};
	const addUnique = (list: string[], item: string) => {
		if (!list.includes(item)) list.push(item);
	};

	const tierMap: Record<string, Tier> = {
		low: "basic",
		default: "general",
		medium: "general",
		high: "deep",
		xhigh: "deep",
		max: "deep",
	};

	const files = readdirSync(respDir).filter((f) => f.endsWith(".json")).sort();
	for (const file of files) {
		const m = file.match(/^(.+)__(low|default|medium|high|xhigh|max)\.json$/);
		if (!m) continue;
		const rawTier = m[2];
		const targetTier = tierMap[rawTier];
		if (!targetTier) continue;

		const body = JSON.parse(readFileSync(join(respDir, file), "utf8")) as {
			openrouter_metadata?: {
				pipeline?: {
					data?: {
						task_type?: string;
						resolved_to?: string;
						fallback_models?: string[];
					};
				}[];
			};
		};
		const data = body.openrouter_metadata?.pipeline?.[0]?.data;
		if (!data) continue;

		const rawCandidates = [
			...(data.resolved_to ? [data.resolved_to] : []),
			...(data.fallback_models ?? []),
		];
		const validModels: string[] = [];
		for (const slug of rawCandidates) {
			const norm = normalizeOpenRouterSlug(slug, catalogueSet);
			if (norm && !isExcluded(norm)) {
				addUnique(validModels, norm);
			}
		}
		if (!validModels.length) continue;

		// Recover exact intended tag name (e.g. code_frontend_ui -> code:frontend_ui, content_writing -> content_writing)
		const macroPrefix = m[1].match(/^(agent|code|data)_(.+)$/);
		const canonicalIntended = macroPrefix ? `${macroPrefix[1]}:${macroPrefix[2]}` : m[1];
		const classifiedTag = data.task_type && data.task_type !== "-" ? data.task_type : canonicalIntended;

		for (const tagKey of [canonicalIntended, classifiedTag]) {
			const entry = ensureTag(tagKey);
			for (const modelKey of validModels) {
				addUnique(entry[targetTier], modelKey);
			}
		}
	}

	const sortedTags: Record<string, TagTierMap> = {};
	for (const k of Object.keys(tags).sort()) {
		sortedTags[k] = tags[k];
	}

	const asOf = sweepDir.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? new Date().toISOString().slice(0, 10);
	const home = homedir();
	const prettySource = sweepDir.startsWith(`${home}/`) ? `~/${sweepDir.slice(home.length + 1)}` : sweepDir;
	return {
		as_of: asOf,
		source: prettySource,
		notes: "Auto-generated from auto-router-probe sweep responses, normalized to pi catalogue models and filtered by router/config.json exclusions. Used only when a project's .anchor/router-stub.md specifies an optional tag.",
		tags: sortedTags,
	};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const targetDir = process.argv[2] ? resolve(process.argv[2]) : findLatestSweepDir(DEFAULT_PROBE_ROOT);
	const out = buildTagMappings(targetDir);
	writeFileSync(OUT_PATH, `${JSON.stringify(out, null, "\t")}\n`);
	console.log(`synced ${Object.keys(out.tags).length} tags from ${out.source} (as_of ${out.as_of}) -> ${OUT_PATH}`);
}
