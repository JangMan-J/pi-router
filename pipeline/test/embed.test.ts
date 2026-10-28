import { strict as assert } from "node:assert";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { bm25, cosine, encodeDense, encodeSparse, represent, type EncoderSpec } from "../src/embed.ts";

const dense: EncoderSpec = { id: "hash-ngram", version: "1", kind: "dense", dim: 512 };
const sparse: EncoderSpec = { id: "bm25", version: "1", kind: "sparse", max_terms: 512 };

test("dense encoder is deterministic and normalised", () => {
	const a = encodeDense(dense, "fix the failing test in policy.ts");
	const b = encodeDense(dense, "fix the failing test in policy.ts");
	assert.deepEqual([...a], [...b]);
	assert.ok(Math.abs(Math.hypot(...a) - 1) < 1e-5);
	const near = cosine(a, encodeDense(dense, "the test in policy.ts is failing"));
	const far = cosine(a, encodeDense(dense, "rename the screenshot directory"));
	assert.ok(near > far, `${near} should beat ${far}`);
});

test("representation cache: a hit does not encode again", () => {
	const db = openDb(":memory:");
	let encodes = 0;
	const hooks = { onEncode: () => encodes++ };
	const first = represent(db, dense, { id: "request-text", version: "1" }, "push it", { record: "assignment", id: "asg_1" }, hooks);
	const second = represent(db, dense, { id: "request-text", version: "1" }, "push it", { record: "assignment", id: "asg_2" }, hooks);
	assert.equal(encodes, 1);
	assert.equal(first.cached, false);
	assert.equal(second.cached, true);
	assert.equal(first.representationId, second.representationId);
	const other = represent(db, dense, { id: "contextual", version: "1" }, "push it", { record: "assignment", id: "asg_3" }, hooks);
	assert.notEqual(other.representationId, first.representationId);
	assert.equal(encodes, 2);
});

test("bm25 ranks the document with the rarer terms first", () => {
	const docs = [
		{ representationId: "a", terms: encodeSparse(sparse, "fix the failing test") },
		{ representationId: "b", terms: encodeSparse(sparse, "write the release notes") },
		{ representationId: "c", terms: encodeSparse(sparse, "the the the") },
	];
	const ranked = bm25("failing test", docs);
	assert.equal(ranked[0].representationId, "a");
	assert.ok(!ranked.some((r) => r.representationId === "b"));
});
