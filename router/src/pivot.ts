/**
 * Two-stage turn-to-turn pivot detector for continuation turns (`user_turn_index > 0`).
 *
 * Stage 1 (Fast Gate, ~33–140 ms):
 *   - Deterministic telemetry trouble check (`repeated_error_fingerprint_count`, `tool_errors_last_5`,
 *     `tests_failed_since_last_user`). Hard trouble triggers an immediate pivot without model calls.
 *   - Lexical overlap + local bi-encoder (`Qwen3-Embedding-0.6B` on `127.0.0.1:8081/v1/embeddings`)
 *     comparing the cached `goal_embedding` (built from `goal_anchor` + optional `.anchor/router-stub.md`)
 *     against the current user message.
 *   - Clear continuation (`cosine >= embed_keep_threshold` and no soft instability) -> immediate keep.
 *   - Clear rupture (`cosine < embed_pivot_threshold` and low lexical overlap) -> immediate pivot.
 *
 * Stage 2 (Ambiguity / Instability Verifier, ~160–265 ms, invoked only on borderline/unstable turns):
 *   - Activated when Stage 1 detects soft instability (mild tool/test errors, conversational pushback/
 *     course-correction cues) or ambiguous semantic drift (`embed_pivot_threshold <= cosine < embed_keep_threshold`).
 *   - Calls local cross-encoder (`Qwen3-Reranker-0.6B` on `127.0.0.1:8082/v1/rerank`) over
 *     `(project_stub + goal_anchor + previous_assistant_reply, current_user_message)`.
 *   - If `relevance_score < rerank_threshold`, confirms a pivot and triggers the 3-axis decider review.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { PivotConfig } from "./config.ts";
import { type CardState, clip, redact } from "./state.ts";

export interface PivotCheckInput {
	card: CardState;
	goalAnchor: string;
	/** Optional project summary stub loaded from `<cwd>/.anchor/router-stub.md`. */
	projectStub?: string | null;
	goalEmbedding?: number[] | null;
	config: PivotConfig;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}

export interface PivotCheckResult {
	pivot: boolean;
	stage: "disabled" | "signals" | "embed" | "rerank" | "fallback";
	reasons: string[];
	ms: number;
	cosine?: number | null;
	rerankScore?: number | null;
	lexicalOverlap?: number;
	instabilityDetected?: boolean;
	/** Effective goal anchor text (after trivial-opener promotion if applicable). */
	goalAnchor: string;
	/** Cached or newly computed embedding for `composeAnchorText(goalAnchor, projectStub)`. */
	goalEmbedding?: number[] | null;
	/** Newly computed embedding for `card.user_message`. */
	messageEmbedding?: number[] | null;
}

const PIVOT_CUE_RE =
	/\b(nevermind|never mind|forget that|forget it|scratch that|instead|actually|wait|hold on|stop|wrong|not what i|different task|new task|unrelated|switch to|let's move on|move on to)\b/i;

const WORD_RE = /[a-z0-9_]{3,}/g;

export interface ProjectStubInfo {
	summary: string | null;
	tag: string | null;
}

const stubCache = new Map<string, { mtimeMs: number; summary: string | null; tag: string | null }>();

/**
 * Parse `.anchor/router-stub.md` content, extracting an optional `tag:` / `task_type:` metadata
 * field (in YAML frontmatter or leading header lines) and returning clean summary prose.
 */
export function parseProjectStub(raw: string): ProjectStubInfo {
	let body = raw.trim();
	if (!body) return { summary: null, tag: null };

	let tag: string | null = null;
	const parseHeaderLines = (lines: string[]) => {
		for (const line of lines) {
			const m = line.match(/^(?:tag|task_type)\s*:\s*["']?([a-z0-9_:.-]+)["']?\s*$/i);
			if (m) {
				tag = m[1].toLowerCase();
				break;
			}
		}
	};

	if (body.startsWith("---\n") || body.startsWith("---\r\n")) {
		const endIdx = body.indexOf("\n---", 3);
		if (endIdx !== -1) {
			const header = body.slice(3, endIdx).trim();
			parseHeaderLines(header.split(/\r?\n/));
			body = body.slice(endIdx + 4).replace(/^[\r\n]+/, "").trim();
		}
	} else {
		const lines = body.split(/\r?\n/);
		const remaining: string[] = [];
		let inHeader = true;
		for (const line of lines) {
			const trimmed = line.trim();
			if (inHeader && /^(?:tag|task_type)\s*:\s*["']?[a-z0-9_:.-]+["']?\s*$/i.test(trimmed)) {
				parseHeaderLines([trimmed]);
				continue;
			}
			if (inHeader && trimmed === "---") {
				inHeader = false;
				continue;
			}
			if (trimmed !== "") inHeader = false;
			remaining.push(line);
		}
		body = remaining.join("\n").trim();
	}

	const summary = body ? redact(body) : null;
	return { summary, tag };
}

/**
 * Load `<cwd>/.anchor/router-stub.md` (or configured `stub_path`) if present,
 * returning both the summary prose and any optional `tag:` field.
 */
export function loadProjectStubInfo(
	cwd: string | null | undefined,
	stubPath = ".anchor/router-stub.md",
	maxChars = 400,
): ProjectStubInfo {
	if (!cwd) return { summary: null, tag: null };
	const fullPath = isAbsolute(stubPath) ? stubPath : join(cwd, stubPath);
	try {
		const st = statSync(fullPath);
		if (!st.isFile()) return { summary: null, tag: null };
		const cached = stubCache.get(fullPath);
		if (cached && cached.mtimeMs === st.mtimeMs) {
			return {
				summary: cached.summary ? clip(cached.summary, maxChars) : null,
				tag: cached.tag,
			};
		}
		const parsed = parseProjectStub(readFileSync(fullPath, "utf8"));
		stubCache.set(fullPath, { mtimeMs: st.mtimeMs, summary: parsed.summary, tag: parsed.tag });
		return {
			summary: parsed.summary ? clip(parsed.summary, maxChars) : null,
			tag: parsed.tag,
		};
	} catch {
		stubCache.delete(fullPath);
		return { summary: null, tag: null };
	}
}

/**
 * Load `<cwd>/.anchor/router-stub.md` summary text if present.
 * Cached by `(path, mtimeMs)` so subsequent turns only pay a fast `statSync`.
 */
export function loadProjectStub(
	cwd: string | null | undefined,
	stubPath = ".anchor/router-stub.md",
	maxChars = 400,
): string | null {
	return loadProjectStubInfo(cwd, stubPath, maxChars).summary;
}

/** Combine the active task goal with the directory's `.anchor/router-stub.md` (matching the pipeline `contextual` recipe). */
export function composeAnchorText(goalAnchor: string, projectStub?: string | null): string {
	const g = goalAnchor.trim();
	const s = (projectStub ?? "").trim();
	if (!s) return g;
	if (!g) return s;
	return `${g}\n\n---\n${s}`;
}

/**
 * If the session opened with a trivial greeting/ping (`< 4` words, e.g. "testing this") and a
 * substantive message (`>= 4` words) arrives, promote the substantive message to `goal_anchor`.
 */
export function resolveGoalAnchor(
	prevAnchor: string | null | undefined,
	currentMessage: string,
	fallbackPreviousUser = "",
): { anchor: string; promoted: boolean } {
	const base = clip((prevAnchor || fallbackPreviousUser || "").trim(), 600);
	const curr = clip((currentMessage || "").trim(), 600);
	if (!base) return { anchor: curr, promoted: Boolean(curr) };
	const baseWords = extractWords(base);
	const currWords = extractWords(curr);
	if (baseWords.length < 4 && currWords.length >= 4) {
		return { anchor: curr, promoted: true };
	}
	return { anchor: base, promoted: false };
}

export function extractWords(text: string): string[] {
	return text.toLowerCase().match(WORD_RE) ?? [];
}

export function computeLexicalOverlap(anchorText: string, messageText: string): number {
	const msgWords = extractWords(messageText);
	if (msgWords.length === 0) return 1;
	const anchorSet = new Set(extractWords(anchorText));
	if (anchorSet.size === 0) return 0;
	let hits = 0;
	const uniqueMsg = new Set(msgWords);
	for (const w of uniqueMsg) {
		if (anchorSet.has(w)) hits++;
	}
	return hits / uniqueMsg.size;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
	const n = Math.min(a.length, b.length);
	if (n === 0) return 0;
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < n; i++) {
		const va = a[i];
		const vb = b[i];
		dot += va * vb;
		normA += va * va;
		normB += vb * vb;
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom > 0 ? dot / denom : 0;
}

async function fetchEmbeddings(
	texts: string[],
	config: PivotConfig,
	fetchImpl: typeof fetch,
	signal?: AbortSignal,
): Promise<number[][] | null> {
	if (!config.embed_url) return null;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), config.timeout_ms);
	const onAbort = () => ctrl.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const res = await fetchImpl(config.embed_url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: config.embed_model, input: texts }),
			signal: ctrl.signal,
		});
		if (!res.ok) return null;
		const body = (await res.json()) as { data?: { index?: number; embedding?: number[] }[] };
		if (!Array.isArray(body?.data) || body.data.length < texts.length) return null;
		const sorted = [...body.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
		const vectors = sorted.map((d) => d.embedding ?? []);
		return vectors.every((v) => v.length > 0) ? vectors : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

async function fetchRerankScore(
	query: string,
	document: string,
	config: PivotConfig,
	fetchImpl: typeof fetch,
	signal?: AbortSignal,
): Promise<number | null> {
	if (!config.rerank_url) return null;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), config.timeout_ms);
	const onAbort = () => ctrl.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const res = await fetchImpl(config.rerank_url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: config.rerank_model,
				query,
				documents: [document],
			}),
			signal: ctrl.signal,
		});
		if (!res.ok) return null;
		const body = (await res.json()) as { results?: { index?: number; relevance_score?: number }[] };
		const score = body?.results?.[0]?.relevance_score;
		return typeof score === "number" && Number.isFinite(score) ? score : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

export async function checkPivot(input: PivotCheckInput): Promise<PivotCheckResult> {
	const t0 = performance.now();
	const { card, config, signal } = input;
	const fetchImpl = input.fetchImpl ?? fetch;
	const projectStub = input.projectStub ? clip(input.projectStub, 400) : null;
	const { anchor: resolvedAnchor, promoted } = resolveGoalAnchor(
		input.goalAnchor,
		card.user_message || "",
		card.previous_user_message || "",
	);

	if (!config.enabled) {
		return {
			pivot: false,
			stage: "disabled",
			reasons: ["pivot:disabled"],
			ms: 0,
			goalAnchor: resolvedAnchor,
			goalEmbedding: promoted ? null : (input.goalEmbedding ?? null),
		};
	}

	const sig = card.signals;
	const hardReasons: string[] = [];
	if (sig.repeated_error_fingerprint_count >= config.repeated_error_threshold) {
		hardReasons.push(`pivot:repeated_error:${sig.repeated_error_fingerprint_count}`);
	}
	if (sig.tool_errors_last_5 >= config.tool_errors_threshold) {
		hardReasons.push(`pivot:tool_errors:${sig.tool_errors_last_5}`);
	}
	if (sig.tests_failed_since_last_user >= config.tests_failed_threshold) {
		hardReasons.push(`pivot:tests_failed:${sig.tests_failed_since_last_user}`);
	}
	if (hardReasons.length > 0) {
		return {
			pivot: true,
			stage: "signals",
			reasons: hardReasons,
			ms: Math.round((performance.now() - t0) * 10) / 10,
			instabilityDetected: true,
			goalAnchor: resolvedAnchor,
			goalEmbedding: input.goalEmbedding ?? null,
		};
	}

	const prevAnchor = clip(input.goalAnchor || card.previous_user_message || "", 600);
	const userMsg = clip(card.user_message || "", 800);
	if (!userMsg.trim() || !prevAnchor.trim()) {
		return {
			pivot: false,
			stage: "fallback",
			reasons: ["keep:empty_context"],
			ms: Math.round((performance.now() - t0) * 10) / 10,
			goalAnchor: resolvedAnchor,
			goalEmbedding: input.goalEmbedding ?? null,
		};
	}

	// If Turn 0 was a trivial ping ("testing this") and Turn 1 is the first real task (`promoted`),
	// treat Turn 1 as a pivot so it gets a real 3-axis evaluation and locks `resolvedAnchor` as the goal.
	if (promoted) {
		return {
			pivot: true,
			stage: "signals",
			reasons: ["pivot:promoted_trivial_opener"],
			ms: Math.round((performance.now() - t0) * 10) / 10,
			instabilityDetected: true,
			goalAnchor: resolvedAnchor,
			goalEmbedding: null,
		};
	}

	const compositeAnchor = composeAnchorText(resolvedAnchor, projectStub);
	const contextText = `${compositeAnchor}\n${clip(card.previous_assistant_reply || "", 600)}`;
	const lexicalOverlap = computeLexicalOverlap(contextText, userMsg);
	const msgWordCount = extractWords(userMsg).length;

	// Detect soft instability cues that warrant waking Stage 2 (cross-encoder reranker)
	const softInstabilityReasons: string[] = [];
	if (sig.tool_errors_last_5 >= 1) {
		softInstabilityReasons.push(`instability:tool_error:${sig.tool_errors_last_5}`);
	}
	if (sig.tests_failed_since_last_user >= 1) {
		softInstabilityReasons.push(`instability:test_failed:${sig.tests_failed_since_last_user}`);
	}
	if (PIVOT_CUE_RE.test(userMsg)) {
		softInstabilityReasons.push("instability:user_cue");
	}

	// Stage 1: Bi-encoder embedding cosine similarity
	let goalEmb = input.goalEmbedding ?? null;
	let msgEmb: number[] | null = null;
	let cosine: number | null = null;

	if (goalEmb && goalEmb.length > 0) {
		const vecs = await fetchEmbeddings([userMsg], config, fetchImpl, signal);
		if (vecs) msgEmb = vecs[0];
	} else {
		const vecs = await fetchEmbeddings([compositeAnchor, userMsg], config, fetchImpl, signal);
		if (vecs) {
			goalEmb = vecs[0];
			msgEmb = vecs[1];
		}
	}

	if (goalEmb && msgEmb) {
		cosine = Math.round(cosineSimilarity(goalEmb, msgEmb) * 1000) / 1000;
	}

	// Fast keep (Green Zone): high semantic similarity (or short follow-up with decent similarity) and zero soft instability
	if (cosine !== null && softInstabilityReasons.length === 0) {
		const isShortContinuation = msgWordCount <= 10 && (cosine >= config.embed_pivot_threshold || lexicalOverlap >= 0.25);
		if (cosine >= config.embed_keep_threshold || isShortContinuation) {
			return {
				pivot: false,
				stage: "embed",
				reasons: [`keep:embed_cos:${cosine.toFixed(3)}`, `lex:${lexicalOverlap.toFixed(2)}`],
				ms: Math.round((performance.now() - t0) * 10) / 10,
				cosine,
				lexicalOverlap,
				instabilityDetected: false,
				goalAnchor: resolvedAnchor,
				goalEmbedding: goalEmb,
				messageEmbedding: msgEmb,
			};
		}
		// Fast pivot (Red Zone): extreme semantic rupture and near-zero lexical overlap on a substantive message
		if (cosine < config.embed_pivot_threshold && lexicalOverlap < 0.1 && msgWordCount >= 6) {
			return {
				pivot: true,
				stage: "embed",
				reasons: [`pivot:embed_cos:${cosine.toFixed(3)}`, `lex:${lexicalOverlap.toFixed(2)}`],
				ms: Math.round((performance.now() - t0) * 10) / 10,
				cosine,
				lexicalOverlap,
				instabilityDetected: true,
				goalAnchor: resolvedAnchor,
				goalEmbedding: goalEmb,
				messageEmbedding: msgEmb,
			};
		}
	}

	// Stage 2: Ambiguous drift or soft instability detected -> invoke Cross-Encoder Reranker (`Qwen3-Reranker-0.6B`)
	const instabilityDetected =
		softInstabilityReasons.length > 0 || (cosine !== null && cosine < config.embed_keep_threshold);
	const rerankQuery = projectStub
		? `Project context: ${projectStub}\nSession goal: ${resolvedAnchor}\nPrevious assistant reply: ${clip(card.previous_assistant_reply || "", 500)}`
		: `Session goal: ${resolvedAnchor}\nPrevious assistant reply: ${clip(card.previous_assistant_reply || "", 500)}`;
	const rerankScoreRaw = await fetchRerankScore(rerankQuery, userMsg, config, fetchImpl, signal);

	if (rerankScoreRaw !== null) {
		const rerankScore = Math.round(rerankScoreRaw * 10000) / 10000;
		const isPivot = rerankScore < config.rerank_threshold;
		const reasons = [
			...softInstabilityReasons,
			...(cosine !== null ? [`embed_cos:${cosine.toFixed(3)}`] : []),
			`lex:${lexicalOverlap.toFixed(2)}`,
			`${isPivot ? "pivot" : "keep"}:rerank:${rerankScore.toFixed(4)}`,
		];
		return {
			pivot: isPivot,
			stage: "rerank",
			reasons,
			ms: Math.round((performance.now() - t0) * 10) / 10,
			cosine,
			rerankScore,
			lexicalOverlap,
			instabilityDetected,
			goalAnchor: resolvedAnchor,
			goalEmbedding: goalEmb,
			messageEmbedding: msgEmb,
		};
	}

	// Fallback if reranker is unreachable: rely on bi-encoder cosine if available, else keep
	if (cosine !== null && cosine < config.embed_pivot_threshold) {
		return {
			pivot: true,
			stage: "fallback",
			reasons: [...softInstabilityReasons, `pivot:embed_fallback:${cosine.toFixed(3)}`],
			ms: Math.round((performance.now() - t0) * 10) / 10,
			cosine,
			lexicalOverlap,
			instabilityDetected,
			goalAnchor: resolvedAnchor,
			goalEmbedding: goalEmb,
			messageEmbedding: msgEmb,
		};
	}

	return {
		pivot: false,
		stage: "fallback",
		reasons: [
			...softInstabilityReasons,
			...(cosine !== null ? [`keep:embed_fallback:${cosine.toFixed(3)}`] : ["keep:local_unreachable"]),
		],
		ms: Math.round((performance.now() - t0) * 10) / 10,
		cosine,
		lexicalOverlap,
		instabilityDetected,
		goalAnchor: resolvedAnchor,
		goalEmbedding: goalEmb,
		messageEmbedding: msgEmb,
	};
}
