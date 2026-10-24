import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { choose, demotions, loadPrior, wilson } from "../src/prior.ts";

test("loadPrior: missing, empty, invalid and changed files", () => {
	const dir = mkdtempSync(join(tmpdir(), "prior-"));
	const path = join(dir, "prior.json");
	assert.equal(loadPrior(path), null);
	writeFileSync(path, JSON.stringify({ version: 1, generated_at: "t", models: {}, cells: {} }));
	assert.equal(loadPrior(path), null, "no entries: treated as absent");
	writeFileSync(path, "{broken");
	utimesSync(path, new Date(), new Date(Date.now() + 5000));
	assert.equal(loadPrior(path), null);
	writeFileSync(path, JSON.stringify({ models: { "a/b": { alpha: 2, beta: 1, n: 1 } }, cells: {} }));
	utimesSync(path, new Date(), new Date(Date.now() + 10000));
	assert.deepEqual(loadPrior(path)?.models, { "a/b": { alpha: 2, beta: 1, n: 1 } });
});

test("choose: without a prior, config order with propensity 1", () => {
	assert.deepEqual(choose(["a/x", "b/y"], null, "t", 0.1, 10, () => 0), { index: 0, propensity: 1, explored: false, demoted: [] });
});

test("wilson: 95% interval", () => {
	const w = wilson(10, 100);
	assert.ok(Math.abs(w.lo - 0.0552) < 1e-4 && Math.abs(w.hi - 0.1744) < 1e-4, JSON.stringify(w));
	assert.deepEqual(wilson(0, 0), { lo: 0, hi: 1 });
	assert.equal(wilson(0, 50).lo, 0);
});

test("demotions: reference is the model with the most outcomes; ties go to config order", () => {
	const b = (n: number, bad: number) => ({ alpha: 1 + n - bad, beta: 1 + bad, n });
	const prior = { models: { "a/x": b(100, 10), "b/y": b(100, 50), "c/z": b(5, 5) }, cells: {} };
	const r = demotions(["c/z", "a/x", "b/y"], prior, null, 20);
	assert.equal(r.ref, "a/x");
	assert.deepEqual(r.demoted.map((d) => d.model), ["b/y"]);
	assert.deepEqual(demotions(["n/a", "m/b"], { models: {}, cells: {} }, null, 20), { ref: null, demoted: [] });
	// The reference comes from the whole tier even when it is not a candidate (current model, no credentials).
	const t = demotions(["b/y"], prior, null, 20, ["a/x", "b/y"]);
	assert.equal(t.ref, "a/x");
	assert.deepEqual(t.demoted.map((d) => d.model), ["b/y"]);
});
