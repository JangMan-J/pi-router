/**
 * route() for router/auto: per-request dispatch, the decider calls for user turns, router state and
 * the decision log. The policy itself is in policy.ts.
 *
 * - user:          card -> history questions (if there is a model to keep) -> goal questions (first
 *                  turn or new goal) -> policy. Deciders that fail fall through; route() never throws
 *                  because of them. The first routed turn of a session that already has a working
 *                  model (router/auto selected mid-session) keeps it without asking.
 * - continuation:  the model of the latest response (request.previous).
 * - retry:         the failed model, or a same-tier alternative when its provider is overloaded.
 * - direct:        request.previous, else the first available basic-tier model.
 */
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { type Config, type ModelRef, parseRef, routerPath } from "./config.ts";
import { compactAnswers, type Contract, type DeciderCall, Deciders, loadContract } from "./deciders.ts";
import { fileLogger, type LogLine, stableStringify, stateHash } from "./log.ts";
import {
	type Decision,
	decideTurn,
	type Env,
	firstAvailable,
	goalSummary,
	isOverload,
	levelOf,
	needsGoal,
	pickArm,
	type RouterState,
	retryAlternative,
	type TurnInput,
} from "./policy.ts";
import { loadPrior, type Prior } from "./prior.ts";
import { type BranchEntry, buildLiveState } from "./state.ts";

/** The parts of pi's ExtensionContext the router uses. */
export interface RouteCtx {
	cwd: string;
	modelRegistry: {
		find(provider: string, modelId: string): Model<Api> | undefined;
		hasConfiguredAuth(model: Model<Api>): boolean;
	};
	sessionManager: {
		getBranch(): readonly unknown[];
		getHeader(): { cwd?: string } | null;
		getSessionId(): string;
	};
	ui?: { notify(message: string, type?: "info" | "warning" | "error"): void };
}

export interface RouterDeps {
	config: Config;
	deciders?: Deciders;
	contracts?: { history: Contract; goal: Contract };
	rng?: () => number;
	log?: (line: LogLine) => void;
	prior?: () => Prior | null;
	now?: () => Date;
}

type Request = ModelRouteRequest<RouterState>;
type Route = ModelRoute<RouterState>;

const keyOf = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;

export function createRouter(deps: RouterDeps) {
	const { config } = deps;
	const deciders = deps.deciders ?? new Deciders(config.backends, { breakerMs: config.breaker_ms });
	const contracts = deps.contracts ?? {
		history: loadContract(routerPath(config.contracts.history)),
		goal: loadContract(routerPath(config.contracts.goal)),
	};
	const rng = deps.rng ?? Math.random;
	const log = deps.log ?? fileLogger(routerPath(config.log_path));
	const prior = deps.prior ?? (() => loadPrior(routerPath(config.prior.path)));
	const now = deps.now ?? (() => new Date());

	const envFor = (ctx: RouteCtx, withPrior: boolean): Env => ({
		config,
		available: (ref: ModelRef) => {
			const m = ctx.modelRegistry.find(ref.provider, ref.id);
			return !!m && ctx.modelRegistry.hasConfiguredAuth(m);
		},
		prior: withPrior ? prior() : null,
		rng,
	});
	const physical = (ctx: RouteCtx, ref: ModelRef): Model<Api> => {
		const m = ctx.modelRegistry.find(ref.provider, ref.id);
		if (!m) throw new Error(`router: ${ref.key} is not in the catalog`);
		return m;
	};
	/** Return the stored state object itself when nothing changed, so pi appends no entry. */
	const settle = (prev: RouterState | undefined, next: RouterState): RouterState =>
		prev && stableStringify(prev) === stableStringify(next) ? prev : next;
	const notify = (ctx: RouteCtx, message: string, type: "info" | "warning" = "info") => {
		try {
			ctx.ui?.notify(message, type);
		} catch {
			/* no UI */
		}
	};

	/** A model to use when there is nothing better: the request's last model, the stored one, or the fallback tier. */
	function sticky(request: Request, ctx: RouteCtx, env: Env): Route {
		if (request.previous) return { model: request.previous.model, thinkingLevel: request.previous.thinkingLevel ?? "medium" };
		const s = request.state;
		const stored = s?.model ? ctx.modelRegistry.find(...split(s.model)) : undefined;
		if (s && stored) return { model: stored, thinkingLevel: s.thinking as ModelThinkingLevel };
		const ref = firstAvailable(env, config.fallback_tier) ?? firstAvailable(env, "basic");
		if (!ref) throw new Error("router: no tier model is available (credentials?)");
		return { model: physical(ctx, ref), thinkingLevel: ref.thinking };
	}

	async function routeUser(request: Request, ctx: RouteCtx): Promise<Route> {
		const t0 = performance.now();
		const env = envFor(ctx, true);
		const prev = request.state?.v === 1 ? request.state : undefined;
		const branch = ctx.sessionManager.getBranch() as BranchEntry[];
		const { state: card, entryId } = buildLiveState(
			{ cwd: ctx.sessionManager.getHeader()?.cwd ?? ctx.cwd },
			branch,
			request.messages as unknown as Record<string, unknown>[],
		);
		const arm = prev ? { arm: prev.arm, p: prev.arm_p } : pickArm(config.arms, rng);
		const order = [arm.arm, ...Object.keys(config.backends).filter((b) => b !== arm.arm)];
		const current = request.previous
			? { key: keyOf(request.previous.model), thinking: request.previous.thinkingLevel }
			: prev && ctx.modelRegistry.find(...split(prev.model))
				? { key: prev.model, thinking: prev.thinking }
				: null;
		const hasHistory = card.signals.user_turn_index > 0;
		const calls: DeciderCall[] = [];
		const used: { history: string | null; goal: string | null } = { history: null, goal: null };

		const input: TurnInput = {
			level: levelOf(request.thinkingLevel),
			current,
			state: prev,
			signals: card.signals,
			history: null,
			goal: null,
			thresholds: config.thresholds[arm.arm],
			adopt: !prev && !!current,
		};
		if (current && hasHistory && !input.adopt) {
			const r = await deciders.ask(order, contracts.history, card, true, request.signal);
			calls.push(...r.calls);
			input.history = r.answers;
			used.history = r.backend;
			if (r.backend) input.thresholds = config.thresholds[r.backend];
		}
		if (needsGoal(input)) {
			const r = await deciders.ask(order, contracts.goal, card, hasHistory, request.signal);
			calls.push(...r.calls);
			input.goal = r.answers;
			used.goal = r.backend;
		}
		const decision: Decision = decideTurn(input, env);
		const next = settle(prev, {
			v: 1,
			arm: arm.arm,
			arm_p: arm.p,
			model: decision.ref.key,
			thinking: decision.ref.thinking,
			tier: decision.tier,
			lane: decision.lane,
			goal: goalSummary(input.goal) ?? prev?.goal ?? null,
			// The decision that put the current model in place; a keep leaves it, so keeps append no state entry.
			last: decision.action === "keep" && prev?.model === decision.ref.key ? prev.last : { action: decision.action, reasons: decision.reasons },
		});
		const model =
			request.previous && decision.action === "keep" && keyOf(request.previous.model) === decision.ref.key
				? request.previous.model
				: physical(ctx, decision.ref);
		const priorNow = env.prior;
		log({
			ts: now().toISOString(),
			session: ctx.sessionManager.getSessionId(),
			entry: entryId,
			reason: "user",
			level: request.thinkingLevel,
			arm: arm.arm,
			arm_p: arm.p,
			backend: used,
			thresholds_from: used.history ?? arm.arm,
			decider_ms: Math.round(calls.reduce((s, c) => s + c.ms, 0) * 10) / 10,
			deciders: calls,
			answers: { history: compactAnswers(input.history), goal: compactAnswers(input.goal) },
			signals: card.signals,
			previous: current ? `${current.key}:${current.thinking ?? ""}` : null,
			chosen: `${decision.ref.key}:${decision.ref.thinking}`,
			tier: decision.tier,
			lane: decision.lane,
			action: decision.action,
			reasons: decision.reasons,
			propensity: decision.propensity,
			explored: decision.explored ?? false,
			prior: priorNow ? (priorNow.generated_at ?? priorNow.version ?? "present") : null,
			prior_ref: decision.prior_ref ?? null,
			demoted: decision.demoted ?? [],
			state_hash: stateHash(next),
			route_ms: Math.round((performance.now() - t0) * 10) / 10,
			config: config.version,
			contracts: { history: contracts.history.hash, goal: contracts.goal.hash },
		});
		if (decision.action !== "keep") notify(ctx, `router/auto → ${decision.ref.key}:${decision.ref.thinking} (${decision.reasons.join(", ")})`);
		return { model, thinkingLevel: decision.ref.thinking, state: next };
	}

	function routeRetry(request: Request, ctx: RouteCtx): Route {
		const failed = request.failed;
		const env = envFor(ctx, false);
		if (!failed) return sticky(request, ctx, env);
		const key = keyOf(failed.model);
		if (isOverload(failed.message.errorMessage)) {
			const alt = retryAlternative(env, { key, thinking: failed.thinkingLevel });
			if (alt) {
				const prev = request.state?.v === 1 ? request.state : undefined;
				const next: RouterState | undefined = prev && {
					...prev,
					model: alt.ref.key,
					thinking: alt.ref.thinking,
					tier: alt.tier,
					lane: null,
					last: { action: alt.action, reasons: alt.reasons },
				};
				log({
					ts: now().toISOString(),
					session: ctx.sessionManager.getSessionId(),
					reason: "retry",
					from: `${key}:${failed.thinkingLevel ?? ""}`,
					to: `${alt.ref.key}:${alt.ref.thinking}`,
					action: alt.action,
					reasons: alt.reasons,
					stop_reason: failed.message.stopReason,
					state_hash: next ? stateHash(next) : null,
				});
				notify(ctx, `router/auto: ${failed.model.id} overloaded → ${alt.ref.key}`, "warning");
				return { model: physical(ctx, alt.ref), thinkingLevel: alt.ref.thinking, ...(next ? { state: next } : {}) };
			}
		}
		return { model: failed.model, thinkingLevel: failed.thinkingLevel ?? "medium" };
	}

	async function route(request: Request, ctx: RouteCtx): Promise<Route> {
		switch (request.reason) {
			case "direct": {
				if (request.previous) return { model: request.previous.model, thinkingLevel: request.previous.thinkingLevel ?? "medium" };
				const ref = firstAvailable(envFor(ctx, false), "basic") ?? firstAvailable(envFor(ctx, false), config.fallback_tier);
				if (!ref) throw new Error("router: no basic-tier model is available (credentials?)");
				return { model: physical(ctx, ref), thinkingLevel: ref.thinking };
			}
			case "continuation":
				return sticky(request, ctx, envFor(ctx, false));
			case "retry":
				return routeRetry(request, ctx);
			default:
				try {
					return await routeUser(request, ctx);
				} catch (e) {
					// The policy or the card failed, not a decider (those never throw): stay put.
					const route = sticky(request, ctx, envFor(ctx, false));
					log({
						ts: now().toISOString(),
						session: ctx.sessionManager.getSessionId(),
						reason: "user",
						action: "fallback",
						error: String((e as Error)?.message ?? e).slice(0, 300),
						chosen: `${keyOf(route.model)}:${route.thinkingLevel}`,
					});
					return route;
				}
		}
	}

	return { route, deciders, contracts };
}

function split(key: string): [string, string] {
	const ref = parseRef(key);
	return [ref.provider, ref.id];
}
