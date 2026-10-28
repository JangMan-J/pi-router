/** Decider client against fake System One servers on 127.0.0.1. */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { routerPath } from "../src/config.ts";
import { compactAnswers, type Contract, Deciders, loadContract, questionsFor, selectPair, validate } from "../src/deciders.ts";
import { pyJsonDumps } from "../src/state.ts";

const history: Contract = {
	name: "test-history",
	hash: "000000000000",
	questions: {
		new_goal: { type: "noul", instructions: "Is this a new goal?", requires_history: true },
		user_rejection: { type: "noul", instructions: "Did the user reject?", requires_history: true },
		false_success: { type: "noul", instructions: "False success?", requires_history: true },
	},
};
const goal = loadContract(routerPath("contracts/live-v2-axes.json"));
const card = { project: "p", user_message: "fix it ünïcode", signals: { user_turn_index: 2 } };

type Mode = "ok" | "slow" | "500" | "invalid" | "notjson" | "badchoice";
interface Seen {
	url: string;
	auth?: string;
	raw: string;
	body: any;
}

function answersFor(questions: Record<string, { type: string; criteria?: any }>, mode: Mode) {
	const out: Record<string, unknown> = {};
	for (const [k, q] of Object.entries(questions)) {
		if (mode === "invalid" && k === Object.keys(questions)[0]) continue;
		if (q.type === "noul") out[k] = { type: "noul", noul: 0.7 };
		if (q.type === "score") out[k] = { type: "score", score: 2.2, probabilities: { "2": 0.8 } };
		if (q.type === "choice") {
			const choice = mode === "badchoice" ? "not_a_level" : Object.keys(q.criteria)[1];
			out[k] = { type: "choice", choice, confidence: 0.6, probabilities: { [choice]: 0.6 }, evidence: "free text never logged" };
		}
	}
	return out;
}

function fakeServer(mode: () => Mode, seen: Seen[]): Promise<{ server: Server; url: string }> {
	const server = createServer(async (req: IncomingMessage, res) => {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw);
		seen.push({ url: req.url ?? "", auth: req.headers.authorization, raw, body });
		const m = mode();
		const send = () => {
			if (m === "500") return res.writeHead(500).end("boom");
			if (m === "notjson") return res.writeHead(200, { "content-type": "application/json" }).end("{nope");
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "fake-1", answers: answersFor(body.questions, m) }));
		};
		if (m === "slow") setTimeout(send, 300);
		else send();
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone` })));
}

let a: { server: Server; url: string };
let b: { server: Server; url: string };
let modeA: Mode = "ok";
let modeB: Mode = "ok";
const seenA: Seen[] = [];
const seenB: Seen[] = [];
before(async () => {
	a = await fakeServer(() => modeA, seenA);
	b = await fakeServer(() => modeB, seenB);
});
after(() => {
	a.server.close();
	b.server.close();
});

function make(now = { t: 0 }) {
	return new Deciders(
		{
			local: { url: a.url, family: "family-a", timeout_ms: 150 },
			jev: { url: b.url, model: "typesafe/jev-1.14", family: "family-b", timeout_ms: 150, auth: { scheme: "Bearer", env: "ROUTER_TEST_KEY" } },
			same_family: { url: a.url, family: "family-a", timeout_ms: 150 },
			disabled_backend: { url: a.url, model: "perplexity/pplx-decider-v1.2", family: "family-c", timeout_ms: 150, enabled: false },
		},
		{ breakerMs: 300_000, now: () => now.t, keyFor: (bk) => (bk.auth ? "test-key" : undefined) },
	);
}
const reset = () => {
	modeA = "ok";
	modeB = "ok";
	seenA.length = 0;
	seenB.length = 0;
};

test("body and headers match run_arm.py: {state, questions[, model]}, wire noul, stripped keys, Bearer", async () => {
	reset();
	const d = make();
	const r = await d.ask(["jev", "local"], history, card, true);
	assert.equal(r.backend, "jev");
	assert.equal(seenB.length, 1);
	const { body, raw, auth } = seenB[0];
	assert.deepEqual(Object.keys(body), ["state", "questions", "model"]);
	assert.equal(body.model, "typesafe/jev-1.14");
	assert.equal(auth, "Bearer test-key");
	assert.deepEqual(body.state, card);
	assert.deepEqual(Object.keys(body.questions), ["new_goal", "user_rejection", "false_success"]);
	for (const q of Object.values(body.questions) as any[]) {
		assert.equal(q.type, "noul");
		assert.ok(!("requires_history" in q) && !("gold" in q));
	}
	// Same bytes as Python json.dumps(body).
	assert.equal(raw, pyJsonDumps({ state: card, questions: questionsFor(history, true), model: "typesafe/jev-1.14" }));
	assert.ok(raw.includes("\\u00fc"), "ensure_ascii escaping like run_arm.py");
	// Local backend: no model, no auth, 3-axis questions.
	await d.ask(["local"], goal, card, false);
	assert.deepEqual(Object.keys(seenA[0].body), ["state", "questions"]);
	assert.equal(seenA[0].auth, undefined);
	assert.deepEqual(Object.keys(seenA[0].body.questions), ["depth", "width", "urgency"]);
});

test("history questions are not sent on a turn without history", () => {
	assert.deepEqual(Object.keys(questionsFor(history, false)), []);
	assert.deepEqual(Object.keys(questionsFor(goal, false)), ["depth", "width", "urgency"]);
});

test("selectPair chooses up to two backends from distinct families and skips disabled backends", () => {
	const d = make();
	assert.deepEqual(selectPair(["disabled_backend", "local", "same_family", "jev"], d.backends), ["local", "jev"]);
});

test("ask and askPair skip backends configured with enabled: false", async () => {
	reset();
	const d = make();
	const single = await d.ask(["disabled_backend", "jev"], goal, card, false);
	assert.equal(single.backend, "jev");
	assert.equal(seenA.length, 0, "disabled_backend must not be called by ask()");
	assert.equal(seenB.length, 1);

	reset();
	const r = await d.askPair(["disabled_backend", "local", "same_family", "jev"], goal, card, false);
	assert.equal(r.assessments.length, 2);
	assert.equal(r.assessments[0].backend, "local");
	assert.equal(r.assessments[1].backend, "jev");
	assert.ok(r.assessments[0].answers);
	assert.ok(r.assessments[1].answers);
	assert.equal(seenA.length, 1);
	assert.equal(seenB.length, 1);
});

test("askPair opens breaker on one failing backend while returning the other backend's assessment", async () => {
	reset();
	const now = { t: 1000 };
	const d = make(now);
	modeA = "500";
	const r = await d.askPair(["local", "jev"], goal, card, false);
	assert.equal(r.assessments.length, 2);
	assert.equal(r.assessments[0].answers, null);
	assert.equal(r.assessments[0].call.ok, false);
	assert.ok(r.assessments[1].answers);
	assert.equal(r.assessments[1].call.ok, true);
	assert.ok(d.isOpen("local"));
	assert.ok(!d.isOpen("jev"));
});

test("askPair fills failed primary slots from configured distinct-family fallbacks", async () => {
	reset();
	const now = { t: 1000 };
	const d = new Deciders(
		{
			p1: { url: a.url, model: "baseten/mammoth-1:free", family: "baseten", timeout_ms: 150 },
			p2: { url: b.url, model: "perplexity/pplx-decider-v1.2", family: "perplexity", timeout_ms: 150 },
			fb1: { url: b.url, model: "typesafe/jev-1.14", family: "typesafe", timeout_ms: 150 },
			fb2: { url: b.url, model: "inception/mercury-decide", family: "inception", timeout_ms: 150 },
		},
		{ breakerMs: 300_000, now: () => now.t },
	);
	modeA = "500";
	modeB = "ok";
	const r = await d.askPair(["p1", "p2", "fb1", "fb2"], goal, card, false);
	assert.equal(r.assessments.length, 2);
	assert.equal(r.assessments[0].backend, "fb1", "failed p1 slot replaced by fb1");
	assert.ok(r.assessments[0].answers);
	assert.equal(r.assessments[1].backend, "p2");
	assert.ok(r.assessments[1].answers);
	assert.equal(r.calls.length, 3, "p1 (failed) + p2 (ok) + fb1 (ok)");
	assert.ok(d.isOpen("p1"));
});

test("timeout opens the breaker and falls through to the next backend", async () => {
	reset();
	const now = { t: 1000 };
	const d = make(now);
	modeA = "slow";
	const r = await d.ask(["local", "jev"], goal, card, true);
	assert.equal(r.backend, "jev");
	assert.equal(r.calls[0].ok, false);
	assert.match(r.calls[0].error ?? "", /timeout 150 ms/);
	assert.ok(r.calls[0].ms >= 140 && r.calls[0].ms < 290, `${r.calls[0].ms}`);
	assert.ok(d.isOpen("local"));
	// While open, the backend is skipped without a request.
	modeA = "ok";
	const before = seenA.length;
	const r2 = await d.ask(["local", "jev"], goal, card, true);
	assert.equal(seenA.length, before);
	assert.deepEqual(r2.calls[0], { backend: "local", contract: "live-v2-axes", ms: 0, ok: false, skipped: "breaker_open" });
	assert.equal(r2.backend, "jev");
	// After 5 minutes it is tried again.
	now.t += 300_001;
	assert.ok(!d.isOpen("local"));
	const r3 = await d.ask(["local", "jev"], goal, card, true);
	assert.equal(r3.backend, "local");
});

test("invalid answers, bad choices, non-JSON and 500 all fall through", async () => {
	for (const mode of ["invalid", "badchoice", "notjson", "500"] as Mode[]) {
		reset();
		const d = make();
		modeA = mode;
		const r = await d.ask(["local", "jev"], goal, card, true);
		assert.equal(r.backend, "jev", mode);
		assert.equal(r.calls[0].ok, false);
		assert.ok(d.isOpen("local"), mode);
		if (mode === "invalid") assert.deepEqual(r.calls[0].problems, ["depth: missing"]);
		if (mode === "badchoice") assert.deepEqual(r.calls[0].problems, ["depth: bad choice/probabilities", "width: bad choice/probabilities", "urgency: bad choice/probabilities"]);
		if (mode === "500") assert.equal(r.calls[0].status, 500);
	}
});

test("every backend failing returns null answers, never throws", async () => {
	reset();
	const d = make();
	modeA = "500";
	modeB = "slow";
	const r = await d.ask(["local", "jev"], history, card, true);
	assert.equal(r.backend, null);
	assert.equal(r.answers, null);
	assert.equal(r.calls.length, 2);
	const refused = new Deciders({ x: { url: "http://127.0.0.1:1/v1/systemone", timeout_ms: 200 } }, { breakerMs: 1000 });
	const r2 = await refused.ask(["x"], goal, card, true);
	assert.equal(r2.answers, null);
	assert.match(r2.calls[0].error ?? "", /fetch failed|ECONNREFUSED|TypeError/);
});

test("missing key skips the backend; user abort does not open the breaker", async () => {
	reset();
	const d = new Deciders({ jev: { url: b.url, timeout_ms: 150, auth: { scheme: "Bearer", env: "ROUTER_TEST_NO_SUCH_KEY" } } }, { breakerMs: 1000, keyFor: () => undefined });
	const r = await d.ask(["jev"], goal, card, true);
	assert.equal(r.calls[0].skipped, "no_key");
	assert.equal(seenB.length, 0);
	modeA = "slow";
	const d2 = make();
	const ac = new AbortController();
	setTimeout(() => ac.abort(), 20);
	const r2 = await d2.ask(["local", "jev"], goal, card, true, ac.signal);
	assert.equal(r2.answers, null);
	assert.equal(r2.calls.length, 1, "stops after the abort");
	assert.equal(r2.calls[0].error, "aborted");
	assert.ok(!d2.isOpen("local"));
});

test("validate() matches run_arm.py", () => {
	const qs = questionsFor(goal, true);
	assert.deepEqual(validate(null, qs), ["no answers object"]);
	assert.deepEqual(validate({ answers: [] }, qs), ["no answers object"]);
	assert.deepEqual(
		validate(
			{
				answers: {
					depth: { choice: "1", probabilities: { "1": 1 } },
					width: { choice: "invalid_level", probabilities: {} },
					urgency: { choice: "3", probabilities: { "3": 1 } },
				},
			},
			qs,
		),
		["width: bad choice/probabilities"],
	);
	assert.deepEqual(validate({ answers: answersFor(qs, "ok") }, qs), []);
});

test("compactAnswers keeps numbers only", () => {
	const c = compactAnswers(answersFor(questionsFor(goal, true), "ok") as any);
	assert.deepEqual(c, {
		depth: { choice: "1", p: { "1": 0.6 } },
		width: { choice: "1", p: { "1": 0.6 } },
		urgency: { choice: "1", p: { "1": 0.6 } },
	});
	assert.ok(!JSON.stringify(c).includes("free text"));
});
