# Codebase Index: Valencia Radar

Generated for the smart-ralph implement loop. Catalogs existing components so tasks
in `specs/001-valencia-events/tasks.md` (T001–T055) can locate and extend them.

| Category | Count |
|----------|-------|
| Pipeline stages (services) | 7 |
| Data/format helpers | 3 |
| Web routes/pages (controllers/views) | 6 |
| Schema (migration) | 1 |
| Scripts | 3 |
| **Total source files** | **20** |

## Pipeline stages — `lib/pipeline/`

| File | Key exports | Purpose | Backlog touchpoints |
|------|-------------|---------|---------------------|
| `ingest.ts` | `ingestAll`, `ingestSource` | Fetch sources (telegram `t.me/s/`, web, Hemisfèric API) → append-only `source_items` | T037 Fever, T053 new sources |
| `normalize.ts` | `normalizeHemisferic` | **Hemisfèric-only** normalization (others pending) | T005 registry refactor, Phase 8 normalizers |
| `score.ts` | `scoreAll`, `scoreEvent` | 0–100 fit scoring | tune as categories grow |
| `tags.ts` | `tagAll`, `inferEventTags`, `inferPlaceTags` | Heuristic tagging | family-fit tags for digest |
| `geo.ts` | `geoEnrich` | Resolve map links + Nominatim geocode (1.1s pacing, real UA) | T027 wider coverage |
| `util.ts` | `fetchJson`, `fetchText`, `sourceItemHash`, `eventHash`, `sha1short`, `nowIso`, `parseIsoDate` | Shared fetch/hash/date helpers | reuse in dedup/enrich |
| `run.ts` | `runPipeline` | Orchestrates ingest→normalize→score→tag→geo | T025 insert dedup; **no enrich/notify** |

**Missing stages (to create):** `dedup.ts` (T024), `enrich.ts` (T043), `notify.ts` (T013), `normalizers/` registry (T005/T006).

## Data & format — `lib/`

| File | Key exports | Purpose |
|------|-------------|---------|
| `db.ts` | `sql` | Neon serverless Postgres client |
| `queries.ts` | `buildPayload`, `getEvents`, `getPlaces`, `getEventRow`, `getPlaceRow`, `getMedia`, `toSiteEvent`, `toSitePlace`, `SiteEvent`, `SitePlace`, `SitePayload` | DB → site payload. T008 curated filter lives here |
| `format.ts` | `deriveTitle`, `formatDateLabel`, `monthLabel`, `loadTags`, `slugify`, `excerpt`, `humanizeTag`, `RichText`, `LinkButtons` | Title/date/tag formatting; T010 RU/links rendering |

## Web routes/pages — `app/`

| File | Purpose | Backlog |
|------|---------|---------|
| `page.tsx` | Home feed (force-dynamic) | T008 curated feed |
| `Home.tsx` | Client UI: search, calendar, Leaflet map | T009 current-month + Hemisfèric collapse, T011 map |
| `events/[id]/page.tsx` | Event detail | T010 |
| `places/[id]/page.tsx` | Place detail | T010 |
| `api/cron/refresh/route.ts` | Pipeline trigger (Bearer `CRON_SECRET`, GET) | T025, T052/T054 |
| `detail-helpers.tsx` / `layout.tsx` | Shared detail rendering + root layout | — |
| **(missing)** `places/page.tsx` | Catalog surface | T022 |
| **(missing)** `api/cron/enrich`, `api/cron/digest` | New cron endpoints | T014, T044 |

## Schema & scripts

- `db/schema.sql` — 7 tables (sources, source_runs, source_items, events, places, media_assets, notifications). Enrichment + notify columns already present. T004/T051.
- `scripts/apply-schema.mjs`, `seed.mjs`, `run-pipeline.mjs` — DB setup + local pipeline run.

## Runtime prerequisites (loop gating)

- ✅ `npm run build` green; ✅ `claude` CLI on PATH.
- ⚠️ **No `.env` / `DATABASE_URL`** — DB-dependent tasks (T004, T013–T014, pipeline parity in Phase 8, geo/enrich) cannot fully run until Neon is configured. Pure-code tasks gate on `npm run build` + `node --test`.
