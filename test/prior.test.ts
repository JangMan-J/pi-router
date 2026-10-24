import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { choose, loadPrior } from "../src/prior.ts";

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
	assert.deepEqual(choose(["a/x", "b/y"], null, "t", 0.1, 10, () => 0), { index: 0, propensity: 1, explored: false });
});
