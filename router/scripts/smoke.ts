/**
 * Live check of the decision backends: builds the card for the latest user turn of a real session
 * and asks every enabled backend the 3-axis contract (contracts/live-v2-axes.json) with the configured
 * timeouts. Prints latency, errors and the compact answers only.
 *
 * Usage: node scripts/smoke.ts [session.jsonl]   (default: newest file under ~/.pi/agent/sessions)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, routerPath } from "../src/config.ts";
import { compactAnswers, Deciders, loadContract } from "../src/deciders.ts";
import { buildLiveState } from "../src/state.ts";

function newestSession(dir: string): string {
	let best = { path: "", mtime: 0 };
	const walk = (d: string) => {
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			const st = statSync(p);
			if (st.isDirectory()) walk(p);
			else if (name.endsWith(".jsonl") && st.mtimeMs > best.mtime) best = { path: p, mtime: st.mtimeMs };
		}
	};
	walk(dir);
	return best.path;
}

const file = process.argv[2] ?? newestSession(join(homedir(), ".pi", "agent", "sessions"));
const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const header = lines.find((e) => e.type === "session") ?? {};
const byId = new Map(lines.filter((e) => e.id && e.type !== "session").map((e) => [e.id, e]));
const leaf = [...byId.values()].findLast((e) => e.type === "message" && e.message?.role === "user");
const branch: any[] = [];
for (let e = leaf; e; e = byId.get(e.parentId)) branch.unshift(e);
const { state: card } = buildLiveState(header, branch, []);
const config = loadConfig();
const goal = loadContract(routerPath(config.contracts.goal));
const hasHistory = card.signals.user_turn_index > 0;
console.log(`session ${file.split("/").pop()}  turn ${card.signals.user_turn_index}  card ${JSON.stringify(card).length} chars`);
for (const [backend, spec] of Object.entries(config.backends)) {
	if (spec.enabled === false) {
		console.log(`${backend.padEnd(24)} goal     skip       0 ms  disabled`);
		continue;
	}
	const deciders = new Deciders(config.backends, { breakerMs: config.breaker_ms });
	const r = await deciders.ask([backend], goal, card, hasHistory);
	const c = r.calls[0];
	console.log(
		`${backend.padEnd(24)} goal     ${c.ok ? "ok " : "ERR"} ${String(c.ms).padStart(7)} ms  ${c.error ?? c.skipped ?? (c.problems ?? []).join("; ")}${r.answers ? ` ${JSON.stringify(compactAnswers(r.answers))}` : ""}`,
	);
}
