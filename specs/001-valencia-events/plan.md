# Implementation Plan: Valencia Radar — curated events & places radar

**Branch**: `001-valencia-events` | **Date**: 2026-06-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-valencia-events/spec.md`

## Summary

Extend the existing Next.js 14 + Neon Postgres app so the already-running pipeline
(ingest → normalize → score → tag → geo) gains the three missing stages the spec
requires — **cross-source dedup**, **batched card enrichment** (`claude -p` OCR +
RU translation), and **notify** (weekly Friday digest + rare-event alert) — plus
**full multi-source normalizers** (today only Hemisfèric normalizes
deterministically), **wider geo coverage**, and the **places/restaurants catalog**
surface. No rewrite: every change lands in the current `lib/pipeline/*`, `app/*`,
`db/schema.sql`, and `scripts/*`. The DB schema already carries the columns/tables
for all of this (enrichment fields, `notified` flags, `notifications`).

## Technical Context

**Language/Version**: TypeScript 5.5 on Node ≥ 20 (Next.js runtime); pipeline run
locally via `.mjs` scripts.

**Primary Dependencies**: Next.js 14.2 (App Router) + React 18, `@neondatabase/serverless`
0.10 (HTTP Postgres), Leaflet (client map, via CDN/unoptimized images), `claude -p`
CLI for enrichment (invoked out-of-band in batches).

**Storage**: Neon serverless Postgres. Schema `db/schema.sql`: `sources`,
`source_runs`, `source_items` (append-only raw), `events`, `places`,
`media_assets`, `notifications`. Enrichment columns (`title_ru`, `description_ru`,
`links_json`, `enrichment_json`, `enriched_at`) and `notified`/`notified_at`
already exist.

**Testing**: No framework today. Decision (see research.md): adopt **`node:test`**
for pure-logic pipeline units (scoring, dedup keys, date/title parsing,
digest-selection filters) run via `node --test`, plus **`npm run build`** as the
type/compile gate, plus a dry-run harness (`pipeline:run`, digest `--dry-run`)
against a real/staging DB. No heavy E2E.

**Target Platform**: Vercel (web + cron functions), `maxDuration` 300s on the cron
route. Site is server-rendered, `force-dynamic`, reading the DB at request time.

**Project Type**: Web application — a single Next.js app with an internal pipeline
library (`lib/pipeline/`). No backend/frontend split.

**Performance Goals**: Pipeline run within the 300s cron budget; enrichment capped
per run (per-item cap, batched) so no single `claude -p` call blocks (prior calls
timed out at 180s/60s). Site pages render in well under a second from indexed
queries (current scale: hundreds of events, tens of places).

**Constraints**: Append-only raw layer; dedup must keep source links; enrichment
must fail soft; notifications opt-in + deduplicated; deterministic static-first
rendering; every change builds green and commits. External politeness: Nominatim
~1.1s pacing + real User-Agent.

**Scale/Scope**: ~342 events / 14 places / 22 sources today, growing as normalizers
land; single-household readership (no concurrency/scale concerns).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | How this plan complies |
|-----------|------------------------|
| I. Data Integrity First | New normalizers/dedup only read `source_items` and write/merge `events`/`places`; raw rows are marked, never deleted. Dedup merges by source weight+score and writes a `sources`/`source_url` link list onto the survivor. |
| II. Curation Over Volume | Adds normalizers + dedup + scoring tuning so more *curated* items surface; digest selection is an explicit filtered query, not "send everything." |
| III. Two Independent Outputs | Events afisha and places catalog are separate render paths and separate pipeline concerns; places catalog tasks do not depend on event tasks and vice-versa. |
| IV. Batched, Resilient Enrichment | `enrich-cards` runs as its own cron-batched stage with a per-run item cap; a failed item is logged and skipped, base record stays valid. Not added to the synchronous `runPipeline` hot path. |
| V. Static-First, Cron-Driven | No live scraping at request time; pipeline + digest are scheduled endpoints; digest dispatch is explicit with `notified` bookkeeping. |
| VI. Reversible Automation | Each stage/normalizer is an independent task; `npm run build` is the gate; one commit per task. |

**Result: PASS** (no violations; Complexity Tracking not required).

**Flagged constraint (not a violation):** Vercel Hobby allows **one cron/day**. The
spec wants 12h ingest + Friday 09:00 digest. Decision in research.md: keep
`vercel.json` cron as the daily ingest driver, and drive the **second ingest + the
weekly Friday digest via an external scheduler (GitHub Actions cron)** hitting
`CRON_SECRET`-protected endpoints — no paid tier required. Revisit if Pro is adopted.

## Project Structure

### Documentation (this feature)

```text
specs/001-valencia-events/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions (testing, dedup, enrichment, scheduler)
├── data-model.md        # Phase 1 — entities & derived state
├── quickstart.md        # Phase 1 — how to run & validate end-to-end
├── contracts/           # Phase 1 — cron endpoint + pipeline-stage + digest contracts
└── tasks.md             # Phase 2 — created by /speckit-tasks (+ /speckit-converge)
```

### Source Code (repository root)

```text
app/
├── page.tsx                     # home: feed + calendar + map (events afisha)
├── Home.tsx                     # client UI (search, calendar, Leaflet)
├── events/[id]/page.tsx         # event detail
├── places/[id]/page.tsx         # place detail
├── places/page.tsx              # NEW: places/restaurants catalog surface
└── api/
    ├── cron/refresh/route.ts    # ingest→…→geo pipeline (existing)
    ├── cron/enrich/route.ts     # NEW: batched enrich-cards stage
    └── cron/digest/route.ts     # NEW: weekly digest + rare alert dispatch

lib/
├── db.ts, queries.ts, format.ts
└── pipeline/
    ├── ingest.ts, score.ts, tags.ts, geo.ts, util.ts, run.ts   # existing
    ├── normalize.ts             # EXTEND: Hemisfèric-only → multi-source registry
    ├── normalizers/             # NEW: one module per source family
    ├── dedup.ts                 # NEW: cross-source merge stage
    ├── enrich.ts                # NEW: batched claude -p OCR + RU translate
    └── notify.ts                # NEW: digest selection + alert + mark-notified

db/schema.sql                    # add migrations only if a column is missing
scripts/{apply-schema,seed,run-pipeline}.mjs
tests/                           # NEW: node:test units for pure logic
.github/workflows/scheduler.yml  # NEW: external cron for 2nd ingest + Friday digest
```

**Structure Decision**: Web application, single Next.js app with an internal
pipeline library. All new pipeline stages live under `lib/pipeline/`; new scheduled
work is exposed as `CRON_SECRET`-protected route handlers under `app/api/cron/`;
the catalog is a new route under `app/places/`. This matches the existing layout
exactly — no new top-level projects.

## Complexity Tracking

> No constitution violations — section intentionally empty.
