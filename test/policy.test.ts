/** Table-driven policy tests against the shipped config.json. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadConfig, type ModelRef } from "../src/config.ts";
import type { Answers } from "../src/deciders.ts";
import { clampTier, decideTurn, type Env, isOverload, type Level, pickArm, retryAlternative, type RouterState, tierOfModel, type TurnInput } from "../src/policy.ts";
import type { Prior } from "../src/prior.ts";
import type { Signals } from "../src/state.ts";

const config = loadConfig();
const JEV = config.thresholds.jev;

const env = (opts: { unavailable?: string[]; prior?: Prior | null; rng?: () => number } = {}): Env => ({
	config,
	available: (r: ModelRef) => !(opts.unavailable ?? []).includes(r.key),
	prior: opts.prior ?? null,
	rng: opts.rng ?? (() => 0.99),
});
const signals = (over: Partial<Signals> = {}): Signals => ({
	user_turn_index: 3,
	tool_errors_last_5: 0,
	repeated_error_fingerprint_count: 0,
	successful_edits_since_last_user: 0,
	tests_run_since_last_user: 0,
	tests_failed_since_last_user: 0,
	...over,
});
const goal = (task: string, difficulty: number, spec_clear = 0.5): Answers => ({
	task: { type: "choice", choice: task, probabilities: { [task]: 0.9 } },
	difficulty: { type: "score", score: difficulty },
	spec_clear: { type: "noul", noul: spec_clear },
});
const hist = (new_goal = 0.1, user_rejection = 0.05, false_success = 0.05): Answers => ({
	new_goal: { type: "noul", noul: new_goal },
	user_rejection: { type: "noul", noul: user_rejection },
	false_success: { type: "noul", noul: false_success },
});
const state = (model: string, over: Partial<RouterState> = {}): RouterState => ({
	v: 1,
	arm: "jev",
	arm_p: 0.5,
	model,
	thinking: "medium",
	tier: tierOfModel(config, model),
	lane: null,
	goal: null,
	last: { action: "pick", reasons: [] },
	...over,
});
const input = (over: Partial<TurnInput>): TurnInput => ({
	level: "medium",
	current: null,
	signals: signals(),
	history: null,
	goal: null,
	thresholds: JEV,
	...over,
});
const cur = (key: string, thinking = "medium") => ({ key, thinking });

interface Case {
	name: string;
	input: Partial<TurnInput>;
	env?: Env;
	model: string;
	action: string;
	lane?: string | null;
	tier?: string;
	reasons?: string[];
}

const cases: Case[] = [
	// 1. First turn: tier from difficulty, lanes, fallbacks.
	{ name: "first turn trivial -> basic, config order", input: { goal: goal("qa_knowledge", 0.4) }, model: "openai-codex/gpt-6-luna:low", action: "pick", tier: "basic", reasons: ["first_turn", "difficulty:0.4", "tier:basic"] },
	{ name: "first turn moderate -> general", input: { goal: goal("code_debugging", 1.7) }, model: "anthropic/claude-sonnet-5-5:medium", action: "pick", tier: "general" },
	{ name: "difficulty 2.5 is deep", input: { goal: goal("code_debugging", 2.5) }, model: "anthropic/claude-opus-5-5:high", action: "pick", tier: "deep" },
	{ name: "difficulty just under 1.0 is basic", input: { goal: goal("shell_ops", 0.99) }, model: "openai-codex/gpt-6-luna:low", action: "pick", tier: "basic" },
	{ name: "low caps deep at general", input: { level: "low", goal: goal("code_debugging", 3.4) }, model: "anthropic/claude-sonnet-5-5:medium", action: "pick", tier: "general" },
	{ name: "high raises basic to general", input: { level: "high", goal: goal("qa_knowledge", 0.3) }, model: "anthropic/claude-sonnet-5-5:medium", action: "pick", tier: "general" },
	{ name: "high raises general to deep", input: { level: "high", goal: goal("code_debugging", 1.5) }, model: "anthropic/claude-opus-5-5:high", action: "pick", tier: "deep" },
	{ name: "grok lane: explicit fast code", input: { goal: goal("code_implementation", 1.5, 0.8) }, model: "xai/grok-4.7:medium", action: "pick", lane: "explicit-spec-fast-code" },
	{ name: "grok lane needs spec_clear >= 0.7", input: { goal: goal("code_implementation", 1.5, 0.6) }, model: "anthropic/claude-sonnet-5-5:medium", action: "pick", lane: null },
	{ name: "grok lane needs difficulty <= 2", input: { goal: goal("code_refactor", 2.2, 0.9) }, model: "anthropic/claude-sonnet-5-5:medium", action: "pick", lane: null },
	{ name: "creative prose lane -> muse", input: { goal: goal("writing_creative", 2) }, model: "meta/muse-wonder-full-1.0:medium", action: "pick", lane: "creative-prose" },
	{ name: "creative prose lane is not gated on spec_clear", input: { goal: goal("writing_creative", 2, 0.1) }, model: "meta/muse-wonder-full-1.0:medium", action: "pick", lane: "creative-prose" },
	{ name: "orchestration lane needs spec_clear >= 0.8", input: { goal: goal("planning_design", 2, 0.85) }, model: "meta/muse-wonder-full-1.0:medium", action: "pick", lane: "clear-orchestration" },
	{ name: "orchestration lane off below 0.8", input: { goal: goal("planning_design", 2, 0.75) }, model: "anthropic/claude-sonnet-5-5:medium", action: "pick", lane: null },
	{ name: "first turn without deciders -> fallback tier", input: { goal: null }, model: "anthropic/claude-sonnet-5-5:medium", action: "pick", reasons: ["first_turn", "no_decider", "tier:general"] },
	{ name: "no credentials -> next model in tier", input: { goal: goal("qa_knowledge", 0.2) }, env: env({ unavailable: ["openai-codex/gpt-6-luna"] }), model: "antigravity/gemini-3.8-flash:low", action: "pick" },
	{
		name: "empty tier -> tier above",
		input: { goal: goal("qa_knowledge", 0.2) },
		env: env({ unavailable: ["openai-codex/gpt-6-luna", "antigravity/gemini-3.8-flash", "anthropic/claude-haiku-5-5"] }),
		model: "anthropic/claude-sonnet-5-5:medium",
		action: "pick",
		tier: "general",
		reasons: ["first_turn", "difficulty:0.2", "tier:basic", "tier_empty:basic"],
	},
	{ name: "lane without credentials -> tier", input: { goal: goal("writing_creative", 1) }, env: env({ unavailable: ["meta/muse-wonder-full-1.0"] }), model: "anthropic/claude-sonnet-5-5:medium", action: "pick", lane: null },

	// 2. Later turns: keep by default.
	{ name: "adopt: keep without asking, even on fault signals", input: { adopt: true, current: cur("anthropic/claude-opus-5-5", "high"), signals: signals({ repeated_error_fingerprint_count: 5 }) }, model: "anthropic/claude-opus-5-5:high", action: "keep", reasons: ["adopt"] },
	{ name: "adopt under low still caps the tier", input: { adopt: true, level: "low", current: cur("anthropic/claude-opus-5-5", "high") }, model: "anthropic/claude-sonnet-5-5:medium", action: "move" },
	{ name: "keep by default", input: { current: cur("openai-codex/gpt-6-astra", "medium"), history: hist() }, model: "openai-codex/gpt-6-astra:medium", action: "keep", reasons: ["keep"] },
	{ name: "keep when deciders failed", input: { current: cur("anthropic/claude-haiku-5-5", "low"), history: null }, model: "anthropic/claude-haiku-5-5:low", action: "keep" },
	{ name: "keep a model outside the tiers", input: { current: cur("xai/grok-4.7"), history: hist() }, model: "xai/grok-4.7:medium", action: "keep" },
	{ name: "rejection just under theta keeps", input: { current: cur("anthropic/claude-sonnet-5-5"), history: hist(0.1, JEV.user_rejection - 0.01) }, model: "anthropic/claude-sonnet-5-5:medium", action: "keep" },

	// Agent fault: escalate one tier.
	{
		name: "rejection escalates general -> deep",
		input: { current: cur("anthropic/claude-sonnet-5-5"), history: hist(0.1, JEV.user_rejection) },
		model: "anthropic/claude-opus-5-5:high",
		action: "escalate",
		reasons: ["agent_fault", "user_rejection", "tier:general->deep"],
	},
	{ name: "false success just under theta keeps", input: { current: cur("openai-codex/gpt-6-luna", "low"), history: hist(0.1, 0.05, JEV.false_success - 0.01) }, model: "openai-codex/gpt-6-luna:low", action: "keep" },
	{ name: "false success at theta escalates basic -> general", input: { current: cur("openai-codex/gpt-6-luna", "low"), history: hist(0.1, 0.05, JEV.false_success) }, model: "anthropic/claude-sonnet-5-5:medium", action: "escalate" },
	{
		name: "repeated errors escalate even without deciders",
		input: { current: cur("openai-codex/gpt-6-luna", "low"), history: null, signals: signals({ repeated_error_fingerprint_count: 3 }) },
		model: "anthropic/claude-sonnet-5-5:medium",
		action: "escalate",
		reasons: ["agent_fault", "repeated_errors", "tier:basic->general"],
	},
	{ name: "two repeated errors are not a fault", input: { current: cur("openai-codex/gpt-6-luna", "low"), signals: signals({ repeated_error_fingerprint_count: 2 }) }, model: "openai-codex/gpt-6-luna:low", action: "keep" },
	{ name: "unknown model counts as general -> deep", input: { current: cur("xai/grok-4.7"), history: hist(0.1, 0.9) }, model: "anthropic/claude-opus-5-5:high", action: "escalate" },
	{ name: "at deep: next deep model of another family (opus -> sol)", input: { current: cur("anthropic/claude-opus-5-5", "high"), history: hist(0.1, 0.9) }, model: "openai-codex/gpt-6.1-sol:high", action: "lateral" },
	{ name: "at deep: sol -> opus (astra is the same family)", input: { current: cur("openai-codex/gpt-6.1-sol", "high"), history: hist(0.1, 0.9) }, model: "anthropic/claude-opus-5-5:high", action: "lateral" },
	{ name: "at deep: astra-high -> opus", input: { current: cur("openai-codex/gpt-6-astra", "high"), history: hist(0.1, 0.9) }, model: "anthropic/claude-opus-5-5:high", action: "lateral" },
	{ name: "escalation skips the current model (astra general -> deep opus)", input: { current: cur("openai-codex/gpt-6-astra", "medium"), history: hist(0.1, 0.9) }, model: "anthropic/claude-opus-5-5:high", action: "escalate" },
	{
		name: "escalation never returns the current model even when it is first available",
		input: { current: cur("openai-codex/gpt-6-astra", "medium"), history: hist(0.1, 0.9) },
		env: env({ unavailable: ["anthropic/claude-opus-5-5", "openai-codex/gpt-6.1-sol"] }),
		model: "anthropic/claude-sonnet-5-5:medium",
		action: "escalate",
	},
	{ name: "low: fault at general moves laterally", input: { level: "low", current: cur("anthropic/claude-sonnet-5-5"), history: hist(0.1, 0.9) }, model: "openai-codex/gpt-6-astra:medium", action: "lateral" },
	{
		name: "fault + new goal: higher of escalated and re-picked tier",
		input: { current: cur("openai-codex/gpt-6-luna", "low"), history: hist(0.9, 0.9), goal: goal("code_debugging", 3.1) },
		model: "anthropic/claude-opus-5-5:high",
		action: "escalate",
		reasons: ["agent_fault", "user_rejection", "new_goal", "tier:basic->deep"],
	},
	{ name: "fault + new goal: escalated tier wins over a lower re-pick", input: { current: cur("anthropic/claude-sonnet-5-5"), history: hist(0.9, 0.9), goal: goal("qa_knowledge", 0.2) }, model: "anthropic/claude-opus-5-5:high", action: "escalate" },
	{ name: "fault + new goal: lane applies (Jang's grok turn)", input: { current: cur("anthropic/claude-sonnet-5-5"), history: hist(0.9, 0.05, 0.8), goal: goal("code_implementation", 1.2, 0.9) }, model: "xai/grok-4.7:medium", action: "lane", lane: "explicit-spec-fast-code" },
	{ name: "fault + new goal: muse lane barred on rejection", input: { current: cur("anthropic/claude-sonnet-5-5"), history: hist(0.9, 0.9), goal: goal("planning_design", 1.2, 0.95) }, model: "anthropic/claude-opus-5-5:high", action: "escalate", lane: null },

	// New goal only.
	{ name: "new goal, same tier -> keep", input: { current: cur("anthropic/claude-sonnet-5-5"), history: hist(0.9), goal: goal("code_debugging", 1.5) }, model: "anthropic/claude-sonnet-5-5:medium", action: "keep", reasons: ["new_goal", "tier:general", "same_tier"] },
	{ name: "new goal, other tier -> re-pick", input: { current: cur("anthropic/claude-sonnet-5-5"), history: hist(0.9), goal: goal("qa_knowledge", 0.3) }, model: "openai-codex/gpt-6-luna:low", action: "repick", reasons: ["new_goal", "tier:general->basic"] },
	{ name: "new goal re-pick skips the current model", input: { current: cur("openai-codex/gpt-6-astra", "high"), history: hist(0.9), goal: goal("code_debugging", 1.5) }, model: "anthropic/claude-sonnet-5-5:medium", action: "repick", tier: "general" },
	{ name: "new goal: lane", input: { current: cur("anthropic/claude-sonnet-5-5"), history: hist(0.9), goal: goal("writing_creative", 1) }, model: "meta/muse-wonder-full-1.0:medium", action: "lane", lane: "creative-prose" },
	{ name: "new goal: lane model is the current model -> keep", input: { current: cur("xai/grok-4.7"), history: hist(0.9), goal: goal("code_refactor", 1, 0.9) }, model: "xai/grok-4.7:medium", action: "keep" },
	{ name: "new goal without goal answers -> keep", input: { current: cur("anthropic/claude-sonnet-5-5"), history: hist(0.9), goal: null }, model: "anthropic/claude-sonnet-5-5:medium", action: "keep", reasons: ["new_goal", "no_decider"] },
	{ name: "new goal just under theta -> keep", input: { current: cur("anthropic/claude-sonnet-5-5"), history: hist(JEV.new_goal - 0.01), goal: goal("qa_knowledge", 0.3) }, model: "anthropic/claude-sonnet-5-5:medium", action: "keep", reasons: ["keep"] },
	{ name: "high: new goal re-picks one tier up", input: { level: "high", current: cur("anthropic/claude-sonnet-5-5"), history: hist(0.9), goal: goal("code_debugging", 1.5) }, model: "anthropic/claude-opus-5-5:high", action: "repick" },

	// Never-rules, exclusions and level bounds on kept models.
	{ name: "never: muse on a new debugging goal moves to general", input: { current: cur("meta/muse-wonder-full-1.0"), history: hist(0.9), goal: goal("code_debugging", 1.5) }, model: "anthropic/claude-sonnet-5-5:medium", action: "move" },
	{ name: "never: goal in force from state (code_review)", input: { current: cur("meta/muse-wonder-full-1.0"), history: hist(), state: state("meta/muse-wonder-full-1.0", { goal: { task: "code_review", difficulty: 2, spec_clear: 0.9 } }) }, model: "anthropic/claude-sonnet-5-5:medium", action: "move" },
	{ name: "unclear creative spec keeps muse", input: { current: cur("meta/muse-wonder-full-1.0"), history: hist(), state: state("meta/muse-wonder-full-1.0", { goal: { task: "writing_creative", difficulty: 2, spec_clear: 0.2 } }) }, model: "meta/muse-wonder-full-1.0:medium", action: "keep" },
	{ name: "rejection at theta on a creative goal: muse leaves (fault)", input: { current: cur("meta/muse-wonder-full-1.0"), history: hist(0.1, JEV.user_rejection), state: state("meta/muse-wonder-full-1.0", { goal: { task: "writing_creative", difficulty: 2, spec_clear: 0.9 } }) }, model: "anthropic/claude-opus-5-5:high", action: "escalate" },
	{ name: "never: false success bars a new creative lane pick", input: { current: cur("anthropic/claude-sonnet-5-5"), history: hist(0.9, 0.05, JEV.false_success), goal: goal("writing_creative", 1, 0.9) }, model: "anthropic/claude-opus-5-5:high", action: "escalate", lane: null },
	{ name: "orchestration with an unclear spec: no muse lane", input: { goal: goal("planning_design", 2, 0.3) }, model: "anthropic/claude-sonnet-5-5:medium", action: "pick", lane: null },
	{ name: "never: other muse variants match the glob", input: { current: cur("meta/muse-wonder-1.0-contributor"), history: hist(), state: state("meta/muse-wonder-1.0-contributor", { goal: { task: "code_debugging", difficulty: 1, spec_clear: 0.9 } }) }, model: "anthropic/claude-sonnet-5-5:medium", action: "move" },
	{ name: "muse with a clear creative goal stays", input: { current: cur("meta/muse-wonder-full-1.0"), history: hist(), state: state("meta/muse-wonder-full-1.0", { goal: { task: "writing_creative", difficulty: 2, spec_clear: 0.9 } }) }, model: "meta/muse-wonder-full-1.0:medium", action: "keep" },
	{ name: "excluded: fable is never kept", input: { current: cur("anthropic/claude-fable-5-1", "high"), history: hist() }, model: "anthropic/claude-sonnet-5-5:medium", action: "move", reasons: ["keep", "excluded", "tier:general->general"] },
	{ name: "probation: argon is never kept in v1", input: { current: cur("antigravity/gemini-4-argon"), history: hist() }, model: "anthropic/claude-sonnet-5-5:medium", action: "move" },
	{ name: "low: a kept deep model moves to general", input: { level: "low", current: cur("anthropic/claude-opus-5-5", "high"), history: hist() }, model: "anthropic/claude-sonnet-5-5:medium", action: "move" },
	{ name: "high: a kept basic model moves to general", input: { level: "high", current: cur("anthropic/claude-haiku-5-5", "low"), history: hist() }, model: "anthropic/claude-sonnet-5-5:medium", action: "move" },
];

for (const c of cases) {
	test(`policy: ${c.name}`, () => {
		const d = decideTurn(input(c.input), c.env ?? env());
		assert.equal(`${d.ref.key}:${d.ref.thinking}`, c.model);
		assert.equal(d.action, c.action);
		if (c.lane !== undefined) assert.equal(d.lane, c.lane);
		if (c.tier) assert.equal(d.tier, c.tier);
		if (c.reasons) assert.deepEqual(d.reasons, c.reasons);
		if (c.input.current && d.action !== "keep") assert.notEqual(d.ref.key, c.input.current.key, "never switch to the current model");
	});
}

test("policy: the router never selects excluded or probation models", () => {
	for (const task of ["writing_creative", "planning_design", "code_debugging", "qa_knowledge"]) {
		for (const difficulty of [0, 1, 2, 3, 4]) {
			for (const level of ["low", "medium", "high"] as Level[]) {
				const d = decideTurn(input({ level, goal: goal(task, difficulty, 0.9) }), env());
				assert.ok(!/fable|argon/.test(d.ref.key), d.ref.key);
			}
		}
	}
});

test("policy: tier helpers", () => {
	assert.equal(clampTier("deep", "low"), "general");
	assert.equal(clampTier("basic", "high"), "general");
	assert.equal(clampTier("basic", "medium"), "basic");
	assert.equal(tierOfModel(config, "openai-codex/gpt-6-astra", "high"), "deep");
	assert.equal(tierOfModel(config, "openai-codex/gpt-6-astra", "medium"), "general");
	assert.equal(tierOfModel(config, "xai/grok-4.7"), "general");
});

/** Beta parameters for `bad` bad outcomes out of n (alpha = 1 + good, beta = 1 + bad). */
const beta = (n: number, bad: number) => ({ alpha: 1 + n - bad, beta: 1 + bad, n });

test("policy: the prior keeps config order and removes only credibly worse models", () => {
	// Sonnet is first in general. Mildly worse than astra (not credible): it stays first.
	const mild: Prior = { models: { "anthropic/claude-sonnet-5-5": beta(60, 9), "openai-codex/gpt-6-astra": beta(400, 40) }, cells: {} };
	const keep = decideTurn(input({ goal: goal("code_debugging", 1.5) }), env({ prior: mild }));
	assert.equal(keep.ref.key, "anthropic/claude-sonnet-5-5");
	assert.deepEqual(keep.demoted, []);
	assert.equal(keep.prior_ref, "openai-codex/gpt-6-astra");
	assert.equal(keep.propensity, 0.9 + 0.1 / 2);
	assert.ok(keep.reasons.includes("prior"));
	// Credibly worse: 40% bad on 100 (lower bound 0.31) vs 10% on 400 (upper bound 0.13).
	const bad: Prior = { models: { "anthropic/claude-sonnet-5-5": beta(100, 40), "openai-codex/gpt-6-astra": beta(400, 40) }, cells: {} };
	const demoted = decideTurn(input({ goal: goal("code_debugging", 1.5) }), env({ prior: bad }));
	assert.equal(demoted.ref.key, "openai-codex/gpt-6-astra");
	assert.equal(demoted.propensity, 1, "only one model left: exploration has nothing to choose from");
	assert.equal(demoted.demoted?.length, 1);
	const d = demoted.demoted![0];
	assert.deepEqual([d.model, d.basis, d.n, d.ref, d.ref_n], ["anthropic/claude-sonnet-5-5", "model", 100, "openai-codex/gpt-6-astra", 400]);
	assert.ok(d.bad_lo > d.ref_bad_hi);
	assert.ok(demoted.reasons.includes("demoted:anthropic/claude-sonnet-5-5"));
});

test("policy: n < 20 is never demoted; the task cell is used only when both cells have n >= 20", () => {
	// One bad Luna turn (the real prior's case) does not move Luna below Flash.
	const luna: Prior = { models: { "openai-codex/gpt-6-luna": beta(1, 1), "antigravity/gemini-3.8-flash": beta(50, 9) }, cells: {} };
	assert.equal(decideTurn(input({ goal: goal("qa_knowledge", 0.3) }), env({ prior: luna })).ref.key, "openai-codex/gpt-6-luna");
	const allBad19: Prior = { models: { "openai-codex/gpt-6-luna": beta(19, 19), "antigravity/gemini-3.8-flash": beta(500, 5) }, cells: {} };
	assert.equal(decideTurn(input({ goal: goal("qa_knowledge", 0.3) }), env({ prior: allBad19 })).ref.key, "openai-codex/gpt-6-luna");
	// Same models fine overall but credibly bad on code_debugging, with both cells at n >= 20.
	const cells: Prior = {
		models: { "anthropic/claude-sonnet-5-5": beta(200, 20), "openai-codex/gpt-6-astra": beta(400, 40) },
		cells: { "anthropic/claude-sonnet-5-5|code_debugging": beta(40, 24), "openai-codex/gpt-6-astra|code_debugging": beta(80, 8) },
	};
	const dbg = decideTurn(input({ goal: goal("code_debugging", 1.5) }), env({ prior: cells }));
	assert.equal(dbg.ref.key, "openai-codex/gpt-6-astra");
	assert.equal(dbg.demoted?.[0].basis, "cell:code_debugging");
	assert.equal(decideTurn(input({ goal: goal("code_implementation", 1.5) }), env({ prior: cells })).ref.key, "anthropic/claude-sonnet-5-5");
	// Candidate cell under 20: model level decides (fine), so no demotion.
	const thin: Prior = { ...cells, cells: { ...cells.cells, "anthropic/claude-sonnet-5-5|code_debugging": beta(19, 19) } };
	assert.equal(decideTurn(input({ goal: goal("code_debugging", 1.5) }), env({ prior: thin })).ref.key, "anthropic/claude-sonnet-5-5");
});

test("policy: exploration is uniform over the models left, with propensity", () => {
	const prior: Prior = { models: { "openai-codex/gpt-6-luna": beta(100, 10), "antigravity/gemini-3.8-flash": beta(100, 10), "anthropic/claude-haiku-5-5": beta(100, 60) }, cells: {} };
	const draws = [0.05, 0.6]; // explore, then index 1 of the 2 left (flash)
	const d = decideTurn(input({ goal: goal("qa_knowledge", 0.3) }), env({ prior, rng: () => draws.shift()! }));
	assert.equal(d.ref.key, "antigravity/gemini-3.8-flash");
	assert.equal(d.explored, true);
	assert.equal(d.propensity, 0.1 / 2);
	assert.deepEqual(d.demoted?.map((x) => x.model), ["anthropic/claude-haiku-5-5"]);
	// Lateral moves are deterministic but skip a credibly bad model: opus -> (sol bad vs opus, the tier's best-supported) -> astra.
	const deep: Prior = { models: { "anthropic/claude-opus-5-5": beta(700, 90), "openai-codex/gpt-6.1-sol": beta(100, 50), "openai-codex/gpt-6-astra": beta(400, 40) }, cells: {} };
	const lat = decideTurn(input({ current: cur("anthropic/claude-opus-5-5", "high"), history: hist(0.1, 0.9) }), env({ prior: deep, rng: () => 0 }));
	assert.equal(`${lat.ref.key}:${lat.ref.thinking}`, "openai-codex/gpt-6-astra:high");
	assert.equal(lat.action, "lateral");
	assert.equal(lat.propensity, 1);
	assert.equal(lat.prior_ref, "anthropic/claude-opus-5-5");
});

test("policy: the real prior of 2026-10-24 demotes nothing; config order stands", () => {
	const real = JSON.parse(readFileSync(new URL("./data/prior-2026-10-24.json", import.meta.url), "utf8")) as Prior;
	const tasks = Object.keys(JSON.parse(readFileSync(new URL("../contracts/live-v1-goal.json", import.meta.url), "utf8")).questions.task.criteria);
	const first: Record<string, string> = { "0.3": "openai-codex/gpt-6-luna", "1.5": "anthropic/claude-sonnet-5-5", "3.2": "anthropic/claude-opus-5-5" };
	for (const task of tasks) {
		for (const [difficulty, model] of Object.entries(first)) {
			const d = decideTurn(input({ goal: goal(task, Number(difficulty), 0.5) }), env({ prior: real }));
			if (d.lane) continue;
			assert.deepEqual(d.demoted, [], `${task} ${difficulty}`);
			assert.equal(d.ref.key, model, `${task} ${difficulty}`);
		}
	}
	const basic = decideTurn(input({ goal: goal("qa_knowledge", 0.3) }), env({ prior: real }));
	assert.equal(basic.prior_ref, "antigravity/gemini-3.8-flash");
	assert.equal(basic.propensity, 0.9 + 0.1 / 3);
});

test("retry: overload detection", () => {
	for (const m of ["429 Too Many Requests", "overloaded_error: Overloaded", "HTTP 503 Service Unavailable", "rate limit exceeded", "502 Bad Gateway"]) {
		assert.ok(isOverload(m), m);
	}
	for (const m of [undefined, "", "prompt is too long: 250000 tokens > 200000 maximum", "invalid_request_error: bad tool schema", "aborted"]) {
		assert.ok(!isOverload(m), String(m));
	}
});

test("retry: same-tier alternative from another provider", () => {
	const alt = retryAlternative(env(), { key: "anthropic/claude-opus-5-5", thinking: "high" });
	assert.equal(alt?.ref.key, "openai-codex/gpt-6.1-sol");
	assert.equal(alt?.tier, "deep");
	const basic = retryAlternative(env(), { key: "openai-codex/gpt-6-luna", thinking: "low" });
	assert.equal(basic?.ref.key, "antigravity/gemini-3.8-flash");
	assert.equal(retryAlternative(env({ unavailable: ["openai-codex/gpt-6-astra"] }), { key: "anthropic/claude-sonnet-5-5" }), null);
});

test("A/B arm by weight with propensity", () => {
	assert.deepEqual(pickArm({ local: 0.5, jev: 0.5 }, () => 0.2), { arm: "local", p: 0.5 });
	assert.deepEqual(pickArm({ local: 0.5, jev: 0.5 }, () => 0.7), { arm: "jev", p: 0.5 });
	assert.deepEqual(pickArm({ local: 0, jev: 1 }, () => 0.1), { arm: "jev", p: 1 });
	assert.deepEqual(pickArm({ local: 1, jev: 3 }, () => 0.3), { arm: "jev", p: 0.75 });
});
