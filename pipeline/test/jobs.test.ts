import { strict as assert } from "node:assert";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { drain, enqueue, type QueuedEncoder } from "../src/jobs.ts";
import { loadPipelineConfig } from "../src/pipeline-config.ts";
import { embedItems, openRecorderForTest, recordTurn } from "../src/record.ts";

const local: QueuedEncoder = { id: "hash-ngram", version: "1", kind: "dense", dim: 512, backend: "local" };
const sparse: QueuedEncoder = { id: "bm25", version: "1", kind: "sparse", max_terms: 512, backend: "local" };
const remote: QueuedEncoder = { id: "fake-remote", version: "1", kind: "dense", dim: 3, backend: "http", api: "ollama", url: "http://fake", model: "m" };
const recipe = { id: "request-text", version: "1" };
const src = { record: "assignment" as const, id: "asg_test" };

test("enqueue is idempotent on the representation id", () => {
	const db = openDb(":memory:");
	const a = enqueue(db, [{ encoder: local, recipe, text: "fix the test", source: src }]);
	const b = enqueue(db, [{ encoder: local, recipe, text: "fix the test", source: src }]);
	assert.equal(a.queued, 1);
	assert.equal(b.queued, 0);
	assert.equal(b.already, 1);
});

test("drain writes the vector and closes the job", async () => {
	const db = openDb(":memory:");
	enqueue(db, [
		{ encoder: local, recipe, text: "fix the test", source: src },
		{ encoder: sparse, recipe, text: "fix the test", source: src },
	]);
	const out = await drain(db, [local, sparse]);
	assert.equal(out.done, 2);
	assert.equal(out.failed, 0);
	const reps = db.prepare("select encoder_id, dim from representations order by encoder_id").all() as { encoder_id: string; dim: number }[];
	assert.deepEqual(reps.map((r) => r.encoder_id), ["bm25", "hash-ngram"]);
	assert.equal(reps.find((r) => r.encoder_id === "hash-ngram")?.dim, 512);
	assert.equal(Number((db.prepare("select count(*) n from embed_jobs where status='pending'").get() as { n: number }).n), 0);
});

test("a remote encoder is used when the encoder says http", async () => {
	const db = openDb(":memory:");
	enqueue(db, [{ encoder: remote, recipe, text: "hello", source: src }]);
	const calls: string[] = [];
	const fakeFetch = (async (url: string, init: { body: string }) => {
		calls.push(String(url));
		const body = JSON.parse(init.body) as { input: string | string[] };
		const inputs = Array.isArray(body.input) ? body.input : [body.input];
		assert.deepEqual(inputs, ["hello"]);
		return { ok: true, status: 200, json: async () => ({ embeddings: [[3, 4, 0]] }) } as unknown as Response;
	}) as unknown as typeof fetch;
	const out = await drain(db, [remote], { fetchImpl: fakeFetch });
	assert.equal(out.done, 1);
	assert.match(calls[0], /\/api\/embed$/);
	const row = db.prepare("select dim, vector from representations where encoder_id='fake-remote'").get() as { dim: number; vector: Uint8Array };
	assert.equal(row.dim, 3);
	const v = new Float32Array(new Uint8Array(row.vector).buffer);
	assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-5, "remote vector is normalised");
});

test("the worker batches texts into one request per encoder", async () => {
	const db = openDb(":memory:");
	enqueue(db, ["a", "b", "c"].map((text) => ({ encoder: remote, recipe, text, source: src })));
	let requests = 0;
	const fakeFetch = (async (_url: string, init: { body: string }) => {
		requests++;
		const body = JSON.parse(init.body) as { input: string[] };
		assert.deepEqual(body.input, ["a", "b", "c"]);
		return { ok: true, status: 200, json: async () => ({ embeddings: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }) } as unknown as Response;
	}) as unknown as typeof fetch;
	const out = await drain(db, [remote], { fetchImpl: fakeFetch, batch: 8 });
	assert.equal(requests, 1);
	assert.equal(out.done, 3);
});

test("a failed remote call leaves the job pending with its error", async () => {
	const db = openDb(":memory:");
	enqueue(db, [{ encoder: remote, recipe, text: "hello", source: src }]);
	const failing = (async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
	const out = await drain(db, [remote], { fetchImpl: failing });
	assert.equal(out.failed, 1);
	const job = db.prepare("select status, attempts, error from embed_jobs").get() as { status: string; attempts: number; error: string };
	assert.equal(job.status, "pending");
	assert.equal(Number(job.attempts), 1);
	assert.match(job.error, /503/);
});

test("a live turn is recorded with paired assessments and disagreement, and its encodings queued", () => {
	const { db } = openRecorderForTest(new URL("../config.json", import.meta.url).pathname);
	const card = { project: "zellijiance", user_message: "fix the broker", signals: { user_turn_index: 0 } };
	const t0 = performance.now();
	const r = recordTurn({
		session: "s-live",
		entryId: "e1",
		request: "fix the broker",
		card,
		project: "zellijiance",
		model: "anthropic/claude-sonnet-5-5",
		thinking: "medium",
		tier: "general",
		basis: "judgement",
		rule: "initial:judgement",
		reasons: ["depth:2", "width:1", "urgency:3", "status:complete", "disagreement"],
		disagreement: true,
		assessments: [
			{
				backend: "openrouter-mammoth",
				model: "baseten/mammoth-1:free",
				contract: "live-v2-axes",
				contractHash: "abc123",
				attempt: 1,
				ms: 85,
				ok: true,
				answers: { depth: { choice: "1" }, width: { choice: "1" }, urgency: { choice: "3" } },
			},
			{
				backend: "openrouter-jev",
				model: "typesafe/jev-1.14",
				contract: "live-v2-axes",
				contractHash: "abc123",
				attempt: 2,
				ms: 90,
				ok: true,
				answers: { depth: { choice: "2" }, width: { choice: "1" }, urgency: { choice: "3" } },
			},
		],
		contractHash: "abc123",
		decisionMs: 95,
		routerConfigVersion: "v2-2026-10-28",
	});
	const ms = performance.now() - t0;
	assert.ok(ms < 50, `recording should be an insert, took ${ms.toFixed(1)}ms`);
	assert.equal(r.queued, 3, "dense local + sparse local + the enabled remote dense encoder, same request recipe");
	const dec = db.prepare("select count(*) n, disagreement from decisions where basis='judgement'").get() as { n: number; disagreement: number };
	assert.equal(Number(dec.n), 1);
	assert.equal(Number(dec.disagreement), 1);
	assert.equal(Number((db.prepare("select count(*) n from assessments").get() as { n: number }).n), 2);
	assert.equal(Number((db.prepare("select count(*) n from observations where kind='environment'").get() as { n: number }).n), 1);
});

test("the enabled encoder list is what gets queued", () => {
	const cfg = loadPipelineConfig(new URL("../config.json", import.meta.url).pathname);
	const items = embedItems(cfg, "hello", "asg_x", null);
	const ids = [...new Set(items.map((i) => i.encoder.id))].sort();
	assert.deepEqual(ids, ["bm25", "hash-ngram", "qwen3-embedding-0.6b"]);
});
