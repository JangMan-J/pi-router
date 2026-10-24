/**
 * The decision "card" for one user turn: a byte-exact port of `build_state()` in
 * bench/sample_states.py, so live decisions see the same input the bench numbers were measured on.
 *
 * Python semantics that matter for parity are reproduced explicitly: string lengths and slices count
 * code points, `\b`/`\s`/`\d` are Unicode-aware, `str.strip()` uses Python's whitespace set, and
 * `json.dumps()` uses its default separators with ASCII escaping. test/state.test.ts checks this
 * against fixtures written by scripts/make_parity_fixtures.py.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = Record<string, any>;

/** A session entry as stored in the session jsonl (`ctx.sessionManager.getBranch()` items). */
export type BranchEntry = Obj;

export interface ToolActivity {
	tool: string | null;
	args: string;
	error: boolean;
	output: string;
}

export interface Signals {
	user_turn_index: number;
	tool_errors_last_5: number;
	repeated_error_fingerprint_count: number;
	successful_edits_since_last_user: number;
	tests_run_since_last_user: number;
	tests_failed_since_last_user: number;
}

export interface CardState {
	project: string;
	user_message: string;
	user_attached_image: boolean;
	previous_user_message: string;
	previous_assistant_reply: string;
	recent_tool_activity: ToolActivity[];
	recent_injected_messages: { type: string | null; content: string }[];
	signals: Signals;
}

// ---- Python compatibility ----------------------------------------------------------------------

/** Characters for which Python's `str.isspace()` is true (and so `\s` in a str pattern). */
const PY_SPACE = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
/** Python's `\w` for str patterns: alphanumeric or underscore. */
const PY_WORD = "[\\p{L}\\p{N}_]";
/** `\b` before a word character. */
const B = `(?<!${PY_WORD})`;
/** `\b` after a word character. */
const B_END = `(?!${PY_WORD})`;
const SURROGATE = /[\uD800-\uDFFF]/;
const PY_STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "gu");

const cpLen = (s: string): number => (SURROGATE.test(s) ? Array.from(s).length : s.length);

/** `s[start:end]` in code points, with Python's negative-index rules for start/end. */
function cpSlice(s: string, start: number, end?: number): string {
	if (!SURROGATE.test(s)) return s.slice(start, end);
	return Array.from(s).slice(start, end).join("");
}

export const pyStrip = (s: string): string => s.replace(PY_STRIP, "");

function pyTruthy(v: unknown): boolean {
	if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
	if (Array.isArray(v)) return v.length > 0;
	if (typeof v === "object") return Object.keys(v as object).length > 0;
	return true;
}

const isDict = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** JSON numbers lose the int/float distinction in JS; `1.0` prints as `1` here but `1.0` in Python. */
function pyFloat(n: number): string {
	if (Number.isNaN(n)) return "NaN";
	if (!Number.isFinite(n)) return n > 0 ? "Infinity" : "-Infinity";
	return String(n);
}

/** Python `json.dumps(o)`: separators ", " and ": ", ensure_ascii=True. */
export function pyJsonDumps(o: unknown): string {
	if (o === null || o === undefined) return "null";
	if (o === true) return "true";
	if (o === false) return "false";
	if (typeof o === "number") return pyFloat(o);
	if (typeof o === "string") {
		let out = '"';
		for (let i = 0; i < o.length; i++) {
			const c = o.charCodeAt(i);
			const ch = o[i];
			if (ch === '"') out += '\\"';
			else if (ch === "\\") out += "\\\\";
			else if (ch === "\n") out += "\\n";
			else if (ch === "\r") out += "\\r";
			else if (ch === "\t") out += "\\t";
			else if (ch === "\b") out += "\\b";
			else if (ch === "\f") out += "\\f";
			else if (c < 0x20 || c > 0x7e) out += `\\u${c.toString(16).padStart(4, "0")}`;
			else out += ch;
		}
		return `${out}"`;
	}
	if (Array.isArray(o)) return `[${o.map(pyJsonDumps).join(", ")}]`;
	if (typeof o === "object") {
		return `{${Object.entries(o as Obj)
			.map(([k, v]) => `${pyJsonDumps(k)}: ${pyJsonDumps(v)}`)
			.join(", ")}}`;
	}
	return "null";
}

/** Python `repr()` of a JSON value, enough for `str()` of tool arguments that are not strings. */
function pyRepr(o: unknown): string {
	if (o === null || o === undefined) return "None";
	if (o === true) return "True";
	if (o === false) return "False";
	if (typeof o === "number") return Number.isInteger(o) ? String(o) : pyFloat(o);
	if (typeof o === "string") {
		const quote = o.includes("'") && !o.includes('"') ? '"' : "'";
		let out = quote;
		for (const ch of o) {
			const c = ch.codePointAt(0)!;
			if (ch === "\\") out += "\\\\";
			else if (ch === quote) out += `\\${quote}`;
			else if (ch === "\n") out += "\\n";
			else if (ch === "\r") out += "\\r";
			else if (ch === "\t") out += "\\t";
			else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, "0")}`;
			else out += ch;
		}
		return out + quote;
	}
	if (Array.isArray(o)) return `[${o.map(pyRepr).join(", ")}]`;
	return `{${Object.entries(o as Obj)
		.map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`)
		.join(", ")}}`;
}

const pyStr = (o: unknown): string => (typeof o === "string" ? o : pyRepr(o));

// ---- patterns (sample_states.py, which takes them from llm-session-ingest src/redact.rs) ---------

const SECRET_PATTERNS: RegExp[] = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----/gsu,
	new RegExp(`${B}sk-[A-Za-z0-9_-]{16,}`, "gu"),
	new RegExp(`${B}gh[pousr]_[A-Za-z0-9]{20,}`, "gu"),
	new RegExp(`${B}github_pat_[A-Za-z0-9_]{20,}`, "gu"),
	new RegExp(`${B}xox[abposr]-[A-Za-z0-9-]{10,}`, "gu"),
	new RegExp(`${B}AIza[0-9A-Za-z_-]{30,}`, "gu"),
	new RegExp(`${B}AKIA[0-9A-Z]{16}${B_END}`, "gu"),
	new RegExp(`${B}hf_[A-Za-z0-9]{30,}`, "gu"),
	new RegExp(`${B}eyJ[A-Za-z0-9_-]{10,}(?:\\.[A-Za-z0-9_+/=-]{10,}){1,2}`, "gu"),
	new RegExp(`${B}eyJ[A-Za-z0-9+/=]{40,}`, "gu"),
	/[A-Za-z0-9+/]{120,}={0,2}/gu,
];
const BEARER = new RegExp(`${B}(Bearer[${PY_SPACE}]+)[A-Za-z0-9._~+/=-]{12,}`, "giu");
const KEYVAL = new RegExp(
	`${B}([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*)([${PY_SPACE}]*[=:][${PY_SPACE}]*["']?)[^${PY_SPACE}"'\\[]{8,}`,
	"gu",
);
const FILE_BLOCK = /<file name="([^"]+)"[^>]*>(.*?)<\/file>/gsu;
const URLCRED = new RegExp(`${B}([a-z][a-z0-9+.-]*://[^${PY_SPACE}:/@]+:)[^${PY_SPACE}@/]+@`, "gu");
const TEST_CMD = new RegExp(
	`${B}(pytest|cargo test|npm test|pnpm test|yarn test|go test|ctest|make test|bun test|vitest|jest)${B_END}`,
	"u",
);
const FINGERPRINT = new RegExp(`\\p{Nd}+|0x[0-9a-f]+|/[^${PY_SPACE}:]+`, "gu");
const EDIT_TOOLS = new Set(["edit", "write"]);

export function redact(text: string): string {
	for (const p of SECRET_PATTERNS) text = text.replace(p, "[REDACTED]");
	text = text.replace(BEARER, "$1[REDACTED]");
	text = text.replace(KEYVAL, "$1$2[REDACTED]");
	return text.replace(URLCRED, "$1[REDACTED]@");
}

export function clip(text: string | null | undefined, n: number): string {
	const t = text || "";
	const len = cpLen(t);
	if (len <= n) return t;
	// text[: n // 2] + marker + text[-n // 2:]
	return `${cpSlice(t, 0, Math.floor(n / 2))}\n…[${len - n} chars cut]…\n${cpSlice(t, Math.floor(-n / 2))}`;
}

export function stubFiles(text: string | null | undefined): string {
	return (text || "").replace(FILE_BLOCK, (_m, name: string, body: string) => `<file name="${name}" chars="${cpLen(body)}"/>`);
}

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!pyTruthy(content) || !Array.isArray(content)) return "";
	return content
		.filter((b) => isDict(b) && b.type === "text")
		.map((b) => (b.text ?? "") as string)
		.join("\n");
}

const hasImage = (content: unknown): boolean =>
	Array.isArray(content) && content.some((b) => isDict(b) && b.type === "image");

/** Tool-call arguments as a dict; older pi versions stored them as a JSON string. */
function callArgs(call: Obj | undefined): Obj {
	let args: unknown = pyTruthy(call) ? (call as Obj).arguments : undefined;
	if (!pyTruthy(args)) args = {};
	if (typeof args === "string") {
		const raw = args;
		try {
			args = JSON.parse(raw);
		} catch {
			return { raw };
		}
	}
	return isDict(args) ? args : { raw: pyStr(args) };
}

function fingerprint(text: string): string {
	return pyStrip(cpSlice(text || "", 0, 300).toLowerCase().replace(FINGERPRINT, "#"));
}

function redactTree<T>(o: T): T {
	if (typeof o === "string") return redact(o) as T;
	if (Array.isArray(o)) return o.map(redactTree) as T;
	if (isDict(o)) return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, redactTree(v)])) as T;
	return o;
}

const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/**
 * Build the card for `target` (a user message) given the branch entries before it, in path order.
 * Mirrors build_state(header, entries, eid) with prefix(entries, eid) == `prefix`.
 */
export function buildState(header: { cwd?: string | null }, prefix: readonly BranchEntry[], target: Obj): CardState {
	const history: Obj[] = prefix.filter((e) => e.type === "message" && isDict(e.message)).map((e) => e.message);
	const injected = prefix.filter(
		(e) =>
			e.type === "custom_message" &&
			typeof e.content === "string" &&
			!String(e.customType === undefined ? "" : (e.customType ?? "None")).startsWith("pi-context-management"),
	);
	const users = history.filter((m) => m.role === "user");
	const lastUser = history.findLastIndex((m) => m.role === "user");
	const since = history.slice(lastUser + 1);
	let prevReply = "";
	for (let i = history.length - 1; i >= 0; i--) {
		const m = history[i];
		if (m.role === "assistant" && pyStrip(textOf(m.content))) {
			prevReply = textOf(m.content);
			break;
		}
	}
	const calls = new Map<unknown, Obj>();
	for (const m of history) {
		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const b of m.content) if (isDict(b) && b.type === "toolCall") calls.set(b.id ?? null, b);
		}
	}
	const callFor = (m: Obj) => calls.get(m.toolCallId ?? null);
	const results = history.filter((m) => m.role === "toolResult");
	const recent: ToolActivity[] = results.slice(-6).map((m) => {
		const args = callArgs(callFor(m) ?? {});
		const brief = pyTruthy(args.command)
			? args.command
			: pyTruthy(args.path)
				? args.path
				: pyTruthy(args.query)
					? args.query
					: pyJsonDumps(args).slice(0, 200);
		return {
			tool: m.toolName ?? null,
			args: clip(pyStr(brief), 240),
			error: pyTruthy(m.isError),
			output: clip(textOf(m.content), 500),
		};
	});
	const last5 = results.slice(-5);
	const errs = results
		.slice(-10)
		.filter((m) => pyTruthy(m.isError))
		.map((m) => fingerprint(textOf(m.content)));
	const counts = new Map<string, number>();
	for (const f of errs) counts.set(f, (counts.get(f) ?? 0) + 1);
	const tests = since.filter((m) => {
		if (m.role !== "toolResult") return false;
		const args = callArgs(callFor(m));
		return TEST_CMD.test(pyStr("command" in args ? args.command : ""));
	});
	const userText = textOf(target.content);
	const cwd = (header.cwd || "").replace(/\/+$/, "");
	const state: CardState = {
		project: basename(cwd) || "~",
		user_message: clip(stubFiles(userText), 4000),
		user_attached_image: hasImage(target.content),
		previous_user_message: users.length ? clip(stubFiles(textOf(users[users.length - 1].content)), 800) : "",
		previous_assistant_reply: clip(prevReply, 1500),
		recent_tool_activity: recent,
		recent_injected_messages: injected.slice(-2).map((e) => ({
			type: e.customType ?? null,
			content: clip(stubFiles(e.content), 500),
		})),
		signals: {
			user_turn_index: users.length,
			tool_errors_last_5: last5.filter((m) => pyTruthy(m.isError)).length,
			repeated_error_fingerprint_count: Math.max(0, ...counts.values()),
			successful_edits_since_last_user: since.filter(
				(m) => m.role === "toolResult" && EDIT_TOOLS.has(m.toolName) && !pyTruthy(m.isError),
			).length,
			tests_run_since_last_user: tests.length,
			tests_failed_since_last_user: tests.filter((m) => pyTruthy(m.isError)).length,
		},
	};
	return redactTree(state);
}

/**
 * The card for the latest user turn of a live session branch. Pi persists the user message before
 * it routes, so it is normally the last user entry of the branch; if the branch does not hold it yet,
 * the latest user message of the request stands in and the whole branch is the prefix.
 */
export function buildLiveState(
	header: { cwd?: string | null },
	branch: readonly BranchEntry[],
	messages: readonly Obj[],
): { state: CardState; entryId: string | null } {
	const isMessage = (role: string) => (e: BranchEntry) => e.type === "message" && e.message?.role === role;
	const idx = branch.findLastIndex(isMessage("user"));
	const fromBranch = () => ({
		state: buildState(header, branch.slice(0, idx), branch[idx].message),
		entryId: (branch[idx].id as string) ?? null,
	});
	// A user entry after the latest response is the message that started this turn.
	if (idx >= 0 && idx > branch.findLastIndex(isMessage("assistant"))) return fromBranch();
	const live = messages.findLast((m) => m.role === "user");
	const persisted = (t: unknown) => branch.some((e) => isMessage("user")(e) && e.message.timestamp === t);
	if (live && !persisted(live.timestamp)) return { state: buildState(header, branch, live), entryId: null };
	if (idx >= 0) return fromBranch();
	return { state: buildState(header, branch, live ?? { role: "user", content: "" }), entryId: null };
}

export type { Json };
