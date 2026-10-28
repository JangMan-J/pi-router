import { strict as assert } from "node:assert";
import { test } from "node:test";
import { insert, openDb } from "../src/db.ts";
import { consult } from "../src/consult.ts";

const encoders = [
	{ id: "hash-ngram", version: "1", kind: "dense" as const, dim: 512, backend: "local" as const },
	{ id: "bm25", version: "1", kind: "sparse" as const, max_terms: 512, backend: "local" as const },
	{ id: "qwen3-embedding-0.6b", version: "1", kind: "dense" as const, dim: 4, backend: "http" as const, api: "openai" as const, url: "http://fake" },
];

function seed(encoderId: string, encoderVersion: string, vectors: number[][], recipe = "request-text") {
	const db = openDb(":memory:");
	vectors.forEach((v, i) => {
		const id = `emb_${encoderId.replace(/[^a-z0-9]/g, "")}_${i}`;
		const f = Float32Array.from(v);
		insert(db, "representations", {
			representation_id: id,
			encoder_id: encoderId,
			encoder_version: encoderVersion,
			recipe_id: recipe,
			recipe_version: "1",
			input_sha256: `sha_${i}`,
			source_record: "assignment",
			source_id: `asg_${i}`,
			dim: v.length,
			vector: new Uint8Array(f.buffer.slice(0)),
			created_utc: new Date().toISOString(),
		});
		insert(db, "representation_links", { representation_id: id, assignment_id: `asg_${i}`, snapshot_id: null, created_utc: new Date().toISOString() });
	});
	return db;
}

test("consult encodes the query with the encoder that produced the vectors", async () => {
	const db = seed("qwen3-embedding-0.6b", "1", [[1, 0, 0, 0], [0, 1, 0, 0]]);
	let asked: unknown = null;
	const fakeFetch = (async (_url: string, init: { body: string }) => {
		asked = JSON.parse(init.body).input;
		return { ok: true, status: 200, json: async () => ({ data: [{ embedding: [1, 0, 0, 0], index: 0 }] }) } as unknown as Response;
	}) as unknown as typeof fetch;
	const r = await consult(db, { text: "the broker exits", encoders, encoder: "qwen3-embedding-0.6b", fetchImpl: fakeFetch });
	assert.equal(r.encoder, "qwen3-embedding-0.6b@1");
	assert.deepEqual(asked, ["the broker exits"]);
	assert.equal(r.dense[0].assignmentId, "asg_0");
	assert.ok(r.dense[0].score > 0.99);
});

test("a named encoder with no stored rows falls back to one that has them", async () => {
	const db = seed("hash-ngram", "1", [[1, 0, 0, 0], [0, 1, 0, 0]]);
	const r = await consult(db, { text: "anything", encoders, encoder: "qwen3-embedding-0.6b" });
	assert.equal(r.encoder, "hash-ngram@1");
	assert.equal(r.dense.length, 2);
});
