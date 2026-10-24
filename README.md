# router/auto

A pi virtual model that picks the physical model for each request. It keeps the model that is already working, because a switch drops the prompt cache: the cache-read share is 0.99 when the model stays and 0.00 right after a switch, at a median prompt of 76.5k tokens. It switches only when the agent is at fault or the session's goal changes.

## Select it

```
/model router/auto            # in pi
pi --model router/auto:high   # from the shell
```

The thinking level you select tells the router how to trade cost against quality:

| Level | Meaning |
|---|---|
| `low` | Cost saver: the tier is capped at general |
| `medium` | Default |
| `high` | Quality: the tier is at least general, and new goals are picked one tier higher |

Each tier entry in `config.json` sets the physical thinking level, for example `anthropic/claude-opus-5-5:high`. When the router switches models, pi shows a notice like `router/auto → openai-codex/gpt-6.1-sol:high (agent_fault, user_rejection, …)`.

## What it does

How each request is routed depends on why pi is making it:

| Request | Route |
|---|---|
| Tool continuation | The model that gave the last response |
| Retry | The model that failed. If its error shows overload, a rate limit or a 5xx, another model in the same tier instead, preferably from another provider |
| Request outside the agent loop (e.g. a compaction summary) | The model that gave the last response, else the first available basic-tier model |
| User turn | The policy below |

### Policy for user turns

1. **First turn of a session.** The router asks the goal questions: `task`, `difficulty` and `spec_clear`.
   - If a lane matches, its model is used.
   - Otherwise the tier comes from difficulty: under 1.0 is basic, under 2.5 is general, anything else is deep.
   - Within a tier, models are tried in config order and skipped if they have no credentials.

   If you select router/auto partway through a session, it keeps the current model on that turn and asks nothing.
2. **Later turns.** The router asks the history questions: `new_goal`, `user_rejection` and `false_success`.
   - **Agent fault** means one of: `user_rejection ≥ θ`, `false_success ≥ θ`, or the same tool error 3 or more times in the last 10 results. The router moves up one tier. At deep, it moves to the next deep model from a different family.
   - **Agent fault and a new goal:** the router also asks the goal questions. It takes the higher of the escalated tier and the re-picked tier; a matching lane takes precedence.
   - **New goal only:** the router asks the goal questions and re-picks. It keeps the current model if the new tier is the current tier and no lane matches.
   - **Otherwise** it keeps the current model.
3. **Checks on every kept model:**
   - If a never-rule applies (muse on a review or debugging task, or on a rejection or false-success turn), the router moves to the general tier. Muse needs a clear spec only for orchestration (that lane requires `spec_clear ≥ 0.8`), not for creative prose.
   - Excluded models (claude-fable-5-1) and probation models (gemini-4-argon) are never kept or chosen.
   - A kept model is also moved if it is outside the tier bounds for the selected level.
4. **Switch targets.** The current model is never chosen as a switch target. A model without credentials is skipped.
5. **Prior.** If `~/.local/share/route-prior/prior.json` has entries, the router picks within a tier by the posterior mean. It uses the task cell if that cell has at least 10 outcomes, and otherwise the model's overall entry. With probability ε = 0.1 it picks a model in the tier uniformly at random instead, and logs the propensity.

### Decision models

The goal and history questions go to System One endpoints (`contracts/`). The router calls them with `fetch`, using the same card and body format that the bench measured (`src/state.ts` is a byte-exact port of `bench/sample_states.py`).

- **Arms.** Each session is assigned an arm by weight: `local` (agent-jail:8090) or `jev` (TypeSafe `jev-latest`). The session's arm is tried first and the other backend is the fallback.
- **Failures.** A backend gets one try. A failure opens a 5-minute breaker for that backend.
- **All backends down.** The router keeps the current model, or escalates on repeated tool errors. A first turn gets the general tier.

## Config (`config.json`)

| Key | What it sets |
|---|---|
| `tiers` | Models per tier, in preference order (`provider/id:thinking`) |
| `tier_from_difficulty` | Difficulty cut-offs between basic, general and deep |
| `lanes` | Models chosen directly when the goal answers match. `when` takes a task list and comparisons such as `">=0.7"` |
| `never` | Models barred when any condition holds. `">=theta"` means the backend's threshold |
| `probation`, `excluded` | Models the router never selects (in v1) |
| `thresholds` | θ per backend for `new_goal`, `user_rejection` and `false_success`, with how each was derived |
| `repeated_error_threshold` | How many identical tool errors count as agent fault (default 3) |
| `backends` | URL, model, `timeout_ms` and auth for each backend |
| `arms` | A/B weights |
| `breaker_ms` | How long a failed backend is skipped |
| `prior` | Path, ε and minimum outcomes per cell |
| `contracts` | Question files |
| `log_path` | Where the decision log goes |
| `fallback_tier`, `unknown_model_tier` | Tier for a first turn without answers, and for a model not listed in any tier |

`ROUTER_AUTO_CONFIG=/path/config.json` uses a different config file. Run `/reload` in pi after editing.

### Thresholds

`new_goal` and `user_rejection` are quantile-matched to Opus's labels on the 60 pilot turns: the backend fires on as many of the 53 turns with history as Opus said yes to. `false_success` has no gold labels, so both backends are set to fire on the same base rate, 4% of the 1,125 states-v1 history turns. Rerun with `npm run thresholds`.

| Backend | Results used | `new_goal` | `user_rejection` | `false_success` |
|---|---|---|---|---|
| jev | `bench/results/v3/` (v2 for `false_success`) | 0.655 (fires on 9; Opus 10; AUC 0.89) | 0.30 (14 / 14; AUC 0.86) | 0.715 (4.0%; 0.5 fired on 12.1%) |
| local | `bench/results/v2/startlux-4b-q8-jail.jsonl` | 0.657 (10 / 10; AUC 0.84) | 0.359 (14 / 14; AUC 0.90) | 0.47 (4.0%; 0.5 fired on 3.7%) |

- The live `new_goal` question asks about the session's goal, which is narrower than the v2/v3 wording these numbers were measured on. Expect it to fire less often than the table shows.
- Re-derive the `local` thresholds if the local model changes.

## Decision log

`~/.local/state/router-auto/decisions.jsonl` gets one line per user turn and one per retry that switches models. It holds no message text. Each line records:

- time, session id and entry id
- arm and its propensity, and the backend actually used for each question set
- decider latency, errors and HTTP status
- the answers, as probabilities only
- the card's signals
- the previous model, the chosen model with its thinking level, tier and lane
- action and reason codes, propensity and whether it was an exploration pick
- prior version, state hash, and config and contract hashes

## Turn it off

- **For a session:** select another model with `/model`.
- **To unload it:** remove `"../../Projects/model-routing/router"` from `packages` in `~/.pi/agent/settings.json`, or disable it in `pi config`. The settings from before the install are in `~/.pi/agent/settings.json.bak-router-auto-20261024-041132`.

## Development

```
npm run fixtures     # write test/fixtures/parity.jsonl (gitignored; real session turns)
npm test             # parity, policy, decider client, prior and route tests (node --test)
npm run typecheck    # tsc against the pi checkout in ~/pi (PI_SRC=… for another)
npm run thresholds   # re-derive the θ table from bench results
node scripts/smoke.ts [session.jsonl]   # live: ask every backend about a real turn
```

The parity test needs the fixtures: run `npm run fixtures` once before `npm test`.
