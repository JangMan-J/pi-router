# router/auto

A pi virtual model (`session@v2`, `src/router.ts`) that selects a model on the initial prompt from a paired 3-axis decider review (`depth`, `width`, `urgency`), matches it against configurable profiles in `config.json` (with optional `.anchor/router-stub.md` tag routing), and keeps that model across normal continuations—re-evaluating only when the local two-stage pivot cascade (`src/pivot.ts`) confirms a task pivot or hard instability.

See [`../pipeline_guide.md`](../pipeline_guide.md) for the full architecture, configuration surfaces, record store (`~/.local/share/route-pipeline/pipeline.db`), and operational commands.

## Select it

```
/model router/auto            # in pi
pi --model router/auto:high   # from the shell
```

| Level | Meaning |
|---|---|
| `low` | Cost saver: the tier is capped at `general` |
| `medium` | Default |
| `high` | Quality: the tier is floored at `general` |

## Behaviour

| Situation | Route |
|---|---|
| First user turn of a session | Paired concurrent 3-axis decider pass (`baseten/mammoth-1:free` and `perplexity/pplx-decider-v1.2` via OpenRouter, with `typesafe/jev-1.14` and `inception/mercury-decide` as fallbacks) over the initial card (`contracts/live-v2-axes.json`: `depth`, `width`, `urgency`), reconciled conservatively (`max` on `depth`/`width`, `min` on `urgency`), matched against the configurable `profiles` in `config.json` (`quick`, `local_work`, `wide_work`, `diagnosis_scoping`, `diagnosis_exec`, `deep_focus`, `deep_system`), clamped by thinking level, first available model in the profile's `models` list (or optional `tag-mappings.json` preference when `<cwd>/.anchor/router-stub.md` declares a `tag:`) |
| Later user turns (normal continuation) | Fast local Stage 1 gate (`Qwen3-Embedding-0.6B` on `127.0.0.1:8081` + telemetry signals) confirms continuation against `goal_anchor` + `.anchor/router-stub.md` and keeps the stored model with no decider call |
| Later user turns (ambiguous drift / instability / pivot) | Stage 2 cross-encoder (`Qwen3-Reranker-0.6B` on `127.0.0.1:8082`) verifies borderline drift or soft instability; only confirmed pivots (or hard telemetry error thresholds / trivial-opener promotion) re-run the paired 3-axis decider pass (`action: pivot`) |
| Retry after overload / rate limit / 5xx / timeout / auth | Another provider in the same profile/tier; session choice otherwise unchanged |
| Tool continuation / direct request | Previous model, else stored model, else declared fallback profile/tier |
| Model already running when `router/auto` is selected | Adopted unchanged, no decider call (`basis: explicit`) |

## Project Stubs (`.anchor/router-stub.md`)

An optional `<cwd>/.anchor/router-stub.md` file in any workspace serves two roles:
1. **Goal anchoring:** Combined with `goal_anchor` (`${goal_anchor}\n\n---\n${project_stub}`) for Stage 1/Stage 2 pivot detection and versioned in `context_items` (`kind='project_summary'`) for the `contextual` embedding recipe.
2. **Optional `tag:` routing:** If the stub includes a `tag: <openrouter_task_type>` line (in YAML frontmatter or header lines, e.g. `tag: code:frontend_ui`), the router still runs the 3-axis decider pass to pick the profile and thinking level, then prefers the first available model for `(tag, tier)` from `tag-mappings.json` (synced daily from `auto-router-probe` via `scripts/sync-probe-mappings.ts`), falling back to `profile.models` if omitted or unavailable.

## Turn it off

- **For a session:** select another model with `/model`.
- **To unload it:** remove `"../../Projects/pi-router/router"` from `packages` in `~/.pi/agent/settings.json`.

## Development

```sh
npm run typecheck                             # tsc against the pi checkout
npm test                                      # parity, decider client, pivot cascade, and session router tests
npm run fixtures                              # regenerate test/fixtures/parity.jsonl after state.ts changes
node scripts/sync-probe-mappings.ts [dir]     # sync tag-mappings.json from auto-router-probe
node scripts/smoke.ts [session]               # live: ask every configured backend about a real turn
```
