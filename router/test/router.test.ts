process.env.PIPELINE_RECORDS = "off";

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { type Config, loadConfig, validateConfig } from "../src/config.ts";
import { activeBackends, type AskPairResult, type Deciders, selectPair } from "../src/deciders.ts";
import { classifyError, createRouter, createSessionRouter, reconcileAxes, resolveProfile, type SessionState, tierFromDepth } from "../src/router.ts";

const config = loadConfig();
assert.equal(createSessionRouter, createRouter);

function fakeCtx(session = "s1", cfg: Config = config) {
	const models = new Map<string, { provider: string; id: string }>();
	const addRef = (raw: string) => {
		const [provider, rest] = raw.split("/");
		const id = rest.split(":")[0];
		models.set(`${provider}/${id}`, { provider, id });
	};
	for (const tier of Object.keys(cfg.tiers) as (keyof typeof cfg.tiers)[]) {
		for (const raw of cfg.tiers[tier]) addRef(raw);
	}
	for (const p of Object.values(cfg.profiles ?? {})) {
		for (const raw of p.models) addRef(raw);
	}
	return {
		cwd: "/tmp",
		modelRegistry: {
			find: (provider: string, id: string) => models.get(`${provider}/${id}`),
			hasConfiguredAuth: () => true,
		},
		sessionManager: { getBranch: () => [], getHeader: () => ({ cwd: "/tmp" }), getSessionId: () => session },
	} as never;
}

function makeChoice(choice: string) {
	return { type: "choice" as const, choice, confidence: 0.8, probabilities: { [choice]: 0.8 } };
}

function makeAxes(depth: string, width: string, urgency: string) {
	return {
		depth: makeChoice(depth),
		width: makeChoice(width),
		urgency: makeChoice(urgency),
	};
}

function fakePairedDeciders(
	pair: { backend: string; answers: Record<string, unknown> | null }[],
	counter: { n: number },
): Deciders {
	return {
		askPair: async (): Promise<AskPairResult> => {
			counter.n++;
			return {
				assessments: pair.map((p) => ({
					backend: p.backend,
					model: config.backends[p.backend]?.model ?? p.backend,
					family: config.backends[p.backend]?.family ?? p.backend,
					answers: (p.answers as never) ?? null,
					call: { backend: p.backend, contract: "live-v2-axes", ms: 5, ok: !!p.answers },
				})),
				calls: pair.map((p) => ({ backend: p.backend, contract: "live-v2-axes", ms: 5, ok: !!p.answers })),
			};
		},
	} as unknown as Deciders;
}

const basicPair = [
	{ backend: "openrouter-mammoth", answers: makeAxes("0", "0", "3") },
	{ backend: "openrouter-pplx-decider", answers: makeAxes("0", "1", "3") },
];

test("configured active backends pair openrouter-mammoth and openrouter-pplx-decider with openrouter-jev and openrouter-mercury fallbacks", () => {
	const active = activeBackends(config.backends);
	assert.deepEqual(active, ["openrouter-mammoth", "openrouter-pplx-decider", "openrouter-jev", "openrouter-mercury"]);
	assert.deepEqual(selectPair(active, config.backends), ["openrouter-mammoth", "openrouter-pplx-decider"]);
	assert.equal(config.backends["openrouter-mammoth"]?.model, "baseten/mammoth-1:free");
	assert.equal(config.backends["openrouter-mammoth"]?.family, "baseten");
	assert.equal(config.backends["openrouter-pplx-decider"]?.model, "perplexity/pplx-decider-v1.2");
	assert.equal(config.backends["openrouter-pplx-decider"]?.family, "perplexity");
	assert.equal(config.backends["openrouter-jev"]?.model, "typesafe/jev-1.14");
	assert.equal(config.backends["openrouter-jev"]?.family, "typesafe");
	assert.equal(config.backends["openrouter-mercury"]?.model, "inception/mercury-decide");
	assert.equal(config.backends["openrouter-mercury"]?.family, "inception");
});

test("the first user turn selects once from paired 3-axis readings and records the profile and basis", async () => {
	const calls = { n: 0 };
	const router = createRouter({ config, deciders: fakePairedDeciders(basicPair, calls), log: () => {} });
	const route = await router.route(
		{ reason: "user", thinkingLevel: "medium", messages: [{ role: "user", content: [{ type: "text", text: "rename the typo" }] }] } as never,
		fakeCtx(),
	);
	assert.equal(calls.n, 1);
	const state = (route as { state?: SessionState }).state;
	assert.ok(state);
	assert.equal(state.basis, "judgement");
	assert.equal(state.profile, "quick");
	assert.equal(state.tier, "basic", "depth 0, width 1 picks quick (basic)");
	assert.equal(state.model, "antigravity/gemini-3.8-flash");
	assert.equal(state.thinking, "low");
	assert.ok(state.last.reasons.includes("profile:quick"));
	assert.equal(state.axes?.depth, "0");
	assert.equal(state.axes?.width, "1", "max(0, 1) on width");
	assert.equal(state.axes?.urgency, "3");
	assert.equal(state.axes?.status, "complete");
	assert.equal(state.axes?.disagreement, true, "width differed between openrouter-mammoth and openrouter-jev");
});

test("all 7 profiles in config.json resolve and select their configured primary model and thinking level", async () => {
	const cases: {
		expectedProfile: string;
		expectedTier: "basic" | "general" | "deep";
		expectedModel: string;
		expectedThinking: string;
		depth: "0" | "1" | "2" | "3";
		width: "0" | "1" | "2" | "3" | "unknown";
		urgency: "0" | "1" | "2" | "3" | "unknown";
	}[] = [
		{ expectedProfile: "quick", expectedTier: "basic", expectedModel: "antigravity/gemini-3.8-flash", expectedThinking: "low", depth: "0", width: "0", urgency: "3" },
		{ expectedProfile: "local_work", expectedTier: "general", expectedModel: "anthropic/claude-sonnet-5-5", expectedThinking: "medium", depth: "1", width: "1", urgency: "2" },
		{ expectedProfile: "wide_work", expectedTier: "general", expectedModel: "openai-codex/gpt-6-astra", expectedThinking: "medium", depth: "1", width: "2", urgency: "3" },
		{ expectedProfile: "diagnosis_scoping", expectedTier: "general", expectedModel: "anthropic/claude-sonnet-5-5", expectedThinking: "high", depth: "2", width: "1", urgency: "1" },
		{ expectedProfile: "diagnosis_exec", expectedTier: "general", expectedModel: "openai-codex/gpt-6-astra", expectedThinking: "high", depth: "2", width: "2", urgency: "2" },
		{ expectedProfile: "deep_focus", expectedTier: "deep", expectedModel: "anthropic/claude-opus-5-5", expectedThinking: "high", depth: "3", width: "1", urgency: "2" },
		{ expectedProfile: "deep_system", expectedTier: "deep", expectedModel: "openai-codex/gpt-6.1-sol", expectedThinking: "high", depth: "2", width: "3", urgency: "3" },
	];

	for (const c of cases) {
		const resolved = resolveProfile({ depth: c.depth, width: c.width, urgency: c.urgency }, config);
		assert.equal(resolved.id, c.expectedProfile);
		assert.equal(resolved.profile.tier, c.expectedTier);

		const calls = { n: 0 };
		const pair = [
			{ backend: "openrouter-mammoth", answers: makeAxes(c.depth, c.width, c.urgency) },
			{ backend: "openrouter-jev", answers: makeAxes(c.depth, c.width, c.urgency) },
		];
		const router = createRouter({ config, deciders: fakePairedDeciders(pair, calls), log: () => {} });
		const route = await router.route({ reason: "user", thinkingLevel: "medium", messages: [] } as never, fakeCtx());
		const state = (route as { state?: SessionState }).state;
		assert.ok(state, c.expectedProfile);
		assert.equal(state.profile, c.expectedProfile);
		assert.equal(state.tier, c.expectedTier);
		assert.equal(state.model, c.expectedModel);
		assert.equal(state.thinking, c.expectedThinking);
		assert.ok(state.last.reasons.includes(`profile:${c.expectedProfile}`));
	}
});

test("editing config.profiles[name].models changes which model is selected for that profile without code changes", async () => {
	const customConfig: Config = structuredClone(config);
	customConfig.profiles.wide_work.models = ["kimi-coding/k3.1-pro:medium", "anthropic/claude-sonnet-5-5:medium"];
	validateConfig(customConfig);

	const calls = { n: 0 };
	const pair = [
		{ backend: "openrouter-mammoth", answers: makeAxes("1", "3", "2") },
		{ backend: "openrouter-jev", answers: makeAxes("1", "2", "2") },
	];
	const router = createRouter({ config: customConfig, deciders: fakePairedDeciders(pair, calls), log: () => {} });
	const route = await router.route({ reason: "user", thinkingLevel: "medium", messages: [] } as never, fakeCtx("s-custom", customConfig));
	const state = (route as { state?: SessionState }).state;
	assert.ok(state);
	assert.equal(state.profile, "wide_work");
	assert.equal(state.model, "kimi-coding/k3.1-pro");
	assert.equal(state.thinking, "medium");
	assert.equal(state.tier, "general");
});

test("thinking level clamps basic up to general on high and deep down to general on low", async () => {
	const calls = { n: 0 };
	const routerHigh = createRouter({ config, deciders: fakePairedDeciders(basicPair, calls), log: () => {} });
	const routeHigh = await routerHigh.route({ reason: "user", thinkingLevel: "high", messages: [] } as never, fakeCtx());
	const stateHigh = (routeHigh as { state?: SessionState }).state;
	assert.ok(stateHigh);
	assert.equal(stateHigh.profile, "quick");
	assert.equal(stateHigh.tier, "general", "high clamps basic up to general");
	assert.equal(stateHigh.model, "anthropic/claude-sonnet-5-5");

	const deepPair = [
		{ backend: "openrouter-mammoth", answers: makeAxes("3", "1", "2") },
		{ backend: "openrouter-jev", answers: makeAxes("3", "1", "2") },
	];
	const routerLow = createRouter({ config, deciders: fakePairedDeciders(deepPair, calls), log: () => {} });
	const routeLow = await routerLow.route({ reason: "user", thinkingLevel: "low", messages: [] } as never, fakeCtx());
	const stateLow = (routeLow as { state?: SessionState }).state;
	assert.ok(stateLow);
	assert.equal(stateLow.profile, "deep_focus");
	assert.equal(stateLow.tier, "general", "low clamps deep down to general");
	assert.equal(stateLow.model, "anthropic/claude-sonnet-5-5");
});

test("validateConfig rejects invalid profile definitions and supports contracts.axes/goal and excluded globs", async () => {
	const noFallback = structuredClone(config);
	noFallback.fallback_profile = "does_not_exist";
	assert.throws(() => validateConfig(noFallback), /unknown fallback_profile/);

	const emptyModels = structuredClone(config);
	emptyModels.profiles.quick.models = [];
	assert.throws(() => validateConfig(emptyModels), /profile quick has no models/);

	const badAxis = structuredClone(config);
	(badAxis.profiles.quick.when as Record<string, unknown>).depth = ["99"];
	assert.throws(() => validateConfig(badAxis), /profile quick has invalid when\.depth/);

	const axesOnly = structuredClone(config);
	axesOnly.contracts = { axes: "contracts/live-v2-axes.json" } as never;
	validateConfig(axesOnly);

	const noContracts = structuredClone(config);
	noContracts.contracts = {} as never;
	assert.throws(() => validateConfig(noContracts), /contracts\.goal is missing/);

	// Excluded glob pattern skips matching models in router selection
	const globExcluded = structuredClone(config);
	globExcluded.excluded = [{ model: "antigravity/*" }];
	const calls = { n: 0 };
	const router = createRouter({ config: globExcluded, deciders: fakePairedDeciders(basicPair, calls), log: () => {} });
	const route = await router.route({ reason: "user", thinkingLevel: "medium", messages: [] } as never, fakeCtx("s-excl", globExcluded));
	const state = (route as { state?: SessionState }).state;
	assert.equal(state?.model, "openai-codex/gpt-6-luna", "antigravity/* is skipped by glob exclusion");
});

test("every later turn keeps the stored model without asking", async () => {
	const calls = { n: 0 };
	const router = createRouter({ config, deciders: fakePairedDeciders(basicPair, calls), log: () => {} });
	const first = await router.route({ reason: "user", thinkingLevel: "medium", messages: [] } as never, fakeCtx());
	const state = (first as { state?: unknown }).state;
	const again = await router.route({ reason: "user", thinkingLevel: "medium", state, messages: [] } as never, fakeCtx());
	assert.equal(calls.n, 1, "no second decider call");
	assert.equal((again as { model: { id: string } }).model.id, (first as { model: { id: string } }).model.id);
});

test("reconcileAxes takes max on depth/width, min on urgency, and tracks partial/disagreement", () => {
	const disagreed = reconcileAxes([
		{ backend: "a", answers: makeAxes("1", "2", "3") },
		{ backend: "b", answers: makeAxes("3", "1", "1") },
	]);
	assert.equal(disagreed.depth, "3");
	assert.equal(disagreed.width, "2");
	assert.equal(disagreed.urgency, "1");
	assert.equal(disagreed.status, "complete");
	assert.equal(disagreed.disagreement, true);

	const agreed = reconcileAxes([
		{ backend: "a", answers: makeAxes("2", "1", "3") },
		{ backend: "b", answers: makeAxes("2", "1", "3") },
	]);
	assert.equal(agreed.depth, "2");
	assert.equal(agreed.status, "complete");
	assert.equal(agreed.disagreement, false);

	const partialFromUnknown = reconcileAxes([
		{ backend: "a", answers: makeAxes("2", "unknown", "3") },
		{ backend: "b", answers: makeAxes("unknown", "1", "2") },
	]);
	assert.equal(partialFromUnknown.depth, "2");
	assert.equal(partialFromUnknown.width, "1");
	assert.equal(partialFromUnknown.urgency, "2");
	assert.equal(partialFromUnknown.status, "partial");
	assert.equal(partialFromUnknown.disagreement, true, "urgency differed (3 vs 2)");

	const partialFromOneFailure = reconcileAxes([
		{ backend: "a", answers: makeAxes("3", "2", "2") },
		{ backend: "b", answers: null },
	]);
	assert.equal(partialFromOneFailure.depth, "3");
	assert.equal(partialFromOneFailure.status, "partial");
	assert.equal(partialFromOneFailure.disagreement, false);
});

test("no usable decider answer falls back to the declared fallback_profile and says so", async () => {
	const calls = { n: 0 };
	const nonePair = [
		{ backend: "decider-a", answers: null },
		{ backend: "decider-b", answers: null },
	];
	const router = createRouter({ config, deciders: fakePairedDeciders(nonePair, calls), log: () => {} });
	const route = await router.route({ reason: "user", thinkingLevel: "medium", messages: [] } as never, fakeCtx());
	const state = (route as { state?: SessionState }).state;
	assert.equal(state?.basis, "declared");
	assert.equal(state?.profile, config.fallback_profile);
	assert.equal(state?.axes?.status, "none");
});

test("a retry after a rate limit swaps provider inside the tier, keeping the session choice shape", async () => {
	const calls = { n: 0 };
	const router = createRouter({ config, deciders: fakePairedDeciders(basicPair, calls), log: () => {} });
	const failed = { model: { provider: "openai-codex", id: "gpt-6-luna" }, thinkingLevel: "low", message: { errorMessage: "429 Too Many Requests" } };
	const route = await router.route({ reason: "retry", failed } as never, fakeCtx());
	assert.equal((route as { model: { provider: string } }).model.provider, "antigravity");
});

test("error classes come from the failure text", () => {
	assert.equal(classifyError("429 Too Many Requests"), "rate_limit");
	assert.equal(classifyError("Overloaded"), "overload");
	assert.equal(classifyError("invalid api key"), "auth");
	assert.equal(classifyError(null), null);
});

test("depth maps to a tier", () => {
	assert.equal(tierFromDepth("0", config), "basic");
	assert.equal(tierFromDepth("1", config), "general");
	assert.equal(tierFromDepth("2", config), "general");
	assert.equal(tierFromDepth("3", config), "deep");
	assert.equal(tierFromDepth("unknown", config), config.fallback_tier);
	assert.equal(tierFromDepth(null, config), config.fallback_tier);
});

test("a model already running when router/auto is selected is adopted without asking", async () => {
	const calls = { n: 0 };
	const router = createRouter({ config, deciders: fakePairedDeciders(basicPair, calls), log: () => {} });
	const route = await router.route(
		{ reason: "user", thinkingLevel: "medium", previous: { model: { provider: "anthropic", id: "claude-opus-5-5" }, thinkingLevel: "high" }, messages: [] } as never,
		fakeCtx(),
	);
	assert.equal(calls.n, 0, "an explicit model is a fact, not an assessment");
	const state = (route as { state?: SessionState }).state;
	assert.equal(state?.basis, "explicit");
	assert.equal(state?.profile, null);
	assert.equal(state?.model, "anthropic/claude-opus-5-5");
});

test("two-stage pivot cascade: Stage 1 high bi-encoder cosine keeps immediately without calling reranker or deciders", async () => {
	const deciderCalls = { n: 0 };
	const localCalls = { embed: 0, rerank: 0 };
	const mockFetch: typeof fetch = async (url, init) => {
		const u = String(url);
		if (u.endsWith("/v1/embeddings")) {
			localCalls.embed++;
			const body = JSON.parse(String(init?.body ?? "{}")) as { input: string[] };
			// Return nearly identical normalized vectors (cosine ~ 0.99)
			return new Response(
				JSON.stringify({
					data: body.input.map((_t, index) => ({ index, embedding: [0.8, 0.6, 0.0] })),
				}),
				{ status: 200 },
			);
		}
		if (u.endsWith("/v1/rerank")) {
			localCalls.rerank++;
			return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.99 }] }), { status: 200 });
		}
		throw new Error(`unexpected url ${u}`);
	};

	const router = createRouter({
		config,
		deciders: fakePairedDeciders(basicPair, deciderCalls),
		pivotFetch: mockFetch,
		log: () => {},
	});

	const first = await router.route(
		{
			reason: "user",
			thinkingLevel: "medium",
			messages: [{ role: "user", content: [{ type: "text", text: "Fix the typo in README.md line 12." }] }],
		} as never,
		fakeCtx(),
	);
	const state1 = (first as { state?: SessionState }).state!;
	assert.equal(deciderCalls.n, 1);
	assert.equal(localCalls.embed, 0, "initial turn does not call local embedder");
	assert.equal(state1.goal_anchor, "Fix the typo in README.md line 12.");

	// Continuation turn with high cosine similarity -> Stage 1 keeps immediately
	const second = await router.route(
		{
			reason: "user",
			thinkingLevel: "medium",
			state: state1,
			messages: [{ role: "user", content: [{ type: "text", text: "Also fix the typo on line 15 of README.md and commit." }] }],
		} as never,
		fakeCtx(),
	);
	const state2 = (second as { state?: SessionState }).state!;
	assert.equal(deciderCalls.n, 1, "no second 3-axis decider call");
	assert.equal(localCalls.embed, 1, "Stage 1 embedded goal + message");
	assert.equal(localCalls.rerank, 0, "Stage 2 reranker not called in Green Zone");
	assert.equal(state2.last.action, "keep");
	assert.ok(Array.isArray(state2.goal_embedding) && state2.goal_embedding.length === 3, "goal_embedding cached for future turns");
});

test("two-stage pivot cascade: ambiguous cosine or soft instability wakes Stage 2 reranker, keeping on high score and pivoting on low score", async () => {
	let currentPair = basicPair;
	const deciderCalls = { n: 0 };
	const localCalls = { embed: 0, rerank: 0 };
	let nextRerankScore = 0.94;

	const deciders: Deciders = {
		askPair: async (): Promise<AskPairResult> => {
			deciderCalls.n++;
			return {
				assessments: currentPair.map((p) => ({
					backend: p.backend,
					model: config.backends[p.backend]?.model ?? p.backend,
					family: config.backends[p.backend]?.family ?? p.backend,
					answers: (p.answers as never) ?? null,
					call: { backend: p.backend, contract: "live-v2-axes", ms: 5, ok: !!p.answers },
				})),
				calls: currentPair.map((p) => ({ backend: p.backend, contract: "live-v2-axes", ms: 5, ok: !!p.answers })),
			};
		},
	} as unknown as Deciders;

	const mockFetch: typeof fetch = async (url, init) => {
		const u = String(url);
		if (u.endsWith("/v1/embeddings")) {
			localCalls.embed++;
			const body = JSON.parse(String(init?.body ?? "{}")) as { input: string[] };
			// Return vectors with cosine = 0.48 (in the 0.25..0.62 ambiguous Yellow Zone)
			const vecs =
				body.input.length === 2
					? [
							[1.0, 0.0, 0.0],
							[0.48, 0.877, 0.0],
						]
					: [[0.48, 0.877, 0.0]];
			return new Response(
				JSON.stringify({
					data: vecs.map((embedding, index) => ({ index, embedding })),
				}),
				{ status: 200 },
			);
		}
		if (u.endsWith("/v1/rerank")) {
			localCalls.rerank++;
			return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: nextRerankScore }] }), { status: 200 });
		}
		throw new Error(`unexpected url ${u}`);
	};

	const router = createRouter({ config, deciders, pivotFetch: mockFetch, log: () => {} });
	const first = await router.route(
		{
			reason: "user",
			thinkingLevel: "medium",
			messages: [{ role: "user", content: [{ type: "text", text: "Fix the typo in README.md line 12." }] }],
		} as never,
		fakeCtx(),
	);
	const state1 = (first as { state?: SessionState }).state!;
	assert.equal(state1.profile, "quick");

	// Turn 2: Ambiguous cosine (0.48) wakes Stage 2 reranker, which scores 0.94 (same goal) -> keeps quick
	nextRerankScore = 0.94;
	const second = await router.route(
		{
			reason: "user",
			thinkingLevel: "medium",
			state: state1,
			messages: [{ role: "user", content: [{ type: "text", text: "Wait, check the spelling in the docs index header as well." }] }],
		} as never,
		fakeCtx(),
	);
	const state2 = (second as { state?: SessionState }).state!;
	assert.equal(localCalls.rerank, 1, "Stage 2 reranker woke up on ambiguous drift + soft cue");
	assert.equal(deciderCalls.n, 1, "reranker confirmed same goal, so no OpenRouter decider call");
	assert.equal(state2.last.action, "keep");
	assert.equal(state2.profile, "quick");

	// Turn 3: Ambiguous cosine + reranker scores 0.0002 (pivot!) -> triggers 3-axis deciders and switches to deep_system
	nextRerankScore = 0.0002;
	currentPair = [
		{ backend: "openrouter-mammoth", answers: makeAxes("3", "3", "3") },
		{ backend: "openrouter-pplx-decider", answers: makeAxes("3", "3", "3") },
	];
	const third = await router.route(
		{
			reason: "user",
			thinkingLevel: "medium",
			state: state2,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "Actually, forget the README and redesign the distributed authentication subsystem across all services.",
						},
					],
				},
			],
		} as never,
		fakeCtx(),
	);
	const state3 = (third as { state?: SessionState }).state!;
	assert.equal(localCalls.rerank, 2);
	assert.equal(deciderCalls.n, 2, "pivot triggered paired 3-axis decider review");
	assert.equal(state3.last.action, "pivot");
	assert.equal(state3.profile, "deep_system");
	assert.equal(state3.tier, "deep");
	assert.equal(state3.model, "openai-codex/gpt-6.1-sol");
	assert.ok(state3.last.reasons.some((r) => r.startsWith("pivot:rerank:")));
	assert.ok(state3.goal_anchor?.includes("redesign the distributed authentication subsystem"));
});

test("two-stage pivot cascade: hard telemetry instability triggers immediate pivot without calling embedder or reranker", async () => {
	const deciderCalls = { n: 0 };
	const localCalls = { embed: 0, rerank: 0 };
	const mockFetch: typeof fetch = async () => {
		localCalls.embed++;
		localCalls.rerank++;
		throw new Error("should not call local models on hard telemetry instability");
	};

	const deepExecPair = [
		{ backend: "openrouter-mammoth", answers: makeAxes("3", "1", "3") },
		{ backend: "openrouter-pplx-decider", answers: makeAxes("3", "1", "3") },
	];
	const router = createRouter({
		config,
		deciders: fakePairedDeciders(deepExecPair, deciderCalls),
		pivotFetch: mockFetch,
		log: () => {},
	});

	// Branch history containing 2 repeated tool errors with the same fingerprint
	const branchWithRepeatedErrors = [
		{ type: "message", id: "u1", message: { role: "user", content: "Fix the build." } },
		{
			type: "message",
			id: "a1",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "cargo check" } },
					{ type: "toolCall", id: "tc2", name: "bash", arguments: { command: "cargo check" } },
				],
			},
		},
		{ type: "message", id: "tr1", message: { role: "toolResult", toolCallId: "tc1", toolName: "bash", isError: true, content: "error[E0308]: mismatched types" } },
		{ type: "message", id: "tr2", message: { role: "toolResult", toolCallId: "tc2", toolName: "bash", isError: true, content: "error[E0308]: mismatched types" } },
		{ type: "message", id: "u2", message: { role: "user", content: "Still failing." } },
	];

	const ctx = {
		...(fakeCtx() as Record<string, unknown>),
		sessionManager: {
			getBranch: () => branchWithRepeatedErrors,
			getHeader: () => ({ cwd: "/tmp" }),
			getSessionId: () => "s-trouble",
		},
	} as never;

	const prevState: SessionState = {
		v: 1,
		model: "antigravity/gemini-3.8-flash",
		thinking: "low",
		tier: "basic",
		profile: "quick",
		lane: null,
		axes: null,
		basis: "judgement",
		goal_anchor: "Fix the build.",
		last: { action: "initial", reasons: ["profile:quick"] },
	};

	const routed = await router.route({ reason: "user", thinkingLevel: "medium", state: prevState, messages: [] } as never, ctx);
	const nextState = (routed as { state?: SessionState }).state!;
	assert.equal(localCalls.embed, 0, "hard telemetry instability skips local embedder");
	assert.equal(localCalls.rerank, 0, "hard telemetry instability skips local reranker");
	assert.equal(deciderCalls.n, 1, "hard telemetry instability triggers 3-axis decider review");
	assert.equal(nextState.last.action, "pivot");
	assert.equal(nextState.profile, "deep_focus");
	assert.equal(nextState.model, "anthropic/claude-opus-5-5");
	assert.ok(nextState.last.reasons.includes("pivot:repeated_error:2"));
});

test("project summary stub (.anchor/router-stub.md) is auto-discovered from cwd and composed into Stage 1 and Stage 2 anchors, and trivial openers promote on Turn 1", async () => {
	const deciderCalls = { n: 0 };
	const embeddedInputs: string[][] = [];
	const rerankQueries: string[] = [];

	const mockFetch: typeof fetch = async (url, init) => {
		const u = String(url);
		if (u.endsWith("/v1/embeddings")) {
			const body = JSON.parse(String(init?.body ?? "{}")) as { input: string[] };
			embeddedInputs.push(body.input);
			const vecs =
				body.input.length === 2
					? [
							[1.0, 0.0, 0.0],
							[0.5, 0.866, 0.0],
						]
					: [[0.5, 0.866, 0.0]];
			return new Response(
				JSON.stringify({
					data: vecs.map((embedding, index) => ({ index, embedding })),
				}),
				{ status: 200 },
			);
		}
		if (u.endsWith("/v1/rerank")) {
			const body = JSON.parse(String(init?.body ?? "{}")) as { query: string };
			rerankQueries.push(body.query);
			return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.91 }] }), { status: 200 });
		}
		throw new Error(`unexpected url ${u}`);
	};

	const router = createRouter({
		config,
		deciders: fakePairedDeciders(basicPair, deciderCalls),
		pivotFetch: mockFetch,
		log: () => {},
	});

	// Use pi-router workspace root which has .anchor/router-stub.md
	const piRouterCwd = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
	const ctxWithStub = {
		...(fakeCtx() as Record<string, unknown>),
		cwd: piRouterCwd,
		sessionManager: {
			getBranch: () => [],
			getHeader: () => ({ cwd: piRouterCwd }),
			getSessionId: () => "s-stub",
		},
	} as never;

	// Turn 0: Trivial opener ("testing")
	const t0 = await router.route(
		{
			reason: "user",
			thinkingLevel: "medium",
			messages: [{ role: "user", content: [{ type: "text", text: "testing" }] }],
		} as never,
		ctxWithStub,
	);
	const state0 = (t0 as { state?: SessionState }).state!;
	assert.equal(state0.goal_anchor, "testing");
	assert.ok(state0.project_stub?.includes("Live session model router"), ".anchor/router-stub.md loaded from cwd");

	// Turn 1: First substantive prompt (>= 4 words) promotes over trivial "testing" opener and re-evaluates
	const t1 = await router.route(
		{
			reason: "user",
			thinkingLevel: "medium",
			state: state0,
			messages: [{ role: "user", content: [{ type: "text", text: "Update the breaker timeout in config.json and run tests." }] }],
		} as never,
		ctxWithStub,
	);
	const state1 = (t1 as { state?: SessionState }).state!;
	assert.equal(state1.last.action, "pivot");
	assert.ok(state1.last.reasons.includes("pivot:promoted_trivial_opener"));
	assert.equal(state1.goal_anchor, "Update the breaker timeout in config.json and run tests.");

	// Turn 2: Continuation turn embeds composite `${goal_anchor}\n\n---\n${project_stub}` and passes `Project context:` to Stage 2
	const t2 = await router.route(
		{
			reason: "user",
			thinkingLevel: "medium",
			state: state1,
			messages: [{ role: "user", content: [{ type: "text", text: "Wait, also check the fallback order in deciders.ts." }] }],
		} as never,
		ctxWithStub,
	);
	const state2 = (t2 as { state?: SessionState }).state!;
	assert.equal(state2.last.action, "keep");
	assert.equal(embeddedInputs.length, 1);
	assert.ok(
		embeddedInputs[0][0].includes("Update the breaker timeout in config.json and run tests.\n\n---\nLive session model router"),
		"Stage 1 embeds composite goal_anchor + .anchor/router-stub.md",
	);
	assert.equal(rerankQueries.length, 1);
	assert.ok(rerankQueries[0].startsWith("Project context: Live session model router"), "Stage 2 includes Project context from .anchor/router-stub.md");
});

test("optional tag in .anchor/router-stub.md applies dynamic tag-mappings.json candidates when present and does nothing when absent or disabled", async () => {
	const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");

	const tmpCwd = mkdtempSync(join(tmpdir(), "router-stub-tag-"));
	try {
		mkdirSync(join(tmpCwd, ".anchor"), { recursive: true });
		// Write stub with optional tag: code:frontend_ui
		writeFileSync(
			join(tmpCwd, ".anchor", "router-stub.md"),
			"---\ntag: code:frontend_ui\n---\nReact/TypeScript UI workspace for dashboard components.\n",
		);

		const diagExecPair = [
			{ backend: "openrouter-mammoth", answers: makeAxes("2", "1", "2") },
			{ backend: "openrouter-pplx-decider", answers: makeAxes("2", "1", "2") },
		];
		const calls = { n: 0 };
		const router = createRouter({ config, deciders: fakePairedDeciders(diagExecPair, calls), log: () => {} });

		const ctx = {
			...(fakeCtx() as Record<string, unknown>),
			cwd: tmpCwd,
			sessionManager: {
				getBranch: () => [],
				getHeader: () => ({ cwd: tmpCwd }),
				getSessionId: () => "s-tag",
			},
		} as never;

		const routed = await router.route(
			{
				reason: "user",
				thinkingLevel: "medium",
				messages: [{ role: "user", content: [{ type: "text", text: "Fix the virtualized table scroll jitter." }] }],
			} as never,
			ctx,
		);
		const state = (routed as { state?: SessionState }).state!;
		assert.equal(state.profile, "diagnosis_exec");
		assert.equal(state.project_tag, "code:frontend_ui");
		assert.equal(
			state.project_stub,
			"React/TypeScript UI workspace for dashboard components.",
			"frontmatter tag stripped from summary prose",
		);
		assert.equal(state.model, "xai/grok-4.7", "code:frontend_ui deep/high mapping promotes xai/grok-4.7");
		assert.equal(state.thinking, "high");
		assert.ok(state.last.reasons.includes("tag:code:frontend_ui"));

		// When tag_routing is disabled in config, falls back to standard diagnosis_exec primary (openai-codex/gpt-6-astra)
		const disabledCfg: Config = structuredClone(config);
		disabledCfg.tag_routing = { enabled: false, mappings_path: "tag-mappings.json" };
		const routerDisabled = createRouter({ config: disabledCfg, deciders: fakePairedDeciders(diagExecPair, calls), log: () => {} });
		const routedDisabled = await routerDisabled.route(
			{
				reason: "user",
				thinkingLevel: "medium",
				messages: [{ role: "user", content: [{ type: "text", text: "Fix the virtualized table scroll jitter." }] }],
			} as never,
			ctx,
		);
		const stateDisabled = (routedDisabled as { state?: SessionState }).state!;
		assert.equal(stateDisabled.model, "openai-codex/gpt-6-astra");
		assert.ok(!stateDisabled.last.reasons.includes("tag:code:frontend_ui"));
	} finally {
		rmSync(tmpCwd, { recursive: true, force: true });
	}
});
