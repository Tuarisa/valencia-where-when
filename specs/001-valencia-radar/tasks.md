---
description: "Task list for Valencia Radar (001-valencia-radar)"
---

# Tasks: Valencia Radar — curated events & places radar

**Input**: Design documents from `specs/001-valencia-radar/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Lightweight `node:test` units for pure logic + a mocked-client enrich
unit (plan Testing). `npm run build` is the compile gate for every task. Live LLM
eval (`promptfoo`) is key-gated and out of CI.

**Organization**: Grouped by the sub-areas A–I from spec.md. This is an EXISTING
codebase — most tasks EXTEND files in `lib/pipeline/`, `app/`, `scripts/`. Each task
must end green (`npm run build`) and be committed (constitution VI). All schema
changes are additive (`IF NOT EXISTS`).

## Format: `[ID] [P?] [Area] Description`

- **[P]**: can run in parallel (different files, no dependency)
- **[Area]**: A–I per spec.md; Setup/Foundational/Polish have no area label
- Status: `[x]` done · `[~]` partially done, needs the noted fix · `[ ]` todo

---

## Phase 0: Setup & tooling foundation

- [x] T001 `node:test` harness exists (`tests/` with `node --test`); `npm test`
  script present. *(done: `npm test` → 8/8 pass — smoke + dedup + normalize-registry.)*
- [x] T002 [P] Add `.github/workflows/scheduler.yml` skeleton (`workflow_dispatch` +
  the `*/15` dispatch tick + Friday `0 7 * * 5` digest) POSTing with
  `Authorization: Bearer ${{ secrets.CRON_SECRET }}` (research A6/B2/R5).
  *(done: tick/digest/manual jobs guarded by `github.event.schedule`; routes land with their tasks.)*
- [x] T003 [P] Document new env in `.env.example`: `ANTHROPIC_API_KEY` (enrichment +
  live eval), notification transport token/webhook, local `DATABASE_URL` example.
  *(done: + `NOTIFY_TRANSPORT`/telegram/webhook + `APP_BASE_URL`.)*

**Checkpoint**: harness + scheduler scaffolding + env docs exist; build green.

---

## Phase 1: Foundational — additive schema (blocks C/D/E/G/A)

**⚠️ CRITICAL**: complete before the sub-area work that writes these shapes.

- [ ] T004 Add ALL additive schema to `db/schema.sql` (`IF NOT EXISTS`) per
  data-model.md, then run `npm run db:setup` against a dev DB:
  - `entity_sources` table + 2 indexes (sub-area C)
  - `event_series` + `event_occurrences` tables + 4 indexes (sub-area D)
  - `sources` adaptive-cadence columns + `idx_sources_due` (sub-area A)
  - `source_runs.changed`, `source_runs.not_modified` (sub-area A)
  - `places` enrichment columns (`title_ru`, `description_ru`, `links_json`,
    `enrichment_json`, `enriched_at`, `notified`, `notified_at`) (sub-areas E/G)
  - `notifications.series_id`, `notifications.place_id` (sub-areas D/G)
  - Do NOT re-add columns events already has (see data-model "Verified facts").
- [x] T005 Refactor `lib/pipeline/normalize.ts` into a **registry/dispatch** keyed by
  `source_key`/`item_type`; Hemisfèric moved to `normalizers/hemisferic.ts`; export
  `normalizeAll()`. *(done)*
- [x] T006 [P] Shared normalizer types/helpers in `normalizers/types.ts`
  (`EventDraft`, `PlaceDraft`, `NormalizedOut`, status enum) + `markRawItem(status,
  note)` that never deletes `source_items`. *(done)*
- [x] T007 [P] `tests/normalize-registry.test.mjs` — dispatch routes to the right
  normalizer; unknown sources → `ignored`. *(done)*

**Checkpoint**: pipeline still runs (`npm run pipeline:run`), all new tables/columns
exist, raw layer still append-only.

---

## Sub-area A: Ingestion & Source Registry (FR-001/017/019/020)

- [ ] T010 [A] Add `PARSER_REGISTRY` to `lib/pipeline/ingest.ts`
  (`Map<type|key, (source, body|json) => RawItem[]>`); resolve parser from registry,
  send `If-None-Match`/`If-Modified-Since` from `sources.etag`/`last_modified`, handle
  304, return inserted-count, per-source 429/`Retry-After` backoff (research A1/A4/A5).
- [ ] T011 [A] Extend `lib/pipeline/util.ts` `fetchText`/`fetchJson` to accept/return
  conditional-GET headers (ETag, Last-Modified, 304).
- [ ] T012 [A] New `lib/pipeline/dispatcher.ts`: `selectDueSources()` +
  `dispatch({concurrency})` (bounded `Promise.allSettled` pool 4–6, due-select,
  cadence-state update); keep `ingestAll()` force-all path (research A6).
- [ ] T013 [A] New `app/api/cron/dispatch/route.ts` (Bearer `CRON_SECRET`, fail-closed)
  → `dispatch()`; wire the `*/15` tick in `scheduler.yml`.
- [ ] T014 [A] Seed per-type cadence defaults in `scripts/seed.mjs` / `sources.json`
  (telegram 600s–3h, web 1h–24h, ticketing/api 2h–24h).
- [ ] T015 [P] [A] `tests/cadence.test.mjs`: `poll_interval=clamp(gap×0.33,min,max)`,
  back-off ×1.5, error backoff, due-select ordering (pure logic, no network).

---

## Sub-area B: Pipeline Architecture & Vercel Workflow (FR-016/020)

- [ ] T020 [B] Reorder `lib/pipeline/run.ts` to the canonical order
  **ingest → normalize → dedup → score → tag → enrich → geo** (dedup after normalize;
  enrich before geo) — corrects old T025 (research R1/R7).
- [ ] T021 [B] `npm i workflow`; wrap `next.config.mjs` with `withWorkflow`; remove
  `functions.maxDuration` from `vercel.json`.
- [ ] T022 [B] Add `app/workflows/refresh.ts` (`use workflow` `refreshWorkflow`) with
  each stage as a `use step`; change `app/api/cron/refresh/route.ts` to
  `start(refreshWorkflow)` fire-and-forget returning `{runId}`.
- [ ] T023 [P] [B] Keep `lib/pipeline/run.ts` + `scripts/run-pipeline.mjs` working as
  the offline `.mjs` path (no Workflow) for local-run; verify determinism rule (no
  `Date.now()`/random in workflow bodies).

---

## Sub-area C: Deduplication (FR-003/004, SC-003) — extends existing dedup.ts

- [x] T030 [C] First-pass `lib/pipeline/dedup.ts` (events fuzzy `groupByKey`, survivor
  by weight+score). *(done — but see fixes below)*
- [x] T031 [P] [C] `tests/dedup.test.mjs` (Komissarenko 3→1). *(done)*
- [ ] T032 [C] **Reconcile merge convention** (research R2): standardize on
  `status='duplicate'` + `metadata_json.merged_into=<survivor_id>` on losers + keep
  `sources[]` on the survivor; update `dedup.ts` (it currently writes `'merged'`).
- [ ] T033 [C] Add the `entity_sources` writes: one row per contributing
  `source_item_id` (UNIQUE upsert), `role`, `match_method`, `match_score`; survivor id
  stable.
- [ ] T034 [C] Migrate the 90 existing seed duplicate rows + backfill `entity_sources`
  from `merged_into`+`source_item_id` (one-shot script) BEFORE wiring.
- [ ] T035 [C] Deterministic strong-match pre-pass (exact url / `(source,external_id)`
  / resolved `maps_url` / person-URL) before fuzzy; same-person far-date → related
  link, not hard-merge (research C1/C5).
- [ ] T036 [C] **Places dedup path**: `placeKey = nameSignature|area|category`,
  strong-match on `maps_url`/`external_id`, fuzzy name+category+geo, `recommended_by`
  union (research C2).
- [ ] T037 [C] **Geo guard**: only `geo_source='map_url'` votes; centroid blacklist
  (Madrid Sol 40.4168,-3.7035); haversine R 75–120 m; never merge on geo alone
  (research C3).
- [ ] T038 [C] Insert `dedup` into `run.ts` right after `normalize` and expose via
  `refreshWorkflow`; ensure occurrences are NOT scanned.
- [ ] T039 [P] [C] Extend tests: places trio (ids 4/7/8) and Madrid-centroid trio
  (10/11/12) MUST NOT merge; pure-TS Jaro-Winkler + haversine unit tests.

---

## Sub-area D: Recurring Events (FR-018, SC-009) — series + occurrences

- [ ] T040 [D] `lib/pipeline/series.ts` `upsertSeries(series, occurrences[])`:
  idempotent upserts (unchanged schedule = 0 INSERTs, only `last_seen` bumps);
  series/occurrence `dedup_hash` per data-model identity.
- [ ] T041 [D] Rewrite `normalizers/hemisferic.ts` to emit 1 series + N occurrences
  (per-session granularity); mark old Hemisfèric `events` rows `status='superseded'`.
- [ ] T042 [D] Migrate seed: 104 Hemisfèric `events` → 11 `event_series` + 104
  `event_occurrences` (regenerate from raw `source_items`); ~228 single-shot events
  untouched.
- [ ] T043 [D] Feed + calendar cutover: feed UNIONs `events` ∪ `event_series` (JS sort
  by score); calendar buckets `event_occurrences` JOIN `event_series`; detail page
  shows full schedule; replace `is_hemisferic` with `is_series`/`occurrence_count`.
- [ ] T044 [P] [D] `tests/series.test.mjs`: 104→11+104, idempotent re-run (0 new
  occurrences, `enriched_at` not reset), dedup skips occurrences (SC-009).

---

## Sub-area E: Card Enrichment (FR-008/021, SC-006/010) — Anthropic SDK

- [ ] T050 [E] `npm i @anthropic-ai/sdk`; `lib/pipeline/enrich.ts` with
  `enrichOne(row,{client,web,exec})` + `enrichCards(limit,{dry,client,exec})`,
  injectable client; constrained decoding (`output_config.format`,
  `additionalProperties:false`, no min/max, `effort:low`); selection `WHERE
  enriched_at IS NULL ORDER BY score DESC NULLS LAST LIMIT $limit`; per-item try/catch
  (research E1/E2).
- [ ] T051 [E] Implement the canonical `enrichment_json` schema (data-model E):
  OCR + RU translate + extract in one call (poster image block); persist whole blob +
  promote columns with `COALESCE` guards; `events` maps link → `links_json` entry.
- [ ] T052 [E] Ground-or-flag anti-hallucination + confidence/notes/citations; model
  tiering (Haiku default, Opus on poster/low-confidence/conflict); enrich does NOT
  geocode (research E6/E7).
- [ ] T053 [P] [E] Optional web augmentation behind `{web}` flag (`web_search` +
  `web_fetch`, two-turn shape, `max_uses:3`); offline app-fetch fallback +
  `claude -p` fallback path (research E5/R3).
- [ ] T054 [E] Target series too: enrich runs once per `event_series` (not per
  occurrence); re-enrich trigger `enriched_at IS NULL OR last_seen > enriched_at OR
  force`.
- [ ] T055 [E] `app/workflows/enrich.ts` `enrichWorkflow(limit)` (per-card step
  fan-out) + `app/api/cron/enrich/route.ts` (Bearer, fail-closed) →
  `start(enrichWorkflow)`; NOT on the synchronous hot path.
- [ ] T056 [P] [E] `tests/enrich-parse.test.mjs` (mocked client): field mapping,
  fail-soft (forced-fail item leaves base record valid), `COALESCE` guard,
  confidence/notes bounds (SC-006).

---

## Sub-area F: Outputs & Surfaces (FR-009/010/011/015, SC-001/005/007)

- [ ] T060 [F] Audit `app/page.tsx` + `lib/queries.ts`: feed excludes raw/ignored +
  `superseded`; "curated only" filter (score/normalized); UNION events ∪ series.
- [ ] T061 [F] Confirm calendar defaults to current month (SC-005) and renders
  per-session occurrences; detail page prefers `title_ru`/`description_ru` +
  `links_json` clickable links (FR-011).
- [ ] T062 [P] [F] Leaflet map plots events/places/series with `lat`/`lng`; hide
  marker-less cleanly.
- [ ] T063 [F] **Places catalog** `app/places/page.tsx` with facet filters
  (cuisine/category, district/area, occasion, `price_level`, `recommended_by`); reuse
  `places/[id]`; renders independently of events (FR-015, Constitution III).
- [ ] T064 [F] Place-mining normalizers for place-rich sources (`rutatuta_vlc`,
  `logunespa`, `gosvetlanada`, Fever gastro) → `places`.
- [ ] T065 [P] [F] `tests/feed-query.test.mjs` + `tests/place-categorize.test.mjs`
  (curated filter, current-month helper, occasion/price/cuisine inference).

---

## Sub-area G: Notifications (FR-012/013/014/021, SC-002/008)

- [ ] T070 [G] `lib/pipeline/notify.ts`: `selectDigest({horizonDays, threshold})`
  (family-fit + `notified=0` + date window + `score≥threshold` +
  `confidence≥holdThreshold`) returning events/series + new places;
  `selectAlerts({alertThreshold})`.
- [ ] T071 [G] `app/workflows/digest.ts` `digestWorkflow(mode)` (select→build→send→
  mark) + `app/api/cron/digest/route.ts` (Bearer, fail-closed; `?mode=weekly|alert`,
  `?dry=1`); on send set `notified`/`notified_at` + insert `notifications` row for
  events, series, and places (FR-013).
- [ ] T072 [P] [G] Pluggable `sendDigest(payload)` (default dry-run text); real
  transport behind an env flag (research G2).
- [ ] T073 [G] Series digest renders the card + next upcoming occurrence
  (`MIN(occurrence_date) ≥ today`).
- [ ] T074 [P] [G] `tests/digest-select.test.mjs` + `tests/alert-select.test.mjs`:
  horizon, threshold, confidence-hold, already-notified exclusion (events + places),
  idempotent re-run = 0 repeats (SC-002/008).

---

## Sub-area H: Local Dev tooling (FR-022, SC-011)

- [x] T080 [H] `docker-compose.yml`: `postgres:15` + `ghcr.io/timowilhelm/
  local-neon-http-proxy:main` (port 4444, healthcheck-gated). *(done)*
- [x] T081 [H] Neon shim gated on host substring `db.localtest.me` (NEVER `NODE_ENV`)
  in `lib/db.ts` + `scripts/_neon-local.mjs` (imported by apply-schema/seed;
  run-pipeline gets it via `lib/db.ts`); both call shapes preserved, zero query-site
  rewrites. *(done)*
- [x] T082 [P] [H] Added `tsx` devDep; npm scripts `db:local:up`/`db:local:down`/
  `db:local:setup`/`dev:local`. *(done; run-pipeline already had `register('tsx/esm')`.)*
- [x] T083 [H] `LOCAL_RUN.md` checklist mapped to SC-001..SC-011 (pending rows marked);
  seed totals after Feria: 385 events / 23 sources / 14 places / 216 media. *(done)*

---

## Sub-area I: LLM Evaluation tooling (FR-022, SC-010)

- [ ] T090 [I] `promptfooconfig.yaml` (dev-only `promptfoo`) wrapping real `enrichOne`
  via custom-script provider; assertions `is-json`+Ajv, fuzzy date (±0), venue
  Levenshtein ≥0.85, `llm-rubric` RU-quality (Haiku grader ≥0.7).
- [ ] T091 [P] [I] Golden fixtures `tests/fixtures/enrich/*.json` (10–25, keyed on
  series): Komissarenko, RU Telegram posts, an ES poster for OCR.
- [ ] T092 [I] `npm run eval` script (key-gated, skipped when `ANTHROPIC_API_KEY`
  unset, excluded from CI default); keep mocked `npm test` fully offline.

---

## Phase 10: Polish & Cross-Cutting

- [ ] T100 [P] Fail-closed `CRON_SECRET` (401 when unset/mismatched) on all new
  `app/api/cron/*` routes (Constitution V; was a convergence gap).
- [ ] T101 [P] Add the spec-named but unconfigured sources to `sources.json` +
  ingest: `elcontacto.ru`, `russpain`, `eventbrite` (enabled), `SpainNewsOnline`
  (`enabled=0`/`weight=off`) — FR-001.
- [ ] T102 [P] Run `quickstart.md` validation scenarios end-to-end.
- [ ] T103 [P] Update `WORKBOARD.md` Done/Next; `npm run build` + `node --test tests/`
  clean; tidy dead code.

---

## Remaining source normalizers (cross-cutting, feed A/F — one source per iteration)

> Each: normalizer module + `NORMALIZER_REGISTRY` entry + `npm run pipeline:run`
> parity check + build green. Prime parallel/loop fodder.

- [ ] T110 [P] worldafisha · T111 [P] valenciarusa · T112 [P] vidacultural_Valencia
  (+place posts) · T113 [P] concerten · T114 [P] Palau de la Música ·
  T115 [P] CAC (agenda/exposiciones/actividades/museu) · T116 [P] visitvalencia ·
  T117 [P] lacotorra · T118 [P] **Fever extractor** (individual event pages) ·
  T119 [P] Ticketmaster · T120 [P] Songkick · T121 [P] Valencia Bonita ·
  T122 [P] Hoy Valencia · T123 [P] laganzua

---

## Dependencies & Execution Order

- **Phase 0 Setup** → **Phase 1 schema (T004)** blocks C/D/E/G writes; normalize
  registry (T005–T007) already done.
- **B (T020 reorder, T021–T022 Workflow)** underpins refresh/enrich/digest triggers.
- **C dedup** best after several normalizers (T110+) produce duplicates; convention
  fix (T032) + seed migration (T034) BEFORE wiring (T038).
- **D recurring** before/with the feed+calendar cutover (T043) — coordinate to avoid
  a half-migrated render.
- **E enrichment** independent/best-effort — anytime after schema; series target
  (T054) depends on D.
- **F outputs**: places catalog (T063) independent of events (Constitution III).
- **G notify** depends on `notify.ts` (T070) + scored/curated data + confidence (E).
- **H/I tooling** independent; H unblocks offline verification of everything.

## Implementation Strategy (MVP first)

1. Phase 0 + Phase 1 schema → registries in place.
2. F (US1 afisha) on current data → validate MVP feed/calendar/map.
3. D recurring (fix Hemisfèric to series) → validate SC-009.
4. C dedup hardening (convention fix → entity_sources → places → geo guard).
5. E enrichment (SDK) → G digest/alert → validate no-repeat + confidence-hold.
6. A adaptive ingestion + B Workflow substrate; grind T110+ normalizers one per
   iteration.
7. H/I tooling alongside; Phase 10 polish + quickstart validation.

## Notes
- Every task: end on green `npm run build`, commit with a descriptive message.
- `[P]` = different files, no dependency. Keep raw `source_items` append-only and all
  schema changes additive (`IF NOT EXISTS`).
- Normalizers (T110+) are the highest-volume, most loop-friendly backlog.
