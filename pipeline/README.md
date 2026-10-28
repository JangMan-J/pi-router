# route-pipeline

A working routing pipeline, not another dataset. It admits an assignment, records the exact input,
asks the decision model, applies the existing `router/auto` policy, records the choice, then stores
request / project-summary / contextualised representations under stable ids so any later router can
be calibrated against the same records.

Measured on this host today, 343 real cards from `bench/data/live-bench-v1.jsonl`, decider `jev`
on `api.typesafe.ai`:

| | p50 | p95 | max |
|---|---:|---:|---:|
| decide (one decider call + policy + record) | **78 ms** | 170 ms | 236 ms |
| embed (2 encoders × 1–3 recipes, cached) | 0.8 ms | — | 1.3 ms |

343 cards took ~32 s wall, 0 decider failures. Embedding never gates the decision. Re-routing the same
343 cards encodes nothing (686/686 cache hits) and writes one decision per assignment, not two.

## Run it

```sh
node src/cli.ts route --cards ../bench/data/live-bench-v1.jsonl --limit 400   # routes, records, embeds
node src/cli.ts ingest                                                        # attach saved pi outcomes by id
node src/cli.ts calibrate                                                    # join choices to outcomes
node src/cli.ts consult --text "the broker keeps exiting on start" --k 4      # dense + sparse, kept separate
node src/cli.ts verify                                                       # ids, links, dims
node --test test/*.test.ts                                                   # 24 tests
```

Store: `~/.local/share/route-pipeline/pipeline.db` (SQLite, WAL, dir 0700, file 0600, umask 077 in the CLI). It holds session text, so
it lives outside the repo and outside the bench data.

## What the diagram became

| diagram box | here |
|---|---|
| save exact request, `assignment: alpha` | `assignments.request_text`, `assignments.request_sha256`, `assignment_id` = hash of the admission event |
| reference exact project-summary revision | `context_items` (`kind='project_summary'`, monotonic `revision`, content-addressed `item_id`) |
| request / project-summary / contextualised embedding jobs | `recipes` in `config.json`; a recipe names how text is built and no recipe calls a model |
| build cache key: input hash + encoder version + recipe version | `representation_id` = `emb_` + sha256(encoder, version, recipe, version, input bytes). The id **is** the key |
| matching embedding exists? reuse / call remote | `represent()`: one `select` by id, else encode and insert; unique constraint prevents a double write |
| save vector and provenance | `representations` (encoder, version, recipe, version, input_sha256, dim, vector) |
| link source records to embedding | `representation_links` (assignment or snapshot) |
| three retrieval indexes | `consult --index request|project|contextual`, reading the same table by `recipe_id` |

## Stable ids

Nothing here reads a clock or a counter. Two machines, two languages, two future routers compute the
same id for the same record. Full table in `src/ids.ts`.

| record | id |
|---|---|
| assignment | `asg_` + sha256(`turn:<origin>|<session>|<entry_id>`) |
| project | `prj_` + sha256(`project:<key>`) |
| snapshot (exact model input) | `snp_` + sha256(`recipe@version`, canonical bytes) |
| assessment | `asm_` + sha256(snapshot, role, backend, contract hash, attempt) |
| decision | `dec_` + sha256(assignment, snapshot, policy id+version, canonical answers) |
| representation | `emb_` + sha256(`encoder@version`, `recipe@version`, input bytes) |
| observation | `obs_` + sha256(assignment, kind, source, at, canonical value) |
| retrieval | `ret_` + sha256(query, index, method) |

The assignment id is the join key between new traffic and the 6,633 saved pi turns, because both
carry host/session/entry_id. That is what makes calibration possible without re-running history.

## Schema (v2)

```
projects, context_items
assignments      -- request bytes, origin, project, parent
snapshots        -- exact decider input, recipe, sha256
assessments      -- one row per decider call: ms, status, compact + raw answers
decisions        -- policy output: action, model, tier, thinking, reasons, disagreement, basis, ms
observations     -- kind='outcome' | 'actual_dispatch' | 'environment' | anything later; source + method kept
representations  -- encoder, version, recipe, version, input_sha256, dim, vector
representation_links
embed_jobs       -- durable encode queue for uncached representations
retrievals       -- query, index, method, returned ids, ms
pipeline_meta    -- schema_version
```

A different implementation calibrates by writing `observations` against an existing
`assignment_id`; nothing else is required. The two joins, in plain SQL:

```sql
-- what the router chose, and what happened next
select d.model, d.action, o.value_json
from decisions d join observations o
  on o.assignment_id = d.assignment_id and o.kind = 'outcome';

-- what actually ran, and what happened next
select a.value_json, o.value_json
from observations o join observations a
  on a.assignment_id = o.assignment_id and a.kind = 'actual_dispatch'
where o.kind = 'outcome';
```

## Policy: `session@v2` — one selection per session

The router evaluates nothing per turn. The first user turn of a session gets one selection, made on
that turn's prompt and the context it carries; every later turn keeps it. Two implementations of the
same rule exist because the runtimes differ: `pipeline/src/decide.ts` reads and writes the record
store, `router/src/router.ts` uses pi's per-session branch state.

`initial_mode` decides what the one selection may rest on, and every row records which was used:

| `basis` | input |
|---|---|
| `explicit` | a model the user or caller named |
| `judgement` | paired concurrent 3-axis decider pass (`baseten/mammoth-1:free` and `typesafe/jev-1.14` via OpenRouter) over the initial card (`depth`, `width`, `urgency`), reconciled conservatively (`max` on `depth`/`width`, `min` on `urgency`), matched against the configurable `profiles` in `router/config.json`, and recorded with contract hash, both assessments, `profile:<id>`, and `disagreement` |
| `declared` | the configured `fallback_profile` (`local_work`) / default tier, when no decider is configured, calls fail, or reconciled `depth` is `unknown` |

Measured on 343 cards from 214 sessions:

| | session@v1 |
|---|---:|
| selections (decider calls) | **214** |
| turns kept with no call | **129** |
| decision p50 / p95 | 70 ms / 110 ms |
| wall for 343 cards | 18.5 s |
| basis | judgement 214, session_keep 129 |

## Configured state (2026-10-28, paired OpenRouter deciders)

| role | model | where | state |
|---|---|---|---|
| decider 1 (primary) | `baseten/mammoth-1:free` (`openrouter-mammoth`) via OpenRouter | remote | **enabled** (~370 ms avg) |
| decider 2 (primary) | `perplexity/pplx-decider-v1.2` (`openrouter-pplx-decider`) via OpenRouter | remote | **enabled** (~257 ms p50) |
| decider 3 (fallback #1) | `typesafe/jev-1.14` (`openrouter-jev`) via OpenRouter | remote | **enabled** (~164 ms p50) |
| decider 4 (fallback #2) | `inception/mercury-decide` (`openrouter-mercury`) via OpenRouter | remote | **enabled** |
| dense, primary + Stage 1 pivot gate | `qwen3-embedding-0.6b` Q8 | decent-spider `127.0.0.1:8081` | **enabled** (`llama-embed.service`) |
| cross-encoder, Stage 2 pivot verifier | `qwen3-reranker-0.6b` Q8 | decent-spider `127.0.0.1:8082` | **enabled** (`llama-rerank.service`) |
| dense, baseline | `hash-ngram@1` | in process | **enabled** (0.3 ms, no infrastructure) |
| sparse | `bm25@1` | in process | **enabled** |

Two dense encoders are on for one reason: availability, not signal. `qwen3` is the semantic encoder
`consult` uses by default; `hash-ngram` is the zero-infrastructure baseline that keeps working when the
laptop sleeps, and it is what parity tests compare against. They never mix — the encoder id is inside
every representation id, and `consult` scores only within one encoder.

Both serving endpoints are systemd units on agent-jail (`llama-decision.service` :8090,
`llama-embed.service` :8081), enabled at boot, bound to the tailnet address only. The queue is drained
by `route-pipeline-embed.timer` on decent-spider every minute (`~/.config/systemd/user/`, linger is on):

```sh
systemctl --user list-timers route-pipeline-embed.timer
journalctl --user -u route-pipeline-embed.service -n 20
```

Two bugs were found while switching this on, both fixed and tested:

- `consult` encoded the query with the local feature-hashing function no matter which encoder produced
  the stored vectors, so semantic scores were noise (~0.03). The query now goes through the same
  backend as the index (HTTP when the encoder is HTTP), and `consult` reports which encoder scored.
- Disabled encoders were still being enqueued by the CLI path, filling the queue with jobs no worker
  would accept. `enqueue` now skips `enabled: false` in every path.

## The live path

`router/auto` now records every live turn. On the session's first turn it writes the assignment, the
exact card, the decider assessment (with contract hash and answers), the decision with its `basis`,
and an environment fingerprint. Every later turn writes the same again with
`basis: session_keep` and no assessment, because nothing was asked.

Encoding is never performed during the turn. Each uncached representation is a row in `embed_jobs`
(the representation id is the primary key, so a duplicate cannot queue twice), and a worker drains
the queue:

```sh
node src/cli.ts embed --limit 200          # drain once
node src/cli.ts embed                       # pending count is printed either way
```

Measured on a simulated live turn: first record 5.0 ms (opens the store), later turns 0.6 ms, two jobs
queued per turn, four jobs drained in ~1 ms. The queue is a table, not memory, so a crash or a restart
loses nothing.

### Local or remote encoder

Each entry in `config.json` → `encoders` declares its backend:

```json
{ "id": "hash-ngram", "version": "1", "kind": "dense", "dim": 512, "backend": "local" }
{ "id": "qwen3-embedding-0.6b", "version": "1", "kind": "dense", "dim": 1024, "backend": "http",
  "api": "openai", "url": "http://127.0.0.1:8081",
  "model": "qwen3-embedding-0.6b", "enabled": true }
```

Both local serving endpoints on decent-spider are systemd user units bound to loopback (`127.0.0.1`):

| unit | port | serves |
|---|---:|---|
| `llama-embed.service` | 8081 | `Qwen3-Embedding-0.6B` Q8, `/v1/embeddings` |
| `llama-rerank.service` | 8082 | `Qwen3-Reranker-0.6B` Q8, `/v1/rerank` |

Both need `-b 4096 -ub 4096` (decision) or `-b 2048 -ub 2048` (embed): llama-server's default physical batch
of 512 rejects a 2.4k-token card with `input is too large to process`, which is what kept the endpoint
returning 500 after the restart. The worker batches up to 8 texts per request for HTTP encoders:
266 ms per vector when drained singly, **52 ms per vector at batch 8**.

Flip `enabled` to switch. Three HTTP shapes are supported (`api`: `ollama`, `tei`, `openai`). Because
the encoder id and version are inside `representation_id`, local and remote vectors coexist under
different ids and `consult` never compares across them; switching back leaves the old vectors
readable. A configured-but-disabled encoder is skipped by the queue.

The worker does not need to be fast or always up: jobs wait. For a timer, run
`scripts/embed-worker.sh` from a systemd user unit (`OnUnitActiveSec=1min`).

## Day 0

`config.json` carries `epoch: 2026-10-27T00:00:00Z`. It is the boundary between two kinds of record:

- **post-epoch**: a decision made here, an environment fingerprint beside it, and an outcome observed
  after it. This is the only population that can say anything about a routing choice.
- **pre-history**: transcripts from before the pipeline existed. Kept, joinable, and excluded from
  `calibrate` unless `--prehistory` is passed.

Every post-epoch assignment gets one `observations` row of `kind='environment'`: node version,
platform, host, pipeline config version + sha256, router config version + sha256, the contract
hash (`contracts/live-v2-axes.json`), encoder ids, decider endpoint hosts, schema version. That is the record the old transcripts
lack, and its absence is why the old tags cannot be evidence: `gpt-6-astra` in October and
`gpt-6-astra` in November may be different weights, a different endpoint, or a different harness, and
nothing in the old row was ever going to show it.

Tags are not produced by a model in this pipeline. The only outcome it computes itself is the
**hard outcome**, from session structure: aborted (unless an interrupt was followed by a message
within 1 s, which is steering), error stop, switched away, repeated tool error ≥ 3, abandoned branch.
That is reproducible from the transcript with no judgement, and `calibrate --hard` scores with it.

## Calibration, honestly

`calibrate` separates two populations, because they mean different things:

- **agree** — the router's choice equals the model that actually ran. The outcome is evidence about
  that choice.
- **off-policy** — it differs. The observed bad rate belongs to the model that really ran, not to the
  router. 233 of the 343 routed turns are in this group today. No counterfactual outcome exists for
  them, so no amount of joining will produce one.

Current numbers on the 343 routed turns (95% Wilson):

| chosen model | agree n | bad |
|---|---:|---:|
| anthropic/claude-opus-5-5 | 36 | 6% (2–18%) |
| openai-codex/gpt-6-astra | 23 | 17% (7–37%) |
| meta/muse-wonder-full-1.0-contributor | 13 | 54% (29–77%) |
| xai/grok-4.7-build-fast | 9 | 0% (0–30%) |
| openai-codex/gpt-6.1-sol | 5 | 40% (12–77%) |

The imported labels stay what they are: one decision model's reading of the next turn, recorded by
`outcomes/labels.py`. They are annotations with a method, not truth, and `calibrate` prints the
source beside them. The two scorings do not agree, which is the reason not to trust the annotation:
`claude-fable-5-1` reads 11% bad by the imported label and **21%** by structure; `gemini-3.8-flash`
16% and **22%**; `muse-wonder-full-1.0-contributor` 20% and **16%**; `claude-sonnet-5-5` 3% and 4%.
A rank order that moves with the scoring method is not a rank order.

## The encoders

- `hash-ngram@1` — dense, 512 dims, signed feature hashing over unigrams, bigrams and character
  4-grams, L2-normalised. Deterministic, offline, ~0.3 ms per 1k chars, lexical rather than semantic.
  It exists so the plumbing is exercised by a real encoder today.
- `bm25@1` — sparse term-frequency map, scored with k1=1.2, b=0.75. Not a model call; recorded as its
  own method.

Swapping in a trained encoder means adding an id like `bge-small-en-v15@1` or `qwen3-embedding-0.6b@1`
with the same interface. Old vectors are never compared with new ones: the encoder id and version are
inside the cache key and inside `representation_id`, so the two live side by side and `consult` can be
run over either.

Dense and sparse results are returned side by side. There is no fused score and no RRF, because a
fused number hides which retriever produced a hit. A fusion method, if wanted, is an explicit new
`method` string on `retrievals`.

## Wiring it into pi (not enabled)

The pipeline is a library plus a CLI. The adapter for the virtual model is three lines, kept out of
`router/index.ts` so it cannot change routing by accident:

```ts
import { loadPipelineConfig, loadRouterConfig, loadContracts, loadCatalogue, makeAvailable, realAsk, routeCard } from "../pipeline/src/route.ts";
const cfg = loadPipelineConfig(); const rc = loadRouterConfig(cfg); const c = loadContracts(cfg);
const r = await routeCard({ host: "pi", session: ctx.sessionManager.getSessionId(), entry_id: null, state: card },
  { db, cfg, routerConfig: rc, contracts: c, ask: realAsk(cfg, rc, c), available: makeAvailable(rc, loadCatalogue(cfg.catalogue)), embed: true });
return { model: r.model, thinkingLevel: r.thinking };
```

The existing `router/auto` extension already routes; this pipeline records what it decided and makes
the choice calibratable. Enabling the adapter is a separate, reversible decision.

## Not done

- No fusion, no clustering, no learned sparse encoder, no cross-encoder rerank.
- No counterfactual outcomes. Off-policy turns stay off-policy until the router's own traffic
  accumulates agree turns.
- Project summaries are accepted, not generated. Nothing writes them for existing projects.
