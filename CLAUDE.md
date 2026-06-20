<!-- SPECKIT START -->
# Valencia Radar — agent context

**Active feature**: `001-valencia-radar`
**Spec**: `specs/001-valencia-radar/spec.md`
**Plan**: `specs/001-valencia-radar/plan.md`
**Tasks**: `specs/001-valencia-radar/tasks.md`
**Research (all decisions)**: `specs/001-valencia-radar/research.md`
**Data model**: `specs/001-valencia-radar/data-model.md`
**Constitution**: `.specify/memory/constitution.md` (v1.1.0)

> Consolidated 2026-06-20: the original `001-valencia-events` feature and seven
> research-only ralph specs (pipeline, dedup, card-enrich, repeateable-events,
> llm-testing, local-run, vercel-workflow) were merged into this single feature
> (sub-areas A–I). The originals are preserved under `specs/_archive/`. The project
> now uses **speckit only**; the active feature is resolved via `.specify/feature.json`.

**Stack**: Next.js 14 (App Router) + React 18, Neon serverless Postgres
(`@neondatabase/serverless`), Vercel cron + **Vercel Workflow SDK** (`workflow`),
**Anthropic SDK** (`@anthropic-ai/sdk`, enrichment; `claude -p` fallback), TypeScript
pipeline in `lib/pipeline/`.

**Pipeline (canonical order, v1.1.0)**: ingest → normalize → **dedup** → score → tag
→ **enrich** → geo. Existing in `run.ts`: ingest/normalize(registry)/score/tag/geo +
a first dedup pass. TO BUILD: two-layer **dedup** for events+places (`entity_sources`,
geo guard, convention fix + 90-row seed migration), **recurring** model
(`event_series`+`event_occurrences`, Hemisfèric 104→11), SDK **enrich** (grounded,
confidence), **notify** (weekly digest + rare alert, events+places), adaptive
multi-source **ingestion** + dispatcher, **Vercel Workflow** substrate,
**places catalog** surface, **local-dev** (Docker+Neon proxy) + **LLM eval** tooling.

**Key commands**: `npm run build` (compile gate — must be green before commit),
`npm run dev`, `npm run db:setup`, `npm run pipeline:run`, `npm test` (`node --test`);
local dev (sub-area H, wired): `npm run db:local:up` → `npm run db:local:setup` →
`npm run dev:local` → `npm run db:local:down` (Docker Postgres + Neon HTTP proxy;
shim gated on `db.localtest.me`, see `LOCAL_RUN.md`); eval (key-gated): `npm run eval`.

**Progress**: Phase 0 done (T001 harness 8/8, T002 GH-Actions scheduler skeleton,
T003 `.env.example`). **T004 additive schema applied** to the live local DB
(`entity_sources`, `event_series`/`event_occurrences`, sources cadence cols,
`source_runs` changed/not_modified, places enrich cols, `notifications.series_id/place_id`).
Sub-area H local stack wired + running (T080–T083; `db:local:up` → seeded
385 events / 23 sources / 14 places / 216 media). One-off **Feria de Julio 2026**
source seeded (`web:feriadejuliovlc`, +43 events). **T032 dedup convention fixed**
(losers → `status='duplicate'`+`merged_into`, verified on local DB). Commit + push
per task (branch `main`; `origin` = HTTPS — SSH agent isn't available to the
non-interactive shell; workflow-file commits need `gh auth refresh -s workflow` or a
manual SSH push). ⚠️ **dedup is NOT wired into the pipeline**: the first-pass matcher
over-merges (75→11) and isn't idempotent — needs hardening (T035 strong-match,
T036 places, T037 geo guard) before T038. `entity_sources` writes (T033/T034) are
blocked until `source_items` exist (seed has none). Next: dedup hardening
(T035–T037), or T010 parser registry, or T040 series upsert.

**Non-negotiables** (see constitution v1.1.0): append-only raw `source_items`; dedup
keeps a link to every source (via `entity_sources`) and never merges on fallback geo
alone; all schema changes additive (`IF NOT EXISTS`); enrichment is batched/fail-soft
on the Anthropic SDK, grounds-or-flags facts (never invents); notifications opt-in +
de-duplicated for events AND places; recurring schedules idempotent; site renders
deterministically from the DB; every autonomous change builds green and commits.
<!-- SPECKIT END -->
