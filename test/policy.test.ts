/** Table-driven policy tests against the shipped config.json. */
import assert from "node:assert/strict";
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
	{ name: "creative prose lane barred when the spec is unclear (never-rule)", input: { goal: goal("writing_creative", 2, 0.4) }, model: "anthropic/claude-sonnet-5-5:medium", action: "pick", lane: null },
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
	{ name: "false success escalates basic -> general", input: { current: cur("openai-codex/gpt-6-luna", "low"), history: hist(0.1, 0.05, 0.5) }, model: "anthropic/claude-sonnet-5-5:medium", action: "escalate" },
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
	{ name: "never: unclear spec in force", input: { current: cur("meta/muse-wonder-full-1.0"), history: hist(), state: state("meta/muse-wonder-full-1.0", { goal: { task: "planning_design", difficulty: 2, spec_clear: 0.3 } }) }, model: "anthropic/claude-sonnet-5-5:medium", action: "move" },
	{ name: "never: other muse variants match the glob", input: { current: cur("meta/muse-wonder-1.0-contributor"), history: hist(0.1, 0.05, 0.6) }, model: "anthropic/claude-opus-5-5:high", action: "escalate" },
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

test("policy: prior picks by posterior mean of the task cell, model level when n < min_n", () => {
	const prior: Prior = {
		models: { "anthropic/claude-sonnet-5-5": { alpha: 50, beta: 50, n: 98 }, "openai-codex/gpt-6-astra": { alpha: 40, beta: 60, n: 98 } },
		cells: {
			"openai-codex/gpt-6-astra|code_debugging": { alpha: 18, beta: 2, n: 18 },
			"openai-codex/gpt-6-astra|qa_knowledge": { alpha: 9, beta: 1, n: 8 },
		},
	};
	const greedy = decideTurn(input({ goal: goal("code_debugging", 1.5) }), env({ prior }));
	assert.equal(greedy.ref.key, "openai-codex/gpt-6-astra");
	assert.ok(greedy.reasons.includes("prior"));
	assert.equal(greedy.propensity, 0.9 + 0.1 / 2);
	// qa cell has n=8 < 10: model level, where sonnet (0.5) beats astra (0.4).
	const modelLevel = decideTurn(input({ goal: goal("qa_knowledge", 1.5) }), env({ prior }));
	assert.equal(modelLevel.ref.key, "anthropic/claude-sonnet-5-5");
	// Exploration: first draw < epsilon, second picks index 0 (sonnet, not greedy).
	const draws = [0.05, 0.1];
	const explored = decideTurn(input({ goal: goal("code_debugging", 1.5) }), env({ prior, rng: () => draws.shift()! }));
	assert.equal(explored.ref.key, "anthropic/claude-sonnet-5-5");
	assert.equal(explored.explored, true);
	assert.equal(explored.propensity, 0.1 / 2);
	assert.ok(explored.reasons.includes("explore"));
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
