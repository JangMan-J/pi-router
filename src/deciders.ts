/**
 * System One decision endpoints, called with plain fetch exactly as bench/run_arm.py calls them:
 * POST {state, questions[, model]} with wire `noul` questions, so live answers come from the same
 * prompt the bench measured. Not through modelRegistry.classify(), which rewrites `noul` to `bool`.
 *
 * One attempt per backend (no retries); any failure opens that backend's breaker and the next
 * backend is tried. ask() never throws.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BackendConfig } from "./config.ts";
import { pyJsonDumps } from "./state.ts";

export interface Question {
	type: "noul" | "choice" | "score";
	instructions: string;
	criteria?: Record<string, string> | string[];
	requires_history?: boolean;
}

export interface Contract {
	name: string;
	/** sha256[:12] of the contract file bytes, as run_arm.py records it. */
	hash: string;
	questions: Record<string, Question>;
}

export type Answer =
	| { type: "noul"; noul: number }
	| { type: "choice"; choice: string; confidence?: number; probabilities: Record<string, number> }
	| { type: "score"; score: number; confidence?: number; probabilities?: Record<string, number> };
export type Answers = Record<string, Answer>;

export interface DeciderCall {
	backend: string;
	contract: string;
	ms: number;
	ok: boolean;
	status?: number;
	error?: string;
	problems?: string[];
	skipped?: "breaker_open" | "no_key";
}

export interface AskResult {
	/** Backend whose answers were used, or null when every backend failed. */
	backend: string | null;
	answers: Answers | null;
	calls: DeciderCall[];
}

export function loadContract(path: string): Contract {
	const raw = readFileSync(path);
	const parsed = JSON.parse(raw.toString("utf8"));
	return {
		name: parsed.contract,
		hash: createHash("sha256").update(raw).digest("hex").slice(0, 12),
		questions: parsed.questions,
	};
}

/** Questions as sent: run_arm.py's questions_for() (history gating, `requires_history`/`gold` stripped). */
export function questionsFor(contract: Contract, hasHistory: boolean): Record<string, Omit<Question, "requires_history">> {
	const out: Record<string, Omit<Question, "requires_history">> = {};
	for (const [key, q] of Object.entries(contract.questions)) {
		if (!hasHistory && q.requires_history) continue;
		out[key] = Object.fromEntries(Object.entries(q).filter(([f]) => f !== "requires_history" && f !== "gold")) as Question;
	}
	return out;
}

/** run_arm.py validate(): empty when every question has a well-typed answer. */
export function validate(data: unknown, questions: Record<string, { type: string; criteria?: unknown }>): string[] {
	const answers = (data as { answers?: unknown } | null)?.answers;
	if (typeof data !== "object" || data === null || typeof answers !== "object" || answers === null || Array.isArray(answers)) {
		return ["no answers object"];
	}
	const problems: string[] = [];
	const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);
	for (const [key, q] of Object.entries(questions)) {
		const a = (answers as Record<string, any>)[key];
		if (typeof a !== "object" || a === null || Array.isArray(a)) problems.push(`${key}: missing`);
		else if (q.type === "noul" && !isNum(a.noul)) problems.push(`${key}: no noul probability`);
		else if (
			q.type === "choice" &&
			(typeof a.choice !== "string" ||
				!(Array.isArray(q.criteria) ? q.criteria.includes(a.choice) : Object.hasOwn(q.criteria ?? {}, a.choice)) ||
				typeof a.probabilities !== "object" ||
				a.probabilities === null ||
				Array.isArray(a.probabilities))
		)
			problems.push(`${key}: bad choice/probabilities`);
		else if (q.type === "score" && !isNum(a.score)) problems.push(`${key}: no score`);
	}
	return problems;
}

/** Numbers only: the log and the router state never carry free text from a decider. */
export function compactAnswers(answers: Answers | null): Record<string, unknown> | null {
	if (!answers) return null;
	const out: Record<string, unknown> = {};
	for (const [key, a] of Object.entries(answers)) {
		const x = a as Record<string, unknown>;
		if (typeof x.noul === "number") out[key] = x.noul;
		else if (typeof x.choice === "string") out[key] = { choice: x.choice, p: x.probabilities };
		else if (typeof x.score === "number") out[key] = { score: x.score, p: x.probabilities };
	}
	return out;
}

export interface DecidersOptions {
	breakerMs: number;
	fetch?: typeof fetch;
	now?: () => number;
	/** API key for a backend; default reads the pi auth.json entry, then the env variable. */
	keyFor?: (backend: BackendConfig) => string | undefined;
}

export function defaultKeyFor(backend: BackendConfig): string | undefined {
	const auth = backend.auth;
	if (!auth) return undefined;
	if (auth.auth_json_provider) {
		try {
			const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
			const entry = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"))[auth.auth_json_provider];
			if (typeof entry?.key === "string" && entry.key) return entry.key;
		} catch {
			/* no auth.json: fall through to the env variable */
		}
	}
	return auth.env ? process.env[auth.env] || undefined : undefined;
}

export class Deciders {
	private readonly openUntil = new Map<string, number>();
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => number;
	private readonly keyFor: (backend: BackendConfig) => string | undefined;
	readonly backends: Record<string, BackendConfig>;
	private readonly opts: DecidersOptions;

	constructor(backends: Record<string, BackendConfig>, opts: DecidersOptions) {
		this.backends = backends;
		this.opts = opts;
		this.fetchImpl = opts.fetch ?? fetch;
		this.now = opts.now ?? Date.now;
		this.keyFor = opts.keyFor ?? defaultKeyFor;
	}

	isOpen(backend: string): boolean {
		return (this.openUntil.get(backend) ?? 0) > this.now();
	}

	/** Try `order` in turn; the first backend that returns valid answers wins. */
	async ask(order: readonly string[], contract: Contract, state: unknown, hasHistory: boolean, signal?: AbortSignal): Promise<AskResult> {
		const questions = questionsFor(contract, hasHistory);
		const calls: DeciderCall[] = [];
		for (const id of order) {
			const backend = this.backends[id];
			if (!backend) continue;
			if (signal?.aborted) break;
			if (this.isOpen(id)) {
				calls.push({ backend: id, contract: contract.name, ms: 0, ok: false, skipped: "breaker_open" });
				continue;
			}
			const call = await this.once(id, backend, contract, questions, state, signal);
			calls.push(call.record);
			if (call.answers) return { backend: id, answers: call.answers, calls };
			// A user abort is not the backend's fault.
			if (!signal?.aborted) this.openUntil.set(id, this.now() + this.opts.breakerMs);
		}
		return { backend: null, answers: null, calls };
	}

	private async once(
		id: string,
		backend: BackendConfig,
		contract: Contract,
		questions: Record<string, Omit<Question, "requires_history">>,
		state: unknown,
		signal?: AbortSignal,
	): Promise<{ record: DeciderCall; answers?: Answers }> {
		const t0 = performance.now();
		const ms = () => Math.round((performance.now() - t0) * 10) / 10;
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (backend.auth) {
			const key = this.keyFor(backend);
			if (!key) return { record: { backend: id, contract: contract.name, ms: 0, ok: false, skipped: "no_key", error: "no API key" } };
			headers.Authorization = `${backend.auth.scheme} ${key}`;
		}
		const body: Record<string, unknown> = { state, questions };
		if (backend.model) body.model = backend.model;
		const timeout = AbortSignal.timeout(backend.timeout_ms);
		try {
			const res = await this.fetchImpl(backend.url, {
				method: "POST",
				headers,
				body: pyJsonDumps(body),
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			});
			const text = await res.text();
			if (res.status !== 200) {
				return { record: { backend: id, contract: contract.name, ms: ms(), ok: false, status: res.status, error: text.slice(0, 200) } };
			}
			let data: unknown;
			try {
				data = JSON.parse(text);
			} catch {
				return { record: { backend: id, contract: contract.name, ms: ms(), ok: false, status: 200, error: "invalid JSON" } };
			}
			const problems = validate(data, questions);
			if (problems.length) return { record: { backend: id, contract: contract.name, ms: ms(), ok: false, status: 200, problems } };
			return { record: { backend: id, contract: contract.name, ms: ms(), ok: true, status: 200 }, answers: (data as { answers: Answers }).answers };
		} catch (e) {
			const err = e as Error;
			const error = timeout.aborted ? `timeout ${backend.timeout_ms} ms` : signal?.aborted ? "aborted" : `${err.name}: ${err.message}`;
			return { record: { backend: id, contract: contract.name, ms: ms(), ok: false, error: error.slice(0, 200) } };
		}
	}
}
