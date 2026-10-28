/**
 * router/auto: a pi virtual model (`session@v2`) that selects a model on the initial user turn
 * from a paired 3-axis decider review and keeps that model across normal continuations, re-evaluating
 * only when the local two-stage pivot cascade (`src/pivot.ts`) confirms a task pivot or hard instability.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./src/config.ts";
import { createRouter, type SessionState } from "./src/router.ts";

export default function (pi: ExtensionAPI) {
	const router = createRouter({ config: loadConfig() });
	pi.registerVirtualModel<SessionState>({
		provider: "router",
		id: "auto",
		name: "Auto (router)",
		// low caps the tier at general, high floors it at general; the level also clamps the session pick.
		thinkingLevels: ["low", "medium", "high"],
		contextWindow: 500_000,
		maxTokens: 128_000,
		route: (request, ctx) => router.route(request, ctx),
	});
}
