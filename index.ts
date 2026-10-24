/**
 * router/auto: Jang's model router as a pi virtual model.
 *
 * Keeps the model that is already working (a switch drops the prompt cache) and moves only on user
 * turns: up a tier when the agent is at fault, to a re-picked tier or lane when the session's goal
 * changes. Decision models answer typed questions about a card of the turn (src/state.ts) over
 * System One; see README.md and config.json.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./src/config.ts";
import type { RouterState } from "./src/policy.ts";
import { createRouter } from "./src/router.ts";

export default function (pi: ExtensionAPI) {
	const router = createRouter({ config: loadConfig() });
	pi.registerVirtualModel<RouterState>({
		provider: "router",
		id: "auto",
		name: "Auto (router)",
		// low = cost saver (tier capped at general), medium = default, high = quality (floor general, new goals one tier up).
		thinkingLevels: ["low", "medium", "high"],
		// The smallest window among the tier and lane models (gpt-6 and grok-4.7: 500K).
		contextWindow: 500_000,
		maxTokens: 128_000,
		route: (request, ctx) => router.route(request, ctx),
	});
}
