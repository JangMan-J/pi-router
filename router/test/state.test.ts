/** Parity: src/state.ts must produce byte-identical cards to bench/sample_states.py build_state(). */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { buildLiveState, buildState, clip, pyJsonDumps, redact } from "../src/state.ts";

const LOCAL_FIXTURES = new URL("./fixtures/parity.jsonl", import.meta.url);
const SYNTHETIC_FIXTURES = new URL("./synthetic-parity.jsonl", import.meta.url);
const FIXTURES = process.env.PARITY_FIXTURES
	? process.env.PARITY_FIXTURES
	: existsSync(LOCAL_FIXTURES)
		? LOCAL_FIXTURES
		: SYNTHETIC_FIXTURES;
const usingLocalFixtures = existsSync(LOCAL_FIXTURES) || Boolean(process.env.PARITY_FIXTURES);

test("parity fixtures exist (run `npm run fixtures`)", () => {
	assert.ok(existsSync(FIXTURES), "parity fixtures missing: run `npm run fixtures`");
});

const rows = existsSync(FIXTURES)
	? readFileSync(FIXTURES, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l))
	: [];

for (const row of rows) {
	test(`parity ${row.id} [${row.categories.join(",")}]`, () => {
		const branch = row.branch as any[];
		const target = branch[branch.length - 1];
		const got = JSON.stringify(buildState(row.header, branch.slice(0, -1), target.message));
		assert.equal(got, row.expected);
		// The live path finds the same target on a branch that ends with the user entry.
		const live = buildLiveState(row.header, branch, [target.message]);
		assert.equal(JSON.stringify(live.state), row.expected);
		assert.equal(live.entryId, target.id);
	});
}

test("parity covers the required kinds of turns", () => {
	if (!rows.length) return;
	const has = (c: string) => rows.filter((r) => r.categories.includes(c)).length;
	if (usingLocalFixtures) {
		assert.ok(rows.filter((r) => !r.categories.includes("synthetic")).length >= 40);
		for (const c of ["turn0", "tool_error", "image"]) assert.ok(has(c) + (c === "image" ? has("synthetic") : 0) > 0, c);
	} else {
		assert.ok(has("synthetic") >= 2);
		assert.ok(has("turn0") >= 1);
	}
});

test("live state: user message not yet on the branch is taken from the request", () => {
	const branch = [
		{ type: "message", id: "a", parentId: null, message: { role: "user", content: "first", timestamp: 1 } },
		{ type: "message", id: "b", parentId: "a", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
	];
	const live = buildLiveState({ cwd: "/home/u/p" }, branch, [
		{ role: "user", content: "first", timestamp: 1 },
		{ role: "user", content: "second", timestamp: 2 },
	]);
	assert.equal(live.entryId, null);
	assert.equal(live.state.user_message, "second");
	assert.equal(live.state.previous_user_message, "first");
	assert.equal(live.state.previous_assistant_reply, "ok");
	assert.equal(live.state.signals.user_turn_index, 1);
	assert.equal(live.state.project, "p");
});

test("python helpers", () => {
	assert.equal(pyJsonDumps({ a: [1, 2.5, true, null], "é": "\u007f😀" }), '{"a": [1, 2.5, true, null], "\\u00e9": "\\u007f\\ud83d\\ude00"}');
	assert.equal(clip("😀".repeat(10), 4), "😀😀\n…[6 chars cut]…\n😀😀");
	assert.equal(redact("é" + "sk-" + "a".repeat(20)), "é" + "sk-" + "a".repeat(20)); // no \b after a Unicode letter
	assert.equal(redact("(sk-" + "a".repeat(20) + ")"), "([REDACTED])");
	assert.equal(redact("maxTokens: 4096 MY_API_KEY=abcdefgh1234"), "maxTokens: 4096 MY_API_KEY=[REDACTED]");
});
