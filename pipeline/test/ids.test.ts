import { strict as assert } from "node:assert";
import { test } from "node:test";
import { admissionKey, canonical, id, wilson } from "../src/ids.ts";

test("ids are derived from bytes, not clocks", () => {
	assert.equal(id.representation("hash-ngram", "1", "request-text", "1", "fix it"), id.representation("hash-ngram", "1", "request-text", "1", "fix it"));
	assert.notEqual(id.representation("hash-ngram", "1", "request-text", "1", "fix it"), id.representation("hash-ngram", "2", "request-text", "1", "fix it"));
	assert.notEqual(id.representation("hash-ngram", "1", "request-text", "1", "fix it"), id.representation("hash-ngram", "1", "contextual", "1", "fix it"));
	assert.match(id.assignment("x"), /^asg_[0-9a-f]{16}$/);
});

test("admission: the same event reuses an id, the same text does not", () => {
	const a = admissionKey({ origin: "spider", session: "s1", entryId: "e1" });
	const b = admissionKey({ origin: "spider", session: "s1", entryId: "e1" });
	const c = admissionKey({ origin: "spider", session: "s1", entryId: "e2" });
	const d = admissionKey({ origin: "jail", session: "s1", entryId: "e1" });
	assert.equal(a, b);
	assert.notEqual(a, c);
	assert.notEqual(a, d);
	assert.notEqual(admissionKey({ request: "hi" }), admissionKey({ request: "hi " }));
});

test("canonical json ignores key order and keeps nulls", () => {
	assert.equal(canonical({ b: 1, a: [2, { d: 3, c: null }] }), canonical({ a: [2, { c: null, d: 3 }], b: 1 }));
	assert.equal(canonical({ a: 1 }), canonical({ a: 1, b: undefined }));
});

test("wilson does not print 2/3 as 67% without a range", () => {
	const [lo, hi] = wilson(2, 3);
	assert.ok(lo < 0.3 && hi > 0.9);
	assert.deepEqual(wilson(0, 0), [0, 1]);
});
