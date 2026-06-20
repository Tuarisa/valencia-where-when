# Archived specs — superseded by `001-valencia-radar`

These seven folders were **ralph-specum** specs that never advanced past the
`research` phase (each had only `research.md` + `.ralph-state.json`, all
`awaiting approval`, `totalTasks: 0`). They were not independent products —
every one declared a dependency on the original speckit feature
`001-valencia-events` and framed itself as *extending / superseding / fixing*
that feature's decisions.

On **2026-06-20** they were consolidated into the single authoritative speckit
feature **`specs/001-valencia-radar/`** (sub-areas A–I). Nothing was lost: every
requirement, decision, threshold, table, and open question was folded into
`001-valencia-radar/research.md` and `data-model.md`, and the seven concrete
contradictions between them were resolved (see the "Resolved contradictions"
section of that research file). These files are kept verbatim for provenance.

| Archived spec | Folded into sub-area | Notable content preserved |
|---|---|---|
| `pipeline/` | A Ingestion & Source Registry · B Pipeline Architecture | parser+normalizer registry, "add a source" contract, adaptive per-source cadence, conditional-GET, bounded parallel pool, canonical stage order |
| `dedup/` | C Deduplication | two-layer match, `entity_sources` link table, places dedup path, geo guards/centroid blacklist, status convention reconciliation |
| `card-enrich/` | E Card Enrichment | Anthropic SDK constrained decoding, canonical `enrichment_json` schema, ground-or-flag anti-hallucination, model tiering, web tools |
| `repeateable-events/` | D Recurring Events | `event_series` + `event_occurrences` model, 104→11 Hemisfèric collapse, series-level enrich/score/notify |
| `llm-testing/` | E (SDK/schema) · I LLM Evaluation | promptfoo + node:test two-layer harness, golden fixtures, assertion thresholds |
| `local-run/` | H Local Dev | Docker Postgres + Neon HTTP proxy shim, `db:local:*` scripts, `LOCAL_RUN.md` checklist |
| `vercel-workflow/` | B Pipeline Architecture | Vercel Workflow durable substrate (`refreshWorkflow`/`enrichWorkflow`/`digestWorkflow`) |

`_ralph-state/` holds the old ralph index (`.index/`) and active-spec pointer
(`.current-spec`) at the moment of archival. The project now uses **speckit
only**; the active feature is resolved via `.specify/feature.json`.
