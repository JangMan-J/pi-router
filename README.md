# @jangmanj/pi-router

Session-level 3-axis model router (`router/auto`) with local two-stage pivot detection and a content-addressed SQLite calibration/retrieval pipeline for Pi.

- **[`router/`](./router/README.md)** — Pi virtual model (`router/auto`, `session@v2`):
  - **Initial selection:** Paired concurrent 3-axis decider review (`depth`, `width`, `urgency` via `baseten/mammoth-1:free` and `perplexity/pplx-decider-v1.2` on OpenRouter, with `typesafe/jev-1.14` and `inception/mercury-decide` as automatic fallbacks), reconciled conservatively (`max` on `depth`/`width`, `min` on `urgency`), matched against configurable `profiles` in [`router/config.json`](./router/config.json) (`quick`, `local_work`, `wide_work`, `diagnosis_scoping`, `diagnosis_exec`, `deep_focus`, `deep_system`).
  - **Continuation & two-stage pivot cascade ([`router/src/pivot.ts`](./router/src/pivot.ts)):** Stage 1 combines deterministic telemetry trouble thresholds with local bi-encoder cosine similarity (`Qwen3-Embedding-0.6B` on `127.0.0.1:8081`) against `goal_anchor` + optional `<cwd>/.anchor/router-stub.md`. Ambiguous semantic drift or soft instability wakes Stage 2 (`Qwen3-Reranker-0.6B` on `127.0.0.1:8082`). Only confirmed pivots re-run the paired 3-axis decider pass.
  - **Optional `tag:` routing:** If `<cwd>/.anchor/router-stub.md` specifies an optional `tag: <openrouter_task_type>`, the router prefers the first available model for `(tag, tier)` from [`router/tag-mappings.json`](./router/tag-mappings.json) (synced daily from `auto-router-probe`).
- **[`pipeline/`](./pipeline/README.md)** — Stable-ID routing record store (`~/.local/share/route-pipeline/pipeline.db`), background embedding queue (`hash-ngram`, `bm25`, `qwen3-embedding-0.6b` across `request-text`, `project-summary`, and `contextual` recipes), retrieval (`consult`), and outcome calibration (`calibrate`).
- **[`pipeline_guide.md`](./pipeline_guide.md)** — Full operational guide, configuration surfaces, and systemd units.

## Install

```sh
pi install npm:@jangmanj/pi-router
```

Select in Pi:

```
/model router/auto            # in pi
pi --model router/auto:high   # from the shell
```

## Development

```sh
npm run check        # type checker and tests (router + pipeline)
npm run smoke:pack   # pack, install the tarball, and load router/auto in Pi
```

## Release

```sh
npm version patch        # or minor / major
git push --follow-tags   # triggers .github/workflows/publish.yml (OIDC trusted publishing + provenance)
```

## License

MIT. See [`LICENSE`](./LICENSE).
