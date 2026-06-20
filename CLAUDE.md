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
manual SSH push). **dedup over-merge FIXED** (T035 partial: Cyrillic→Latin translit in
`titleSignature` + `isMergeableGroup` requiring ≥2 distinct sources + untitled-guard;
live 11→0 false merges, idempotent). Also fixed `register("tsx/esm")` → `node --import
tsx` in `run-pipeline.mjs` (was broken on Node 24). **Dedup matching complete**:
events (translit + cross-source + untitled guard) + places (T036 partial:
`arePlacesDuplicate` strong+fuzzy) + geo guard (T037: `geoCorroborates`/`isCentroid`/
`haversineMeters`/`jaroWinkler`, 15/15 tests). Events dedup over-merge is fixed +
idempotent, so wiring it into `run.ts` (T038) is now SAFE. Still deferred: place dedup
DB orchestrator → T064 (place mining; needs places.status + render filter);
`entity_sources` writes (T033/T034) → need `source_items` (seed has none). **Events dedup wired into `run.ts`** (T038, offline path): order now
`ingest → normalize → dedup → score → tag → geo` (enrich slots in at T050;
`refreshWorkflow` exposure is T022). **Series helper done** (T040): `lib/pipeline/
series.ts` `upsertSeries` + `seriesHash`/`occurrenceHash`, idempotent (live-verified:
re-run = 0 new rows, preserves enriched_at/score/notified). **Hemisfèric normalizer
emits series** (T041): `buildHemisfericSeries` + `upsertSeries`, live-verified
(3 raw → 2 series + 5 occurrences, idempotent). Remaining for recurring: T042 migrate
the 104 existing seed events → series + T043 feed/calendar cutover — must land TOGETHER
(else Hemisfèric vanishes from the feed). **Enrich skeleton done** (T050/T056):
`lib/pipeline/enrich.ts` — injectable `EnrichClient`, `EnrichmentResult` schema,
`enrichOne` (COALESCE promote, maps→links_json), `enrichCards` (selection + fail-soft +
dry); SDK-free/mockable, live-verified COALESCE; 23/23 tests. **Notify done** (T070/T072 + T071 logic): `lib/pipeline/notify.ts` — pure
`selectDigest`/`selectAlerts`/`isFamilyFit`/`cardConfidence`/`withinHorizon` +
`buildDigest`/`renderDigestText` + pluggable `sendDigest` (dry default) +
`markEventsNotified`/`markPlacesNotified` (live-verified no-repeat = SC-002); 29/29.
**Enrich engine (revised per user): `claude -p` (Claude subscription/OAuth, NO API key)
is the DEFAULT** — the Anthropic SDK (`ANTHROPIC_API_KEY`) is OPTIONAL (constrained
decoding / Vercel serverless runtime, where the CLI is absent). enrich.ts is
engine-agnostic (injectable client), so T051 = build a `claude -p` client (no key).
**Digest route done** (T071); **PARSER_REGISTRY done** (T010, `resolveParser` in
ingest.ts). **Ad-hoc user requests go to the "Backlog — user inbox" section of
tasks.md** (the loop reads tasks.md) — no special command; user may prefix `бэклог:`.
**T130 logunespa crawl — IN PROGRESS** (user priority). `scripts/crawl-telegram.mjs`
(via `node --import tsx`) + `lib/pipeline/telegram-post.ts` parser: public
`t.me/<ch>/<n>?embed=1`, **HTML fetch-cache** in `data/.cache/` (gitignored — no
re-fetch on re-runs), `claude -p` extraction routes `place`→`data/seed/places-<ch>.json`
/ dated `event`→`data/seed/events-<ch>.json` (captures date/place/category/price). 4
records so far (3 places + 1 dated event). Resumable (continues from lowest crawled id);
run slowly to backfill ~1800 posts. **Link-following enrichment DONE**: `claude -p` WebFetches the post's source
links and reads them (validated — Titanic exhibition got exact address/price/venue from
bombasgens.com; Las Fallas from visitvalencia). **Crawl mode (user): PLACES-ONLY, 20/batch** —
`node --import tsx scripts/crawl-telegram.mjs logunespa 0 20 1500 places` (the 6th arg `places`
skips dated events; resumable from lowest crawled id). ~13 places + 19 events so far. Run as
a BACKGROUND command if 20 posts may exceed the 10-min foreground cap. Backlog: T132 Fever
drone-show extractor, T133 done, T053/T022/T042+T043, T134 design MCP, T135 part-1 names,
T136 worldafisha≈concerten dedup, T137 drop deprecated `fetchConnectionCache` in `lib/db.ts`.
**Ultracode fan-out round 1 DONE** (user enabled ultracode): a background Workflow ran 4
file-disjoint bundles in parallel + a verify phase, integrated by the main loop (tsc=0,
76/76 tests). **Bundle A (T011–T015)**: adaptive ingest — pure `lib/pipeline/cadence.ts`
(clamp/computePollInterval gap×0.33/backoffUnchanged ×1.5/backoffError ×2/selectDue),
`dispatcher.ts` (selectDueSources + bounded dispatch pool, persists cadence state per
outcome), conditional GET in `util.ts`/`ingest.ts` (ETag/If-Modified-Since → 304 →
`source_runs.not_modified`), `/api/cron/dispatch` fail-closed route (scheduler.yml `*/15`
tick was already wired), per-type cadence seed defaults. **Bundle E (T051~/T052/T053~/T054)**:
`enrich.ts` — `normalizeEnrichment` (drop unknown keys, clamp confidence, shape
links/citations), `groundReport`/`applyGroundOrFlag` (flag uncited facts, hold <0.6),
opt-in `{web}` EnrichClient capability (default off), `needsEnrich` + series-once
enrich (COALESCE preserve). T051/T053 are `[~]`: schema + `{web}` interface done, but the
OCR-extract CALL + web execution wait on the concrete **`claude -p` EnrichClient** (still
the open engine task). T055 (enrich workflow/cron) deferred → needs sub-area B `workflow`
pkg. **Bundle G (T073/T074)**: `notify.ts` series-aware digest (one card + next occurrence,
`markSeriesNotified` no-repeat on series_id); wiring it into the digest route = T071
follow-up. **Bundle N (T110/T111/T112)**: worldafisha (spain-filter pre-gate per T136),
valenciarusa, vidacultural normalizers, registered + fail-soft (run end-to-end once live
`source_items` exist). NEXT (serial, can't parallelize — fight over run.ts/queries.ts/
Home.tsx + need `npm i workflow`): round-2 bundles **B** (pipeline order: enrich before geo
in run.ts; `withWorkflow`; T022/T055 workflows) then **D+F** (Hemisfèric→series cutover
T042–T044; places catalog + map T060–T065).

**Non-negotiables** (see constitution v1.1.0): append-only raw `source_items`; dedup
keeps a link to every source (via `entity_sources`) and never merges on fallback geo
alone; all schema changes additive (`IF NOT EXISTS`); enrichment is batched/fail-soft
on the Anthropic SDK, grounds-or-flags facts (never invents); notifications opt-in +
de-duplicated for events AND places; recurring schedules idempotent; site renders
deterministically from the DB; every autonomous change builds green and commits.
<!-- SPECKIT END -->
