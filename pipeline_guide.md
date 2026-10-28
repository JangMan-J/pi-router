# pipeline_guide.md

How the routing pipeline is put together, where to change each thing, and what to run afterwards.
Written 2026-10-27, the day it went live. Paths are relative to `~/Projects/pi-router` unless absolute.

Two entry points share one routing policy and one store:

| path | what decides | where the code lives |
|---|---|---|
| **live** — pi selects `router/auto` | initial 3-axis selection + local two-stage pivot cascade | `router/` (pi extension, `router/src/router.ts`, `router/src/pivot.ts`) |
| **replay / tooling** — the CLI | same initial rule over saved cards | `pipeline/` (store, queue, calibration, `pipeline/src/decide.ts`) |

Both write the same tables in `~/.local/share/route-pipeline/pipeline.db` and both use the same contract
file, so an answer from today and an answer from a later router are comparable by id.

---

## 1. Where to modify model selection

Three surfaces. Almost every change belongs in the first one.

### 1.1 Which models can be selected — `router/config.json`

```json
"profiles": {
  "quick": {
    "tier": "basic",
    "when": { "depth": ["0"], "width": ["0", "1", "unknown"] },
    "models": ["antigravity/gemini-3.8-flash:low", "openai-codex/gpt-6-luna:low", "anthropic/claude-haiku-5-5:low"]
  },
  "local_work": {
    "tier": "general",
    "when": { "depth": ["1"], "width": ["0", "1", "unknown"] },
    "models": ["anthropic/claude-sonnet-5-5:medium", "openai-codex/gpt-6-astra:medium", "openai-codex/gpt-6.1-terra:medium"]
  },
  "wide_work": {
    "tier": "general",
    "when": { "depth": ["0", "1"], "width": ["2", "3"] },
    "models": ["openai-codex/gpt-6-astra:medium", "openai-codex/gpt-6.1-sol:medium", "anthropic/claude-sonnet-5-5:medium"]
  },
  "diagnosis_scoping": {
    "tier": "general",
    "when": { "depth": ["2"], "width": ["0", "1", "2", "unknown"], "urgency": ["0", "1", "unknown"] },
    "models": ["anthropic/claude-sonnet-5-5:high", "openai-codex/gpt-6-astra:high", "openai-codex/gpt-6.1-sol:medium"]
  },
  "diagnosis_exec": {
    "tier": "general",
    "when": { "depth": ["2"], "width": ["0", "1", "2", "unknown"], "urgency": ["2", "3"] },
    "models": ["openai-codex/gpt-6-astra:high", "anthropic/claude-sonnet-5-5:high", "openai-codex/gpt-6.1-sol:high", "xai/grok-4.7:high"]
  },
  "deep_focus": {
    "tier": "deep",
    "when": { "depth": ["3"], "width": ["0", "1", "2", "unknown"] },
    "models": ["anthropic/claude-opus-5-5:high", "openai-codex/gpt-6.1-sol:high", "openai-codex/gpt-6-astra:high"]
  },
  "deep_system": {
    "tier": "deep",
    "when": { "depth": ["2", "3"], "width": ["3"] },
    "models": ["openai-codex/gpt-6.1-sol:high", "openai-codex/gpt-6-astra:high", "anthropic/claude-opus-5-5:high"]
  }
},
"fallback_profile": "local_work",
"tiers": {
  "basic":   ["openai-codex/gpt-6-luna:low", "antigravity/gemini-3.8-flash:low", "anthropic/claude-haiku-5-5:low"],
  "general": ["anthropic/claude-sonnet-5-5:medium", "openai-codex/gpt-6-astra:medium", "openai-codex/gpt-6.1-terra:medium"],
  "deep":    ["anthropic/claude-opus-5-5:high", "openai-codex/gpt-6.1-sol:high", "openai-codex/gpt-6-astra:high"]
},
"fallback_tier": "general",
"unknown_model_tier": "general",
"tier_from_depth": { "0": "basic", "1": "general", "2": "general", "3": "deep", "unknown": "general" },
"excluded": [{ "model": "anthropic/claude-fable-5-1", "why": "own usage meter, never selected" }],
"backends": {
  "openrouter-mammoth":      { "model": "baseten/mammoth-1:free",       "family": "baseten",    "enabled": true },
  "openrouter-pplx-decider": { "model": "perplexity/pplx-decider-v1.2", "family": "perplexity", "enabled": true },
  "openrouter-jev":          { "model": "typesafe/jev-1.14",            "family": "typesafe",   "enabled": true },
  "openrouter-mercury":      { "model": "inception/mercury-decide",     "family": "inception",  "enabled": true }
}
```

- Entry format is `provider/id:thinking`. Order is preference order: first model in the matched profile's
  `models` list (or fallback tier) with credentials wins. Editing the `models` array of any profile in
  `router/config.json` changes which models belong to that profile with no code change.
- `profiles` maps the reconciled `(depth, width, urgency)` reading to a named profile with its `tier`
  and ordered `models` list. When `depth` is `"unknown"` or no decider answers, `fallback_profile`
  (`"local_work"`) is used.
- `tiers` provides the tier-level fallback lists (used by tier-clamped overrides and fallback when every
  model in a profile is unavailable).
- `excluded` is a hard skip. Use it for billing or policy facts, not taste.
- `backends` is the decider list. `enabled: false` skips a backend everywhere; `askPair` queries two
  enabled backends from distinct model families concurrently (`openrouter-mammoth` in family `baseten`
  and `openrouter-pplx-decider` in family `perplexity`), automatically falling back to `openrouter-jev`
  (`typesafe`) and `openrouter-mercury` (`inception`) if a primary backend fails or rate-limits.
- Tier names are fixed: `TIERS` in `router/src/config.ts:9`. A fourth tier is a code change.
- `config.ts` validates at load and throws on a malformed ref, an empty tier or profile, an unknown
  `fallback_profile`, an invalid `when` axis/level or `tier_from_depth` entry, or a backend without a url
  or timeout. A typo fails at the next pi start, not mid-turn.

### 1.2 What the deciders are asked — `router/contracts/live-v2-axes.json`

The selection card is the 3-axis initial review (`contract: "live-v2-axes"`):

| question | type | labels |
|---|---|---|
| `depth` | choice | 5 (`"0"`, `"1"`, `"2"`, `"3"`, `"unknown"`) — reasoning, investigation, resolution of uncertainty |
| `width` | choice | 5 (`"0"`, `"1"`, `"2"`, `"3"`, `"unknown"`) — breadth of actions, deliverables, coordination |
| `urgency` | choice | 5 (`"0"`, `"1"`, `"2"`, `"3"`, `"unknown"`) — specificity and action-readiness without guesswork |

- Paired readings are reconciled conservatively (`max(a, b)` on `depth` and `width`, `min(a, b)` on
  `urgency`), preserving both raw assessments and a `disagreement` flag when two known levels differ.
- The file's bytes are hashed (`router/src/deciders.ts:68`) and the hash is stored on every assessment
  row. Editing the wording changes the hash, so old answers never look like answers to the new wording.
- The pipeline reads the same file through `pipeline/config.json` → `questions.goal`, so edit it once.

### 1.3 What the decider sees — `router/src/state.ts`

`buildLiveState` (`state.ts:323`) assembles the card: `user_message`, `previous_user_message`,
`previous_assistant_reply`, `recent_tool_activity` (max 6), `recent_injected_messages`, `signals`
(user turn index, tool errors, repeated-error count, tests run/failed, successful edits). Redaction,
clipping and file stubbing happen here as well.

- Changing this changes the snapshot bytes, so every new decision gets a new `snapshot_id`.
- Keep `bench/sample_states.py` in step. Parity is enforced by `router/test/state.test.ts` against
  `test/fixtures/parity.jsonl`; regenerate with `npm run fixtures` after a change, then fix whichever
  side is wrong.
- Anything you add here costs decider tokens on every session's first turn and nothing later.

### 1.4 Pipeline-only knobs — `pipeline/config.json`

| key | meaning |
|---|---|
| `policy` | policy id (`session`) and version (`v2-2026-10-28`) recorded on every decision row |
| `initial_mode` | `classifier` (paired 3-axis decider pass) or `default` (declared tier, zero calls) |
| `deciders.order` | which distinct-family backends answer the paired pass (`["openrouter-mammoth", "openrouter-pplx-decider", "openrouter-jev", "openrouter-mercury"]`) |
| `recipes` | what text gets embedded: `request-text`, `project-summary`, `contextual` |
| `encoders` | one entry per encoder; `enabled: false` skips it in every path |
| `default_encoder` | the dense encoder `consult` scores with, with automatic fallback to one that has rows |
| `embed.max_chars` | clip applied to recipe text before encoding |
| `epoch` | day 0; observations before it are pre-history and excluded from calibration |

---

## 2. What the live router actually does

`router/src/router.ts` (`session@v2`), loaded by pi from `~/Projects/pi-router/router`
(`~/.pi/agent/settings.json` → `packages`).

| situation | behaviour |
|---|---|
| first user turn of a session | paired concurrent 3-axis decider pass (`openrouter-mammoth` + `openrouter-pplx-decider` via OpenRouter, with `openrouter-jev` + `openrouter-mercury` as fallbacks) over the initial card, reconciled conservatively (`max` on `depth`/`width`, `min` on `urgency`), matched against `config.profiles`, clamped by the selected thinking level, first available model in the profile's `models` list (or optional `tag-mappings.json` preference when `<cwd>/.anchor/router-stub.md` specifies `tag:`); writes `basis: judgement` (or `declared` via `fallback_profile` if no backend answered / `depth` is `unknown`) |
| later user turns (normal continuation) | Stage 1 local bi-encoder gate (`Qwen3-Embedding-0.6B` on `127.0.0.1:8081`) + telemetry check confirms continuation against `goal_anchor` + `.anchor/router-stub.md`; keeps the stored model with no decider call |
| later user turns (ambiguous drift / instability / pivot) | Stage 2 local cross-encoder (`Qwen3-Reranker-0.6B` on `127.0.0.1:8082`) verifies borderline semantic drift or soft instability; only confirmed pivots (or hard error thresholds / trivial-opener promotion) re-run the paired 3-axis decider pass (`action: pivot`) |
| retry after overload / rate limit / 5xx / timeout / auth | another provider in the same profile/tier; the session's choice is otherwise unchanged |
| continuation, direct request | the previous model, else the stored one, else the declared fallback profile/tier |
| a model is already running when `router/auto` is selected (user ran `/model`, or switched mid-session) | adopted unchanged, no decider call, recorded as `basis: explicit` |

Thinking level selected in pi (`router/auto:low|medium|high`) clamps the tier: `low` caps at general,
`high` floors at general.

---

## 3. Records: what gets written, and what "calibratable" means

Every live turn writes, into `~/.local/share/route-pipeline/pipeline.db` (dir 0700, file 0600):

| table | row per turn |
|---|---|
| `assignments` | the exact request, origin, session, entry, project |
| `snapshots` | the exact card sent to the decider, hashed (`card-state@1`) |
| `assessments` | one per decider call in the pair: backend, model, contract hash, attempt, ms, compact + raw answers |
| `decisions` | policy id/version, rule id, action, model, tier, thinking, reasons, `disagreement`, `basis`, ms |
| `observations` | `kind='environment'` fingerprint (node, host, config hashes, encoders, schema) |
| `embed_jobs` | one row per uncached representation; drained by a timer, never during the turn |

Ids are content-derived (`pipeline/src/ids.ts`): `asg_` from the admission event (`origin|session|entry`),
`snp_` from recipe + bytes, `dec_` from assignment + snapshot + policy + answers, `emb_` from encoder +
recipe + input bytes. Re-running the same input produces the same ids, so duplicates collapse.

`calibrate` counts only pairs where the **turn** is post-epoch:

- `agree` — the router's choice equals the model that actually ran; the outcome is evidence about the choice.
- `off-policy` — it differs; the observed result belongs to whatever ran. No counterfactual exists.

`--hard` scores with structure only (abort without a steering interjection, error stop, switch away,
repeated tool error ≥ 3, abandoned branch). That is the only outcome the pipeline computes itself; the
imported `good/bad` annotations stay annotations, with their source and method recorded.

---

## 4. Commands

### Pipeline

```sh
cd ~/Projects/pi-router/pipeline
node src/cli.ts route --cards ~/Projects/model-routing/bench/data/live-bench-v1.jsonl --limit 20  # replay cards
node src/cli.ts ingest                                                                            # attach saved pi outcomes by id
node src/cli.ts calibrate                                                                         # day-0 only
node src/cli.ts calibrate --prehistory --hard                                                     # the old turns, structural scoring only
node src/cli.ts consult --text "the broker keeps exiting" --k 5                                   # dense + sparse, kept separate
node src/cli.ts consult --encoder hash-ngram --text "..."                                         # force the offline baseline
node src/cli.ts embed --limit 200                                                                 # drain the encode queue
node src/cli.ts verify                                                                            # ids, links, dims, epoch boundary
node --test test/*.test.ts                                                                        # 24 tests
```

### Router

```sh
cd ~/Projects/pi-router/router
sh scripts/typecheck.sh
node --test test/*.test.ts                                                    # 76 tests
npm run fixtures                                                              # after state.ts changes
node scripts/sync-probe-mappings.ts                                           # sync tag-mappings.json from auto-router-probe
```

### Live services (all local on `decent-spider`)

| what | where | command |
|---|---|---|
| embedder (`Qwen3-Embedding-0.6B` Q8), `127.0.0.1:8081` | decent-spider, user unit | `systemctl --user status llama-embed.service` |
| reranker (`Qwen3-Reranker-0.6B` Q8), `127.0.0.1:8082` | decent-spider, user unit | `systemctl --user status llama-rerank.service` |
| encode-queue drainer (every 1m) | decent-spider, user timer | `systemctl --user list-timers route-pipeline-embed.timer` |
| daily OpenRouter auto-router probe + tag sync (`06:15 UTC`) | decent-spider, user timer | `systemctl --user list-timers auto-router-probe.timer` |

Both `llama-embed.service` and `llama-rerank.service` are `enabled` and `Restart=always`, bound to loopback (`127.0.0.1`) with `-t 12 -c 8192 -b 4096 -ub 4096`.

---

## 5. Adding or changing a model

1. Check the id is real: `pi --list-models | grep <name>`.
2. Put it in the right profile(s) under `profiles.<name>.models` (and/or `tiers`) in `router/config.json`, with its thinking level.
3. If it replaces a decider, edit `backends` (url, model, auth) and set `enabled`. Auth paths:
   `auth_json_provider` reads `~/.pi/agent/auth.json` (`key` for API keys, `access` for OAuth providers
   pi refreshes), `key_file` reads a file such as `~/.config/baseten/api_key`, `env` reads a variable.
4. `sh scripts/typecheck.sh && node --test test/*.test.ts`.
5. One real turn: `pi -p "reply with exactly: ok" --model router/auto:medium --no-tools`, then check
   `tail -1 ~/.local/state/router-auto/decisions.jsonl` for `basis`, `profile`, `chosen`, `decider_ms`, and
   `node src/cli.ts verify` for the new row.

Adding an **encoder**: add an entry to `pipeline/config.json` → `encoders` with `backend: local|http`,
`api: ollama|tei|openai`, url and model, then set `enabled: true`. Its vectors get a new
`emb_` id namespace; nothing mixes with existing vectors, and `consult` will use it only when named or
when it is `default_encoder` and has rows.

---

## 6. Gotchas worth remembering

- **llama-server's physical batch.** A 2.4k-token card fails with `input is too large to process` unless
  the server runs `-ub` ≥ the card size. The jail units use `-b 4096 -ub 4096` (decision) and
  `-b 2048 -ub 2048` (embed). A restart that forgets this returns 500 on every call.
- **The query encoder must match the index.** `consult` has to encode the query with the same backend
  that produced the stored vectors; hash-ngram and a transformer do not share a space. It now does, and
  reports `encoder=<id>@<version>`; a self-query scores 0.9998.
- **Disabled means disabled.** `enqueue` skips `enabled: false` in every path, and `drain` never picks
  up an encoder that is not configured. Likewise `Deciders` (`selectPair`, `ask`, `askPair`) and
  `scripts/smoke.ts` skip any backend with `enabled: false`.
- **Batch, don't loop.** HTTP encoders are drained up to 8 texts per request: 266 ms per vector singly,
  52 ms at batch 8. Batching is a `drain({ batch })` argument.
- **Day 0 is enforced, not implied.** `calibrate` needs the *turn* to be post-epoch. Replaying an October
  card today does not make it evidence.
- **Paired OpenRouter deciders and partial fallback.** `openrouter-mammoth` (`baseten/mammoth-1:free`) and
  `openrouter-jev` (`typesafe/jev-1.14`, $0.042/M input) are both enabled via OpenRouter. If one fails or
  rate-limits, the surviving reading still routes with `status: partial` (`basis: judgement`); if both fail,
  the router degrades to `basis: declared`. Direct Baseten backends (`baseten-mammoth`, `baseten-elephant`)
  stay `enabled: false` so post-free-window runs cannot bill Baseten.

---

## 7. Troubleshooting

| symptom | first check |
|---|---|
| pi turn fails or `router/auto` is missing | `pi --version`, `~/.pi/agent/settings.json` packages, `cd router && sh scripts/typecheck.sh` |
| log says `basis: declared` every session | decider unreachable or rate-limited: `curl -s -o /dev/null -w '%{http_code}\n' https://openrouter.ai/api/v1/systemone`, or `ssh agent-jail sudo journalctl -u llama-decision -n 30` |
| no new records for live turns | `PIPELINE_RECORDS` must not be `off`; check `~/.local/state/route-pipeline` is writable; `node src/cli.ts verify` |
| queue keeps growing | `systemctl --user status route-pipeline-embed.service`; `journalctl --user -u route-pipeline-embed -n 30`; encoder url and `enabled` |
| embed 500s | batch size on the server (see gotchas), or the model name in the request does not match the served `--alias` |
| `consult` returns near-zero scores | wrong encoder or an encoder with no rows; the output line names the encoder used |
| calibration shows 0 rows | expected until post-epoch turns exist; `--prehistory` shows the old population |
