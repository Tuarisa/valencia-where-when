# Implementation Plan: Valencia Radar — curated events & places radar

**Branch**: `001-valencia-radar` | **Date**: 2026-06-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-valencia-radar/spec.md`

**Consolidation note**: This plan covers the single feature that absorbed the
original `001-valencia-events` plan and the seven archived ralph research specs.
All technical decisions live in [research.md](./research.md); the data shapes in
[data-model.md](./data-model.md); contracts in [contracts/](./contracts/).

## Summary

Extend the existing Next.js 14 + Neon Postgres app so the already-running pipeline
(ingest → normalize → score → tag → geo) becomes the full curated radar across nine
bounded sub-areas. The missing pieces: cross-source **dedup** for events *and*
places (with an `entity_sources` link table and geo guards), a **recurring-events**
model (`event_series` + `event_occurrences`), batched **enrichment** on the
**Anthropic SDK** (constrained decoding, OCR + RU translation, grounded facts),
**notify** (weekly Friday digest + rare alert), an **adaptive multi-source
ingestion** registry + dispatcher, the durable **Vercel Workflow** execution
substrate, the **places/restaurants catalog** surface, and the supporting **local
dev** + **LLM eval** tooling. No rewrite: every change lands in the current
`lib/pipeline/*`, `app/*`, `db/schema.sql`, and `scripts/*`; all schema growth is
additive (`IF NOT EXISTS`).

## Technical Context

**Language/Version**: TypeScript 5.5 on Node ≥ 20 (Next.js runtime); pipeline run
locally via `.mjs` scripts (`tsx`).

**Primary Dependencies**: Next.js 14.2 (App Router) + React 18,
`@neondatabase/serverless` 0.10 (HTTP Postgres), Leaflet (client map),
**`@anthropic-ai/sdk`** (enrichment, constrained decoding; `claude -p` OAuth
fallback), **`workflow`** (Vercel Workflow durable jobs). Dev-only: `promptfoo`
(live LLM eval), `tsx`, Docker (local Postgres + Neon HTTP proxy).

**Storage**: Neon serverless Postgres. Schema `db/schema.sql`: existing `sources`,
`source_runs`, `source_items` (append-only raw), `events`, `places`, `media_assets`,
`notifications`; **new additive**: `entity_sources`, `event_series`,
`event_occurrences`, `sources` cadence columns, `source_runs.changed/not_modified`,
`places` enrichment columns, `notifications.series_id`/`place_id`. Enrichment columns
on `events` and `notified` flags already exist (see data-model "Verified facts").

**Testing**: **`node:test`** (`node --test tests/`) for pure logic (scoring, dedup
keys + merge, date/title parsing, digest selection, tag inference, schema-shape,
enrich field-mapping with a mocked client); **`npm run build`** as the type/compile
gate; a dry-run harness (`pipeline:run`, digest `?dry=1`); **`promptfoo` live eval**
(`npm run eval`, key-gated, excluded from CI). No heavy E2E.

**Target Platform**: Vercel (web + cron + Workflow). Site is server-rendered,
`force-dynamic`, reading the DB at request time. Durable jobs run as Vercel Workflows
(no 300s cap; per-step retries); offline `.mjs` path stays for local runs.

**Project Type**: Web application — a single Next.js app with an internal pipeline
library (`lib/pipeline/`). No backend/frontend split.

**Performance Goals**: Dispatcher tick within 300s on Hobby (bounded pool 4–6,
adaptive due-select); enrichment capped per run and run as Workflow steps so no
single call blocks. Site pages render well under a second from indexed queries
(current scale: hundreds of events, tens of places).

**Constraints**: Append-only raw layer; dedup keeps source links + never merges on
fallback geo alone; enrichment fails soft + grounds-or-flags; notifications opt-in +
deduplicated (events *and* places); deterministic static-first rendering; every
change builds green and commits; additive-only schema; Nominatim ~1.1s pacing + real
User-Agent; recurring schedules are idempotent.

**Scale/Scope**: ~342 events / 14 places / 22 sources / 216 media today (104 of the
events collapse into 11 Hemisfèric series + 104 occurrences); single-household
readership (no concurrency/scale concerns); ~few-hundred–low-thousands Workflow
events/month (well inside Hobby free tier).

## Constitution Check

*GATE: re-checked against constitution **v1.1.0** (amended for this consolidation).*

| Principle | How this plan complies |
|-----------|------------------------|
| I. Data Integrity First | Normalizers/dedup only read `source_items` and write/merge `events`/`places`/series; raw rows are marked, never deleted. Dedup records every contributor in `entity_sources` and keeps `sources[]` on the survivor; merge resolves by source weight+score; geo guard prevents false merges. |
| II. Curation Over Volume | Adds normalizers + dedup + scoring + confidence-gating so more *curated* (and verified) items surface; digest selection is an explicit filtered query. |
| III. Two Independent Outputs | Events afisha and places catalog are separate render paths + separate pipeline concerns; places dedup/enrichment/catalog do not depend on event tasks. |
| IV. Batched, Resilient Enrichment | `enrichWorkflow` runs per-card as Workflow steps with a per-run cap; SDK constrained decoding (mockable) primary, `claude -p` fallback; per-item try/catch leaves the base record valid; ground-or-flag, never invent. Not on the synchronous hot path. |
| V. Static-First, Cron-Driven | No live scraping at request time; pipeline order `ingest → normalize → dedup → score → tag → enrich → geo`; dispatcher + digest are scheduled endpoints; digest dispatch explicit with `notified` bookkeeping for events *and* places. |
| VI. Reversible Automation | Each sub-area task is independent; `npm run build` is the gate; one commit per task; all schema changes additive `IF NOT EXISTS` migrations against `db/schema.sql`; recurring migration soft-retires old rows (`status='superseded'`), never drops. |

**Result: PASS** (no violations; Complexity Tracking not required).

**Flagged constraint (not a violation):** Vercel Hobby allows **one cron/day** and
the Workflow SDK has **no scheduler**. Decision (research R5/A6/B2): keep the daily
Vercel cron as a force-all safety-net, drive the fine-grained dispatcher tick
(`*/15`) + the weekly Friday digest via GitHub Actions cron hitting
`CRON_SECRET`-protected routes that `start()` Workflows fire-and-forget. Vercel Pro
multi-cron is a deferred option.

## Project Structure

### Documentation (this feature)

```text
specs/001-valencia-radar/
├── plan.md              # This file
├── spec.md              # Product spec (FR/SC/user stories, sub-area map A–I)
├── research.md          # Phase 0 — all decisions + resolved contradictions + deferred
├── data-model.md        # Phase 1 — entities, additive schema, derived state, thresholds
├── quickstart.md        # Phase 1 — how to run (incl. local Docker) & validate
├── contracts/           # Phase 1 — cron endpoints + pipeline-stage + workflow contracts
└── tasks.md             # Phase 2 — task list grouped by sub-area
specs/_archive/          # The 7 superseded ralph research specs (provenance)
```

### Source Code (repository root)

```text
app/
├── page.tsx                     # home: feed (events ∪ series) + calendar + map
├── Home.tsx                     # client UI (search, calendar buckets occurrences, Leaflet)
├── events/[id]/page.tsx         # event/series detail (full schedule for series)
├── places/[id]/page.tsx         # place detail
├── places/page.tsx              # NEW: places/restaurants catalog (facets)
├── workflows/                   # NEW: Vercel Workflow definitions
│   ├── refresh.ts               #   refreshWorkflow (ingest→…→geo steps)
│   ├── enrich.ts                #   enrichWorkflow(limit) (per-card fan-out)
│   └── digest.ts                #   digestWorkflow(mode)
└── api/
    ├── cron/refresh/route.ts    # start(refreshWorkflow) (was: await runPipeline)
    ├── cron/dispatch/route.ts   # NEW: adaptive due-source dispatcher tick
    ├── cron/enrich/route.ts     # NEW: start(enrichWorkflow)
    └── cron/digest/route.ts     # NEW: start(digestWorkflow) — weekly + alert

lib/
├── db.ts, queries.ts, format.ts # + local Neon shim (host-gated)
└── pipeline/
    ├── ingest.ts, score.ts, tags.ts, geo.ts, util.ts, run.ts   # existing (+ 'use step')
    ├── normalize.ts             # registry/dispatch (DONE: T-A2) → normalizeAll()
    ├── normalizers/             # one module per source family (Hemisfèric done)
    ├── dispatcher.ts            # NEW: selectDueSources() + dispatch()
    ├── series.ts                # NEW: upsertSeries() for recurring sources
    ├── dedup.ts                 # EXTEND: two-layer + places + entity_sources (convention fix)
    ├── enrich.ts                # NEW: Anthropic SDK enrichOne/enrichCards (injectable client)
    └── notify.ts                # NEW: selectDigest/selectAlerts + mark-notified

db/schema.sql                    # additive IF NOT EXISTS migrations only
scripts/{apply-schema,seed,run-pipeline}.mjs   # + local Neon shim
tests/                           # node:test units + fixtures/enrich/*.json
.github/workflows/scheduler.yml  # external cron: dispatch tick + Friday digest
docker-compose.yml + LOCAL_RUN.md # NEW: local Postgres + Neon HTTP proxy (sub-area H)
promptfooconfig.yaml             # NEW: live LLM eval (sub-area I)
next.config.mjs                  # wrapped with withWorkflow
.env.example                     # + ANTHROPIC_API_KEY, notification transport
```

**Structure Decision**: Web application, single Next.js app with an internal pipeline
library. New pipeline stages live under `lib/pipeline/`; durable jobs are Workflow
definitions under `app/workflows/` triggered by `CRON_SECRET`-protected
`app/api/cron/*` routes; the catalog is a new route under `app/places/`. This matches
the existing layout — no new top-level projects.

## Complexity Tracking

> No constitution violations — section intentionally empty.
