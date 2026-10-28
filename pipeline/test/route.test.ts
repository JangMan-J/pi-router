import { strict as assert } from "node:assert";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { loadContracts, loadCatalogue, loadPipelineConfig, loadRouterConfig, makeAvailable, routeCard, type Card, type RouteDeps } from "../src/route.ts";
import type { Answers, AskPairResult } from "../../router/src/deciders.ts";

const cfg = loadPipelineConfig();
const routerConfig = loadRouterConfig(cfg);
const contracts = loadContracts(cfg);
const available = makeAvailable(routerConfig, loadCatalogue(cfg.catalogue));

function makeChoice(choice: string) {
	return { type: "choice" as const, choice, confidence: 0.9, probabilities: { [choice]: 0.9 } };
}

function makeAxes(depth: string, width: string, urgency: string): Answers {
	return {
		depth: makeChoice(depth),
		width: makeChoice(width),
		urgency: makeChoice(urgency),
	};
}

function deps(): RouteDeps {
	const ask = async (role: "goal"): Promise<AskPairResult> => {
		const a1 = makeAxes("1", "1", "3");
		const a2 = makeAxes("2", "1", "2");
		return {
			assessments: [
				{ backend: "openrouter-mammoth", model: "baseten/mammoth-1:free", family: "baseten", answers: a1, call: { backend: "openrouter-mammoth", contract: role, ms: 7, ok: true } },
				{ backend: "openrouter-jev", model: "typesafe/jev-1.14", family: "typesafe", answers: a2, call: { backend: "openrouter-jev", contract: role, ms: 6, ok: true } },
			],
			calls: [
				{ backend: "openrouter-mammoth", contract: role, ms: 7, ok: true },
				{ backend: "openrouter-jev", contract: role, ms: 6, ok: true },
			],
		};
	};
	return { db: openDb(":memory:"), cfg, routerConfig, contracts, ask, available, embed: true, level: "medium" };
}

const firstCard: Card = {
	host: "spider",
	session: "2026-10-27T00-00-00-000Z_01a10000-0000-7000-8000-000000000000.jsonl",
	entry_id: "aaaaaaaa",
	meta: { current_model: null },
	state: { project: "zellijiance", user_message: "the broker keeps exiting on start, fix it", signals: { user_turn_index: 0 } },
};

test("a first turn is picked from the paired 3-axis answers, reconciled, and both assessments recorded", async () => {
	const d = deps();
	assert.deepEqual(d.cfg.deciders.order, ["openrouter-mammoth", "openrouter-pplx-decider", "openrouter-jev", "openrouter-mercury"]);
	const r = await routeCard(firstCard, d);
	assert.equal(r.action, "initial");
	assert.equal(r.tier, "general", "max(1, 2) on depth is 2 -> general");
	assert.ok(r.model.startsWith("anthropic/") || r.model.startsWith("openai-codex/"));
	assert.equal(r.assessments.length, 2, "both decider calls in the pair are recorded");
	assert.equal(r.assessments[0].backend, "openrouter-mammoth");
	assert.equal(r.assessments[1].backend, "openrouter-jev");
	assert.ok(r.reasons.includes("depth:2"));
	assert.ok(r.reasons.includes("urgency:2"), "min(3, 2) on urgency is 2");
	assert.ok(r.reasons.includes("disagreement"));
	assert.ok(r.reasons.includes("profile:diagnosis_exec"), "depth 2, width 1, urgency 2 maps to diagnosis_exec");
	assert.equal(r.model, "openai-codex/gpt-6-astra");
	assert.equal(r.thinking, "high");
	assert.ok(r.representations.length > 0);
	const dec = d.db.prepare("select count(*) as n, disagreement, rule_id from decisions").get() as { n: number; disagreement: number; rule_id: string };
	assert.equal(Number(dec.n), 1);
	assert.equal(Number(dec.disagreement), 1, "decisions.disagreement is 1 when paired deciders differ");
	assert.equal(dec.rule_id, "initial:profile:diagnosis_exec");
	const asmCount = d.db.prepare("select count(*) as n from assessments").get() as { n: number };
	assert.equal(Number(asmCount.n), 2, "two rows in assessments table");
});

test("pipeline routes all 7 profiles to their configured models and records initial:profile:<id>", async () => {
	const cases: {
		profile: string;
		tier: string;
		model: string;
		thinking: string;
		depth: string;
		width: string;
		urgency: string;
	}[] = [
		{ profile: "quick", tier: "basic", model: "antigravity/gemini-3.8-flash", thinking: "low", depth: "0", width: "1", urgency: "3" },
		{ profile: "local_work", tier: "general", model: "anthropic/claude-sonnet-5-5", thinking: "medium", depth: "1", width: "0", urgency: "2" },
		{ profile: "wide_work", tier: "general", model: "openai-codex/gpt-6-astra", thinking: "medium", depth: "0", width: "3", urgency: "2" },
		{ profile: "diagnosis_scoping", tier: "general", model: "anthropic/claude-sonnet-5-5", thinking: "high", depth: "2", width: "2", urgency: "1" },
		{ profile: "diagnosis_exec", tier: "general", model: "openai-codex/gpt-6-astra", thinking: "high", depth: "2", width: "1", urgency: "3" },
		{ profile: "deep_focus", tier: "deep", model: "anthropic/claude-opus-5-5", thinking: "high", depth: "3", width: "2", urgency: "1" },
		{ profile: "deep_system", tier: "deep", model: "openai-codex/gpt-6.1-sol", thinking: "high", depth: "3", width: "3", urgency: "3" },
	];

	for (const c of cases) {
		const d = deps();
		d.embed = false;
		d.ask = async (role) => ({
			assessments: [
				{ backend: "openrouter-mammoth", model: "baseten/mammoth-1:free", family: "baseten", answers: makeAxes(c.depth, c.width, c.urgency), call: { backend: "openrouter-mammoth", contract: role, ms: 5, ok: true } },
				{ backend: "openrouter-jev", model: "typesafe/jev-1.14", family: "typesafe", answers: makeAxes(c.depth, c.width, c.urgency), call: { backend: "openrouter-jev", contract: role, ms: 5, ok: true } },
			],
			calls: [
				{ backend: "openrouter-mammoth", contract: role, ms: 5, ok: true },
				{ backend: "openrouter-jev", contract: role, ms: 5, ok: true },
			],
		});
		const r = await routeCard({ ...firstCard, session: `s-${c.profile}`, entry_id: `e-${c.profile}` }, d);
		assert.equal(r.action, "initial", c.profile);
		assert.equal(r.tier, c.tier, c.profile);
		assert.equal(r.model, c.model, c.profile);
		assert.equal(r.thinking, c.thinking, c.profile);
		assert.ok(r.reasons.includes(`profile:${c.profile}`), c.profile);
		const row = d.db.prepare("select rule_id from decisions").get() as { rule_id: string };
		assert.equal(row.rule_id, `initial:profile:${c.profile}`, c.profile);
	}
});

test("pipeline respects custom models array in config.profiles[name].models and thinking-level clamping", async () => {
	const d = deps();
	d.embed = false;
	const customRouterConfig = structuredClone(routerConfig);
	customRouterConfig.profiles.diagnosis_scoping.models = ["openai-codex/gpt-6.1-terra:high"];
	d.routerConfig = customRouterConfig;
	d.ask = async (role) => ({
		assessments: [
			{ backend: "openrouter-mammoth", model: "baseten/mammoth-1:free", family: "baseten", answers: makeAxes("2", "1", "0"), call: { backend: "openrouter-mammoth", contract: role, ms: 5, ok: true } },
			{ backend: "openrouter-jev", model: "typesafe/jev-1.14", family: "typesafe", answers: makeAxes("2", "1", "1"), call: { backend: "openrouter-jev", contract: role, ms: 5, ok: true } },
		],
		calls: [
			{ backend: "openrouter-mammoth", contract: role, ms: 5, ok: true },
			{ backend: "openrouter-jev", contract: role, ms: 5, ok: true },
		],
	});
	const r = await routeCard({ ...firstCard, session: "s-custom-prof", entry_id: "e-custom-prof" }, d);
	assert.equal(r.model, "openai-codex/gpt-6.1-terra");
	assert.equal(r.thinking, "high");
	assert.equal(r.tier, "general");
	assert.ok(r.reasons.includes("profile:diagnosis_scoping"));

	// Clamping deep_focus down to general when level === "low"
	const dLow = deps();
	dLow.embed = false;
	dLow.level = "low";
	dLow.ask = async (role) => ({
		assessments: [
			{ backend: "openrouter-mammoth", model: "baseten/mammoth-1:free", family: "baseten", answers: makeAxes("3", "1", "2"), call: { backend: "openrouter-mammoth", contract: role, ms: 5, ok: true } },
			{ backend: "openrouter-jev", model: "typesafe/jev-1.14", family: "typesafe", answers: makeAxes("3", "1", "2"), call: { backend: "openrouter-jev", contract: role, ms: 5, ok: true } },
		],
		calls: [
			{ backend: "openrouter-mammoth", contract: role, ms: 5, ok: true },
			{ backend: "openrouter-jev", contract: role, ms: 5, ok: true },
		],
	});
	const rLow = await routeCard({ ...firstCard, session: "s-clamp-low", entry_id: "e-clamp-low" }, dLow);
	assert.equal(rLow.tier, "general");
	assert.equal(rLow.model, "anthropic/claude-sonnet-5-5");
	const rowLow = dLow.db.prepare("select rule_id from decisions").get() as { rule_id: string };
	assert.equal(rowLow.rule_id, "initial:tier:general");
});

test("the same card twice yields the same ids and no duplicate decision", async () => {
	const d = deps();
	const a = await routeCard(firstCard, d);
	const b = await routeCard(firstCard, d);
	assert.equal(a.assignmentId, b.assignmentId);
	assert.equal(a.snapshotId, b.snapshotId);
	assert.ok(b.representations.every((x) => x.cached), "second pass reads the cache");
});

test("every later turn in the same session keeps the initial selection without asking", async () => {
	const d = deps();
	const first = await routeCard(firstCard, d);
	const card: Card = {
		...firstCard,
		entry_id: "bbbbbbbb",
		meta: { current_model: first.model },
		state: { project: "zellijiance", user_message: "and update the docs", signals: { user_turn_index: 3 } },
	};
	const r = await routeCard(card, d);
	assert.equal(r.action, "keep");
	assert.equal(r.model, first.model);
	assert.deepEqual(r.assessments, []);
});

test("partial review when one decider fails still routes by judgement from the surviving decider", async () => {
	const d = deps();
	d.ask = async (role) => ({
		assessments: [
			{ backend: "openrouter-mammoth", model: "baseten/mammoth-1:free", family: "baseten", answers: makeAxes("3", "2", "3"), call: { backend: "openrouter-mammoth", contract: role, ms: 7, ok: true } },
			{ backend: "openrouter-jev", model: "typesafe/jev-1.14", family: "typesafe", answers: null, call: { backend: "openrouter-jev", contract: role, ms: 5, ok: false, error: "timeout" } },
		],
		calls: [
			{ backend: "openrouter-mammoth", contract: role, ms: 7, ok: true },
			{ backend: "openrouter-jev", contract: role, ms: 5, ok: false, error: "timeout" },
		],
	});
	const r = await routeCard(firstCard, d);
	assert.equal(r.action, "initial");
	assert.equal(r.tier, "deep", "depth 3 from surviving decider selects deep");
	assert.ok(r.reasons.includes("status:partial"));
	assert.ok(r.reasons.includes("profile:deep_focus"));
	assert.equal(r.assessments[0].backend, "openrouter-mammoth");
	assert.equal(r.assessments[1].backend, "openrouter-jev");
	assert.equal(r.assessments[1].ok, false);
	const row = d.db.prepare("select basis, disagreement from decisions").get() as { basis: string; disagreement: number };
	assert.equal(row.basis, "judgement");
	assert.equal(Number(row.disagreement), 0);
	const failedAsm = d.db.prepare("select backend, model, ok, error from assessments where attempt = 2").get() as { backend: string; model: string; ok: number; error: string };
	assert.equal(failedAsm.backend, "openrouter-jev");
	assert.equal(failedAsm.model, "typesafe/jev-1.14");
	assert.equal(Number(failedAsm.ok), 0);
	assert.equal(failedAsm.error, "timeout");
});

test("both deciders failing falls back to the declared tier and records basis=declared", async () => {
	const d = deps();
	d.ask = async (role) => ({
		assessments: [
			{ backend: "openrouter-mammoth", model: null, family: "baseten", answers: null, call: { backend: "openrouter-mammoth", contract: role, ms: 5, ok: false, error: "timeout" } },
			{ backend: "openrouter-jev", model: null, family: "typesafe", answers: null, call: { backend: "openrouter-jev", contract: role, ms: 5, ok: false, error: "timeout" } },
		],
		calls: [
			{ backend: "openrouter-mammoth", contract: role, ms: 5, ok: false, error: "timeout" },
			{ backend: "openrouter-jev", contract: role, ms: 5, ok: false, error: "timeout" },
		],
	});
	const r = await routeCard(firstCard, d);
	assert.equal(r.action, "initial");
	assert.equal(r.tier, routerConfig.fallback_tier);
	assert.ok(r.reasons.includes(`profile:${routerConfig.fallback_profile}`));
	const row = d.db.prepare("select basis, tier from decisions").get() as { basis: string; tier: string };
	assert.equal(row.basis, "declared");
	const asms = (d.db.prepare("select backend, model, ok from assessments order by attempt asc").all() as { backend: string; model: string; ok: number }[]).map((x) => ({
		backend: x.backend,
		model: x.model,
		ok: Number(x.ok),
	}));
	assert.deepEqual(asms, [
		{ backend: "openrouter-mammoth", model: "baseten/mammoth-1:free", ok: 0 },
		{ backend: "openrouter-jev", model: "typesafe/jev-1.14", ok: 0 },
	]);
});

test("decide.ts: parseAnswers and selectInitial handle explicit model, unclassified default, and no-credentials fallback", async () => {
	const { parseAnswers, selectInitial } = await import("../src/decide.ts");

	const emptyParsed = parseAnswers(null, routerConfig);
	assert.equal(emptyParsed.profile, null);
	assert.equal(emptyParsed.tier, null);
	assert.equal(emptyParsed.status, "none");

	const singleParsed = parseAnswers(makeAxes("0", "0", "3"), routerConfig);
	assert.equal(singleParsed.profile, "quick");
	assert.equal(singleParsed.tier, "basic");
	assert.equal(singleParsed.status, "partial");

	const explicitPick = selectInitial({
		config: routerConfig,
		level: "medium",
		available,
		explicitModelChange: "xai/grok-4.7",
		classified: false,
	});
	assert.equal(explicitPick.basis, "explicit");
	assert.equal(explicitPick.rule, "initial:explicit");
	assert.equal(explicitPick.model, "xai/grok-4.7");

	const explicitWithThinking = selectInitial({
		config: routerConfig,
		level: "medium",
		available,
		explicitModelChange: "openai-codex/gpt-6-astra:high",
		classified: false,
	});
	assert.equal(explicitWithThinking.basis, "explicit");
	assert.equal(explicitWithThinking.model, "openai-codex/gpt-6-astra");
	assert.equal(explicitWithThinking.thinking, "high");
	assert.equal(explicitWithThinking.tier, "general");

	const noModelPick = selectInitial({
		config: routerConfig,
		level: "medium",
		available: () => false,
		classified: false,
	});
	assert.equal(noModelPick.action, "no_model");
	assert.equal(noModelPick.basis, "declared");
	assert.equal(noModelPick.rule, "initial:no_model");
});
