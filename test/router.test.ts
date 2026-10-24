/** route() end to end with a fake pi context and fake decision endpoints (injected fetch). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, parseRef } from "../src/config.ts";
import { Deciders } from "../src/deciders.ts";
import type { LogLine } from "../src/log.ts";
import type { RouterState } from "../src/policy.ts";
import { createRouter, type RouteCtx } from "../src/router.ts";

const config = loadConfig();
const USER_TEXT = "please fix the flaky login test, secret words zebra-quartz";

type Spec = Record<string, number | string | undefined>;
type Handler = (backend: string, contract: "history" | "goal") => Spec | "fail";

function answers(spec: Spec, questions: Record<string, any>) {
	const out: Record<string, unknown> = {};
	for (const [k, q] of Object.entries(questions)) {
		const v = spec[k];
		if (q.type === "noul") out[k] = { type: "noul", noul: typeof v === "number" ? v : 0.05 };
		if (q.type === "score") out[k] = { type: "score", score: typeof v === "number" ? v : 1.5 };
		if (q.type === "choice") out[k] = { type: "choice", choice: typeof v === "string" ? v : "other", probabilities: {} };
	}
	return out;
}

function setup(opts: { handler: Handler; rng?: number[]; unavailable?: string[] }) {
	const calls: { backend: string; contract: string }[] = [];
	const lines: LogLine[] = [];
	const fetchImpl = (async (url: string, init: RequestInit) => {
		const backend = url.includes("typesafe") ? "jev" : "local";
		const body = JSON.parse(String(init.body));
		const contract = "task" in body.questions ? "goal" : "history";
		calls.push({ backend, contract });
		const spec = opts.handler(backend, contract);
		if (spec === "fail") return new Response("down", { status: 503 });
		return new Response(JSON.stringify({ answers: answers(spec, body.questions) }), { status: 200 });
	}) as typeof fetch;
	const draws = [...(opts.rng ?? [])];
	const deciders = new Deciders(config.backends, { breakerMs: config.breaker_ms, fetch: fetchImpl, keyFor: () => "k" });
	const router = createRouter({ config, deciders, rng: () => draws.shift() ?? 0.99, log: (l) => lines.push(l), prior: () => null, now: () => new Date(0) });
	return { router, calls, lines };
}

const model = (key: string) => ({ ...parseRef(key), name: key, api: "fake", baseUrl: "", reasoning: true, input: ["text"], contextWindow: 1, maxTokens: 1 }) as any;

function ctx(branch: unknown[], opts: { unavailable?: string[]; throwBranch?: boolean } = {}): RouteCtx & { notes: string[] } {
	const notes: string[] = [];
	return {
		cwd: "/home/u/Projects/demo",
		notes,
		modelRegistry: {
			find: (provider, id) => (id.startsWith("nope") ? undefined : model(`${provider}/${id}`)),
			hasConfiguredAuth: (m) => !(opts.unavailable ?? []).includes(`${m.provider}/${m.id}`),
		},
		sessionManager: {
			getBranch: () => {
				if (opts.throwBranch) throw new Error("branch unavailable");
				return branch;
			},
			getHeader: () => ({ cwd: "/home/u/Projects/demo" }),
			getSessionId: () => "sess-1",
		},
		ui: { notify: (m) => notes.push(m) },
	};
}

let n = 0;
const user = (text: string) => ({ type: "message", id: `u${++n}`, parentId: null, message: { role: "user", content: text, timestamp: n } });
const assistant = (key: string, text = "done") => ({
	type: "message",
	id: `a${++n}`,
	parentId: null,
	message: { role: "assistant", provider: parseRef(key).provider, model: parseRef(key).id, content: [{ type: "text", text }], stopReason: "stop", timestamp: n },
});
const toolError = (id: string) => [
	{ type: "message", id: `c${++n}`, parentId: null, message: { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command: "make" } }], timestamp: n } },
	{ type: "message", id: `r${++n}`, parentId: null, message: { role: "toolResult", toolCallId: id, toolName: "bash", isError: true, content: [{ type: "text", text: "error: build failed" }], timestamp: n } },
];
const msgs = (branch: any[]) => branch.filter((e) => e.type === "message").map((e) => e.message);
const req = (over: Record<string, unknown>) => ({ model: model("router/auto"), thinkingLevel: "medium", reason: "user", messages: [], ...over }) as any;

test("session round trip: pick, keep (same state object), escalate on rejection", async () => {
	const { router, calls, lines } = setup({
		rng: [0.7], // arm jev
		handler: (_b, c) => (c === "goal" ? { task: "code_debugging", difficulty: 1.6, spec_clear: 0.4 } : { new_goal: 0.1, user_rejection: 0.05 }),
	});
	// Turn 1: nothing to keep -> goal questions only.
	const b1 = [user(USER_TEXT)];
	const r1 = await router.route(req({ messages: msgs(b1) }), ctx(b1));
	assert.equal(`${r1.model.provider}/${r1.model.id}:${r1.thinkingLevel}`, "anthropic/claude-sonnet-5-5:medium");
	assert.deepEqual(calls, [{ backend: "jev", contract: "goal" }]);
	const s1 = r1.state as RouterState;
	assert.equal(s1.arm, "jev");
	assert.equal(s1.arm_p, 0.5);
	assert.deepEqual(s1.goal, { task: "code_debugging", difficulty: 1.6, spec_clear: 0.4 });
	assert.equal(s1.last.action, "pick");

	// State goes through the session file as JSON.
	const stored = JSON.parse(JSON.stringify(s1));
	const b2 = [...b1, assistant("anthropic/claude-sonnet-5-5"), user("now the signup test too")];
	const prev = { model: model("anthropic/claude-sonnet-5-5"), thinkingLevel: "medium" };
	const r2 = await router.route(req({ messages: msgs(b2), state: stored, previous: prev }), ctx(b2));
	assert.equal(r2.model, prev.model, "keep returns the previous model object");
	assert.equal(r2.state, stored, "unchanged state is returned as the same object, so pi appends nothing");
	assert.deepEqual(calls.slice(1), [{ backend: "jev", contract: "history" }]);

	// Rejection -> escalate one tier.
	const { router: r3router } = setup({ handler: (_b, c) => (c === "history" ? { new_goal: 0.1, user_rejection: 0.8 } : "fail") });
	const b3 = [...b2, assistant("anthropic/claude-sonnet-5-5"), user("no, that is wrong, you broke it")];
	const r3 = await r3router.route(req({ messages: msgs(b3), state: stored, previous: prev }), ctx(b3));
	assert.equal(`${r3.model.id}:${r3.thinkingLevel}`, "claude-opus-5-5:high");
	const s3 = r3.state as RouterState;
	assert.notEqual(s3, stored);
	assert.equal(s3.arm, "jev", "arm is fixed for the session");
	assert.equal(s3.tier, "deep");
	assert.deepEqual(s3.last, { action: "escalate", reasons: ["agent_fault", "user_rejection", "tier:general->deep"] });
	assert.deepEqual(s3.goal, s1.goal, "goal in force carries over");

	// Log: one line per user turn, no message text.
	assert.equal(lines.length, 2);
	const l1 = lines[0] as any;
	assert.equal(l1.session, "sess-1");
	assert.equal(l1.entry, b1[0].id);
	assert.equal(l1.arm, "jev");
	assert.equal(l1.chosen, "anthropic/claude-sonnet-5-5:medium");
	assert.deepEqual(l1.backend, { history: null, goal: "jev" });
	assert.equal(l1.answers.goal.task.choice, "code_debugging");
	assert.equal(typeof l1.state_hash, "string");
	assert.equal(l1.signals.user_turn_index, 0);
	for (const l of lines) assert.ok(!JSON.stringify(l).includes("zebra-quartz") && !JSON.stringify(l).includes("signup"));
});

test("arm order: the session arm is tried first, the other is the fallback", async () => {
	const { router, calls } = setup({ rng: [0.2], handler: (b) => (b === "local" ? "fail" : { task: "qa_knowledge", difficulty: 0.3 }) });
	const b = [user("what is a monad")];
	const r = await router.route(req({ messages: msgs(b) }), ctx(b));
	assert.deepEqual(calls, [
		{ backend: "local", contract: "goal" },
		{ backend: "jev", contract: "goal" },
	]);
	assert.equal((r.state as RouterState).arm, "local");
	assert.equal(r.model.id, "gpt-6-luna");
});

test("thresholds follow the backend that answered", async () => {
	// 0.33 rejection: over jev's 0.3, under local's 0.359.
	const run = async (arm: number) => {
		const { router } = setup({ rng: [arm], handler: () => ({ new_goal: 0.1, user_rejection: 0.33 }) });
		const b = [user("x"), assistant("anthropic/claude-sonnet-5-5"), user("hmm")];
		const r = await router.route(req({ messages: msgs(b), previous: { model: model("anthropic/claude-sonnet-5-5"), thinkingLevel: "medium" } }), ctx(b));
		return (r.state as RouterState).last.action;
	};
	assert.equal(await run(0.2), "keep"); // local
	assert.equal(await run(0.7), "escalate"); // jev
});

test("all deciders down: first turn takes the fallback tier, later turns keep or escalate on repeated errors", async () => {
	const { router, lines } = setup({ handler: () => "fail" });
	const b1 = [user("hello")];
	const r1 = await router.route(req({ messages: msgs(b1) }), ctx(b1));
	assert.equal(r1.model.id, "claude-sonnet-5-5");
	assert.deepEqual((r1.state as RouterState).last.reasons, ["first_turn", "no_decider", "tier:general"]);
	const prev = { model: model("openai-codex/gpt-6-luna"), thinkingLevel: "low" };
	const b2 = [...b1, assistant("openai-codex/gpt-6-luna"), user("again")];
	const r2 = await router.route(req({ messages: msgs(b2), previous: prev }), ctx(b2));
	assert.equal(r2.model, prev.model);
	const b3 = [...b2, ...toolError("t1"), ...toolError("t2"), ...toolError("t3"), user("still broken")];
	const r3 = await router.route(req({ messages: msgs(b3), previous: prev }), ctx(b3));
	assert.equal(r3.model.id, "claude-sonnet-5-5");
	assert.deepEqual((r3.state as RouterState).last.reasons, ["agent_fault", "repeated_errors", "tier:basic->general"]);
	assert.ok(lines.every((l) => Array.isArray(l.deciders)));
});

test("mid-session switch to router/auto keeps the working model", async () => {
	const { router, calls } = setup({ rng: [0.7], handler: () => ({ new_goal: 0.2, user_rejection: 0.1 }) });
	const b = [user("x"), assistant("anthropic/claude-haiku-5-5"), user("go on")];
	const prev = { model: model("anthropic/claude-haiku-5-5"), thinkingLevel: "low" };
	const r = await router.route(req({ messages: msgs(b), previous: prev }), ctx(b));
	assert.equal(r.model, prev.model);
	assert.equal(r.thinkingLevel, "low");
	assert.deepEqual(calls, [{ backend: "jev", contract: "history" }]);
	assert.equal((r.state as RouterState).tier, "basic");
});

test("continuation and direct stay on the previous model; direct without one takes basic", async () => {
	const { router } = setup({ handler: () => "fail" });
	const prev = { model: model("anthropic/claude-opus-5-5"), thinkingLevel: "high" };
	const c = await router.route(req({ reason: "continuation", previous: prev }), ctx([]));
	assert.equal(c.model, prev.model);
	assert.equal(c.thinkingLevel, "high");
	const d = await router.route(req({ reason: "direct", previous: prev }), ctx([]));
	assert.equal(d.model, prev.model);
	const d2 = await router.route(req({ reason: "direct" }), ctx([], { unavailable: ["openai-codex/gpt-6-luna"] }));
	assert.equal(`${d2.model.id}:${d2.thinkingLevel}`, "gemini-3.8-flash:low");
	// Continuation without a response yet: the router's last pick.
	const st = { v: 1, arm: "jev", arm_p: 0.5, model: "openai-codex/gpt-6-astra", thinking: "medium", tier: "general", lane: null, goal: null, last: { action: "pick", reasons: [] } };
	const c2 = await router.route(req({ reason: "continuation", state: st }), ctx([]));
	assert.equal(c2.model.id, "gpt-6-astra");
});

test("retry: failed model, or a same-tier alternative on overload", async () => {
	const { router, lines } = setup({ handler: () => "fail" });
	const failedMsg = (errorMessage: string) => ({ role: "assistant", stopReason: "error", errorMessage, content: [] });
	const failed = (err: string) => ({ model: model("anthropic/claude-opus-5-5"), thinkingLevel: "high", message: failedMsg(err) });
	const same = await router.route(req({ reason: "retry", failed: failed("context overflow: prompt is too long") }), ctx([]));
	assert.equal(same.model.id, "claude-opus-5-5");
	assert.equal(same.thinkingLevel, "high");
	const st = { v: 1, arm: "jev", arm_p: 0.5, model: "anthropic/claude-opus-5-5", thinking: "high", tier: "deep", lane: null, goal: null, last: { action: "pick", reasons: [] } };
	const alt = await router.route(req({ reason: "retry", failed: failed("529 overloaded_error"), state: st }), ctx([]));
	assert.equal(`${alt.model.id}:${alt.thinkingLevel}`, "gpt-6.1-sol:high");
	assert.equal((alt.state as RouterState).model, "openai-codex/gpt-6.1-sol");
	assert.equal((alt.state as RouterState).last.action, "retry_switch");
	assert.equal(lines.length, 1);
	assert.equal(lines[0].reason, "retry");
	assert.equal(lines[0].to, "openai-codex/gpt-6.1-sol:high");
});

test("route() does not throw when the card cannot be built: it stays put and logs", async () => {
	const { router, lines } = setup({ handler: () => "fail" });
	const prev = { model: model("openai-codex/gpt-6-astra"), thinkingLevel: "medium" };
	const r = await router.route(req({ previous: prev }), ctx([], { throwBranch: true }));
	assert.equal(r.model, prev.model);
	assert.equal(lines[0].action, "fallback");
	assert.match(String(lines[0].error), /branch unavailable/);
});

test("a switch notifies; a keep does not", async () => {
	const { router } = setup({ rng: [0.7], handler: (_b, c) => (c === "goal" ? { task: "writing_creative", difficulty: 2, spec_clear: 0.8 } : { new_goal: 0.1 }) });
	const b = [user("write a poem")];
	const c1 = ctx(b);
	const r = await router.route(req({ messages: msgs(b) }), c1);
	assert.equal(r.model.id, "muse-wonder-full-1.0");
	assert.equal((r.state as RouterState).lane, "creative-prose");
	assert.equal(c1.notes.length, 1);
	assert.match(c1.notes[0], /muse-wonder-full-1.0:medium \(first_turn, lane:creative-prose\)/);
	const b2 = [...b, assistant("meta/muse-wonder-full-1.0"), user("another stanza")];
	const c2 = ctx(b2);
	await router.route(req({ messages: msgs(b2), state: r.state, previous: { model: r.model, thinkingLevel: "medium" } }), c2);
	assert.equal(c2.notes.length, 0);
});
