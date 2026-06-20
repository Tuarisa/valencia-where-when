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

- [x] T004 Add ALL additive schema to `db/schema.sql` (`IF NOT EXISTS`) per
  data-model.md, then run `npm run db:setup` against a dev DB:
  *(done: applied to the live local DB — 30 statements; `entity_sources`,
  `event_series`, `event_occurrences` + sources cadence cols + `source_runs`
  changed/not_modified + places enrich cols + `notifications.series_id/place_id`
  all verified; 385 events intact, additive & non-destructive.)*
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

- [~] T010 [A] Add `PARSER_REGISTRY` to `lib/pipeline/ingest.ts`
  (`Map<type|key, (source, body|json) => RawItem[]>`); resolve parser from registry,
  send `If-None-Match`/`If-Modified-Since` from `sources.etag`/`last_modified`, handle
  304, return inserted-count, per-source 429/`Retry-After` backoff (research A1/A4/A5).
  *(DONE — `PARSER_REGISTRY` (api:hemisferic self-fetch, telegram, web, ticketing, api) +
  pure `resolveParserKey`/`resolveParser`; `ingestSource` refactored off the if/else
  (behavior preserved: Hemisfèric self-fetch, telegram by type/url, web fallback); +3
  tests (32/32). STILL TODO: conditional-GET (ETag/Last-Modified/304) = T011, 429
  backoff, inserted-count return.)*
- [x] T011 [A] Extend `lib/pipeline/util.ts` `fetchText`/`fetchJson` to accept/return
  conditional-GET headers (ETag, Last-Modified, 304).
- [x] T012 [A] New `lib/pipeline/dispatcher.ts`: `selectDueSources()` +
  `dispatch({concurrency})` (bounded `Promise.allSettled` pool 4–6, due-select,
  cadence-state update); keep `ingestAll()` force-all path (research A6).
- [x] T013 [A] New `app/api/cron/dispatch/route.ts` (Bearer `CRON_SECRET`, fail-closed)
  → `dispatch()`; wire the `*/15` tick in `scheduler.yml`.
- [x] T014 [A] Seed per-type cadence defaults in `scripts/seed.mjs` / `sources.json`
  (telegram 600s–3h, web 1h–24h, ticketing/api 2h–24h).
- [x] T015 [P] [A] `tests/cadence.test.mjs`: `poll_interval=clamp(gap×0.33,min,max)`,
  back-off ×1.5, error backoff, due-select ordering (pure logic, no network).

---

## Sub-area B: Pipeline Architecture & Vercel Workflow (FR-016/020)

- [x] T020 [B] Reorder `lib/pipeline/run.ts` to the canonical order
  **ingest → normalize → dedup → score → tag → enrich → geo** (dedup after normalize;
  enrich before geo) — corrects old T025 (research R1/R7).
- [ ] T021 [B] `npm i workflow`; wrap `next.config.mjs` with `withWorkflow`; remove
  `functions.maxDuration` from `vercel.json`.
- [ ] T022 [B] Add `app/workflows/refresh.ts` (`use workflow` `refreshWorkflow`) with
  each stage as a `use step`; change `app/api/cron/refresh/route.ts` to
  `start(refreshWorkflow)` fire-and-forget returning `{runId}`.
- [x] T023 [P] [B] Keep `lib/pipeline/run.ts` + `scripts/run-pipeline.mjs` working as
  the offline `.mjs` path (no Workflow) for local-run; verify determinism rule (no
  `Date.now()`/random in workflow bodies).

---

## Sub-area C: Deduplication (FR-003/004, SC-003) — extends existing dedup.ts

- [x] T030 [C] First-pass `lib/pipeline/dedup.ts` (events fuzzy `groupByKey`, survivor
  by weight+score). *(done — but see fixes below)*
- [x] T031 [P] [C] `tests/dedup.test.mjs` (Komissarenko 3→1). *(done)*
- [x] T032 [C] **Reconcile merge convention** (research R2): standardize on
  `status='duplicate'` + `metadata_json.merged_into=<survivor_id>` on losers + keep
  `sources[]` on the survivor; update `dedup.ts` (it currently writes `'merged'`).
  *(done: one-line status fix; verified on the local DB — losers → duplicate+merged_into.
  `merged_into` was already written; loader's `status='upcoming'` filter excludes them.)*
- [ ] T033 [C] Add the `entity_sources` writes: one row per contributing
  `source_item_id` (UNIQUE upsert), `role`, `match_method`, `match_score`; survivor id
  stable. ⚠️ **BLOCKED on seed reality**: the seed loads no `source_items` (only
  events/places/media/sources), so `entity_sources.source_item_id REFERENCES
  source_items(id)` can't be satisfied from seed data. Needs a real ingest run (which
  populates `source_items`) OR a one-time `source_items` export added to the seed. Guard
  the insert on `source_item_id` present + `EXISTS(source_items)`.
- [ ] T034 [C] Backfill `entity_sources` for the 90 seed duplicates from
  `merged_into`+`source_item_id`. Note: the 90 rows ALREADY use
  `status='duplicate'`+`merged_into` (no status migration needed). Backfill is BLOCKED
  by the same missing-`source_items` issue as T033.
- [x] T035 [C] Deterministic strong-match pre-pass (exact url / `(source,external_id)`
  / resolved `maps_url` / person-URL) before fuzzy; same-person far-date → related
  link, not hard-merge (research C1/C5).
  *(PARTIAL — over-merge fixed: (1) Cyrillic→Latin transliteration in `titleSignature`
  (bare slugify mapped every RU title to "untitled" → 50 RU events fused); (2) `isMergeableGroup`
  requires ≥2 DISTINCT sources (same-source repeats = recurring occurrences → series, not dups)
  + refuses degenerate "untitled" signatures. Live result: 11 groups/64 false losers → **0**,
  idempotent (RUN1=RUN2=0). **DONE**: `strongMatchKey`/`strongMatchPrePass` collapse exact
  url / source-scoped `external_ref` BEFORE the fuzzy pass (4 tests; over-merge guards intact;
  idempotent — re-run excludes `status='duplicate'`). Deferred: same-person-far-date related link.)*
- [x] T036 [C] **Places dedup path**: `placeKey = nameSignature|area|category`,
  strong-match on `maps_url`/`external_id`, fuzzy name+category+geo, `recommended_by`
  union (research C2). *(PARTIAL — matching logic done + tested: `placeKey`,
  `arePlacesDuplicate` (strong maps_url/external_id + fuzzy JW≥0.9 + ≥1 corroborating
  signal). The DB orchestrator (status='duplicate'+merged_into writes + `recommended_by`
  union) is deferred to T064 place-mining — the seed's 14 places have no true duplicates,
  and places has no `status` column / render filter yet.)*
- [x] T037 [C] **Geo guard**: only `geo_source='map_url'` votes; centroid blacklist
  (Madrid Sol 40.4168,-3.7035); haversine R 75–120 m; never merge on geo alone
  (research C3). *(done: `haversineMeters` + `isCentroid` + `CENTROID_BLACKLIST`
  (Madrid Sol + València fallback) + `geoCorroborates`; nominatim coords never vote.)*
- [x] T038 [C] Insert `dedup` into `run.ts` right after `normalize` and expose via
  `refreshWorkflow`; ensure occurrences are NOT scanned. *(DONE for the offline
  `run.ts` path: `ingest → normalize → dedup → score → tag → geo` (enrich slots in at
  T050); dedup loads only the `events` table (status='upcoming'), so `event_occurrences`
  are never scanned. The `refreshWorkflow` exposure is part of T022.)* ⚠️ **earlier: DO NOT wire until
  hardening (T035–T037) lands**: a live run on seed data showed the first-pass
  fuzzy-only matcher OVER-MERGES (75 events → 11; `titleSignature` too aggressive) and
  is NOT idempotent (a 2nd run merged 1 more — violates FR-020/SC-003). **UPDATE: the
  over-merge + non-idempotency are now FIXED** (T035 partial: translit + cross-source +
  untitled guard → 0 false merges, idempotent). Remaining before wiring: T035 strong-match
  pre-pass, T036 places dedup, T037 geo guard — then this is safe to enable.
- [x] T039 [P] [C] Extend tests: places trio (ids 4/7/8) and Madrid-centroid trio
  (10/11/12) MUST NOT merge; pure-TS Jaro-Winkler + haversine unit tests.
  *(done: +5 tests in dedup.test.mjs — jaroWinkler, haversine/isCentroid,
  geoCorroborates, both trios NOT merged, genuine dups DO merge; 15/15 pass.)*

---

## Sub-area D: Recurring Events (FR-018, SC-009) — series + occurrences

- [x] T040 [D] `lib/pipeline/series.ts` `upsertSeries(series, occurrences[])`:
  idempotent upserts (unchanged schedule = 0 INSERTs, only `last_seen` bumps);
  series/occurrence `dedup_hash` per data-model identity. *(done: `seriesHash`
  (norm(title)|norm(venue)|source) + `occurrenceHash` (series_id|date|time) + injectable
  `upsertSeries`. Live-verified on local DB: re-run inserts 0 new series/occurrences and
  PRESERVES `enriched_at`/`score`/`notified` (ON CONFLICT updates only normalizer fields
  + last_seen); +2 unit tests, 17/17.)*
- [~] T041 [D] Rewrite `normalizers/hemisferic.ts` to emit 1 series + N occurrences
  (per-session granularity); mark old Hemisfèric `events` rows `status='superseded'`.
  *(DONE — normalizer rewrite: pure `buildHemisfericSeries` (film → series, day×session →
  occurrence) + `upsertSeries`. Live-verified on local DB: 3 raw rows → 2 series + 5
  occurrences, idempotent re-run processes 0; +2 unit tests (19/19). The "supersede the
  104 existing seed events" half is the T042 migration, which must land WITH the T043
  feed/calendar cutover (else Hemisfèric vanishes from the feed) — deferred together.)*
- [x] T042 [D] Migrate seed: 104 Hemisfèric `events` → 11 `event_series` + 104
  `event_occurrences` (regenerate from raw `source_items`); ~228 single-shot events
  untouched.
- [x] T043 [D] Feed + calendar cutover: feed UNIONs `events` ∪ `event_series` (JS sort
  by score); calendar buckets `event_occurrences` JOIN `event_series`; detail page
  shows full schedule; replace `is_hemisferic` with `is_series`/`occurrence_count`.
- [x] T044 [P] [D] `tests/series.test.mjs`: 104→11+104, idempotent re-run (0 new
  occurrences, `enriched_at` not reset), dedup skips occurrences (SC-009).

---

## Sub-area E: Card Enrichment (FR-008/021, SC-006/010) — Anthropic SDK

- [~] T050 [E] `npm i @anthropic-ai/sdk`; `lib/pipeline/enrich.ts` with
  `enrichOne(row,{client,web,exec})` + `enrichCards(limit,{dry,client,exec})`,
  injectable client; constrained decoding (`output_config.format`,
  `additionalProperties:false`, no min/max, `effort:low`); selection `WHERE
  enriched_at IS NULL ORDER BY score DESC NULLS LAST LIMIT $limit`; per-item try/catch
  (research E1/E2). *(DONE — orchestration: `EnrichClient` interface + `EnrichmentResult`
  schema + `enrichOne` (COALESCE-guarded promote + maps→links_json + enrichment_json +
  enriched_at) + `enrichCards` (selection + fail-soft + dry) + confidence thresholds.
  enrich.ts is SDK-FREE by design (mockable, key-free). Live-verified COALESCE: a
  model-null `venue_name` did NOT clobber the existing value. STILL TODO: the concrete
  Anthropic-SDK client (npm i + output_config.format + web tools) = T051–T053.)*
- [~] T051 [E] Implement the canonical `enrichment_json` schema (data-model E):
  OCR + RU translate + extract in one call (poster image block); persist whole blob +
  promote columns with `COALESCE` guards; `events` maps link → `links_json` entry.
- [x] T052 [E] Ground-or-flag anti-hallucination + confidence/notes/citations; model
  tiering (Haiku default, Opus on poster/low-confidence/conflict); enrich does NOT
  geocode (research E6/E7).
- [x] T053 [P] [E] Optional web augmentation behind `{web}` flag (`web_search` +
  `web_fetch`, two-turn shape, `max_uses:3`); offline app-fetch fallback +
  `claude -p` fallback path (research E5/R3).
- [x] T054 [E] Target series too: enrich runs once per `event_series` (not per
  occurrence); re-enrich trigger `enriched_at IS NULL OR last_seen > enriched_at OR
  force`.
- [ ] T055 [E] `app/workflows/enrich.ts` `enrichWorkflow(limit)` (per-card step
  fan-out) + `app/api/cron/enrich/route.ts` (Bearer, fail-closed) →
  `start(enrichWorkflow)`; NOT on the synchronous hot path.
- [x] T056 [P] [E] `tests/enrich-parse.test.mjs` (mocked client): field mapping,
  fail-soft (forced-fail item leaves base record valid), `COALESCE` guard,
  confidence/notes bounds (SC-006). *(done as `tests/enrich.test.mjs`: mock-client
  all-succeed / fail-soft (one bad card counted, batch continues) / dry / intBool;
  + live COALESCE verify on local DB — model-null venue_name preserved. 23/23.)*

---

## Sub-area F: Outputs & Surfaces (FR-009/010/011/015, SC-001/005/007)

- [x] T060 [F] Audit `app/page.tsx` + `lib/queries.ts`: feed excludes raw/ignored +
  `superseded`; "curated only" filter (score/normalized); UNION events ∪ series.
- [x] T061 [F] Confirm calendar defaults to current month (SC-005) and renders
  per-session occurrences; detail page prefers `title_ru`/`description_ru` +
  `links_json` clickable links (FR-011).
- [x] T062 [P] [F] Leaflet map plots events/places/series with `lat`/`lng`; hide
  marker-less cleanly.
- [x] T063 [F] **Places catalog** `app/places/page.tsx` with facet filters
  (cuisine/category, district/area, occasion, `price_level`, `recommended_by`); reuse
  `places/[id]`; renders independently of events (FR-015, Constitution III).
- [ ] T064 [F] Place-mining normalizers for place-rich sources (`rutatuta_vlc`,
  `logunespa`, `gosvetlanada`, Fever gastro) → `places`.
- [x] T065 [P] [F] `tests/feed-query.test.mjs` + `tests/place-categorize.test.mjs`
  (curated filter, current-month helper, occasion/price/cuisine inference).

---

## Sub-area G: Notifications (FR-012/013/014/021, SC-002/008)

- [~] T070 [G] `lib/pipeline/notify.ts`: `selectDigest({horizonDays, threshold})`
  (family-fit + `notified=0` + date window + `score≥threshold` +
  `confidence≥holdThreshold`) returning events/series + new places;
  `selectAlerts({alertThreshold})`. *(DONE — pure `selectDigest`/`selectAlerts` +
  `isFamilyFit` (excludes political news) + `cardConfidence` (null when un-enriched, so
  only enriched-low-confidence is held) + `addDays`/`withinHorizon` + `loadEventCandidates`;
  +5 tests (28/28). Live on seed: 295 un-notified → 59 digest / 53 alerts. STILL TODO:
  fold `event_series` + the "new places" block into the candidate set (T071 builder);
  tune the alert bar — 53 alerts means the seed's score-100 cluster trips 85, raise it.)*
- [~] T071 [G] `app/workflows/digest.ts` `digestWorkflow(mode)` (select→build→send→
  mark) + `app/api/cron/digest/route.ts` (Bearer, fail-closed; `?mode=weekly|alert`,
  `?dry=1`); on send set `notified`/`notified_at` + insert `notifications` row for
  events, series, and places (FR-013). *(DONE in notify.ts — `buildDigest`
  (load→select→render) + `renderDigestText` + `markEventsNotified`/`markPlacesNotified`
  + `loadNewPlaces`. Live-verified: mark → notified=1 + notified_at + notifications row,
  and the event drops out of candidates (no-repeat, SC-002). Route DONE:
  `app/api/cron/digest/route.ts` (POST, fail-closed Bearer, `?mode`/`?dry`) — marks
  notified ONLY when the transport delivered (dry-run sender ⇒ nothing consumed until a
  real transport lands). STILL TODO: Workflow wrapper (T022) + folding `event_series`
  into candidates.)*
- [x] T072 [P] [G] Pluggable `sendDigest(payload)` (default dry-run text); real
  transport behind an env flag (research G2). *(done: `DigestSender` type + `dryRunSender`
  default + `sendDigest({sender})`; real transport selected by env in the route.)*
- [x] T073 [G] Series digest renders the card + next upcoming occurrence
  (`MIN(occurrence_date) ≥ today`).
- [x] T074 [P] [G] `tests/digest-select.test.mjs` + `tests/alert-select.test.mjs`:
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

- [x] T090 [I] `promptfooconfig.yaml` (dev-only `promptfoo`) wrapping real `enrichOne`
  via custom-script provider; assertions `is-json`+Ajv, fuzzy date (±0), venue
  Levenshtein ≥0.85, `llm-rubric` RU-quality (Haiku grader ≥0.7).
- [x] T091 [P] [I] Golden fixtures `tests/fixtures/enrich/*.json` (10–25, keyed on
  series): Komissarenko, RU Telegram posts, an ES poster for OCR.
- [x] T092 [I] `npm run eval` script (key-gated, skipped when `ANTHROPIC_API_KEY`
  unset, excluded from CI default); keep mocked `npm test` fully offline.

---

## Phase 10: Polish & Cross-Cutting

- [~] T100 [P] Fail-closed `CRON_SECRET` (401 when unset/mismatched) on all new
  `app/api/cron/*` routes (Constitution V; was a convergence gap). *(done for
  `/api/cron/digest` (POST, 401 when secret unset OR mismatched). Apply the same to
  `/api/cron/dispatch` (T013) and `/api/cron/enrich` (T055) when they land; legacy
  `/refresh` keeps its optional guard.)*
- [x] T101 [P] Add the spec-named but unconfigured sources to `sources.json` +
  ingest: `elcontacto.ru`, `russpain`, `eventbrite` (enabled), `SpainNewsOnline`
  (`enabled=0`/`weight=off`) — FR-001.
  *(done: 4 rows appended to `data/seed/sources.json` (ids 24–27, now 27 sources /
  25 enabled): `web:elcontacto` (RU community, good), `web:russpain` (RU agenda, good),
  `web:eventbrite` (ticketing, good) all `enabled=1`; `web:spainnewsonline`
  `enabled=0`+`weight="off"` (political news, excluded by default per spec.md curation;
  notify EXCLUDE already filters 'spainnews'). NO new parser/normalizer needed —
  `resolveParserKey` routes web/ticketing through `parseGeneric`, and unregistered
  normalizers mark raw items `ignored` (append-only). Cadence auto-seeded by
  `seedCadence()` at db:setup; new rows have null `last_fetched` → picked on first
  dispatch. JSON valid, column-consistent; build green, 124/124.)*
- [x] T102 [P] Run `quickstart.md` validation scenarios end-to-end. *(DONE — full E2E on the
  live local stack (Docker Postgres + Neon HTTP proxy, prod `next start`): stack up + seed clean
  (406 events / 11 series / 104 occurrences / 65 places / 27 sources / 216 media; series migration
  idempotent, 0 hemis rows leaked). All core routes **200 + non-empty**: `/` (feed + calendar +
  Leaflet map w/ real coords), `/places` (65 venues), TWO series detail pages (recurring cutover
  renders a per-day session schedule), an individual event detail. Server log clean, 0 errors/500s.
  Only non-200 = `/api/health` 503 — BY DESIGN on a seed-only DB (no pipeline run on record); all
  counts healthy. Cleanup done. 2 non-blocking findings → T143 (health/smoke ergonomics) + T135
  (14/65 places mapped).)*
- [~] T103 [P] Update `WORKBOARD.md` Done/Next; `npm run build` + `node --test tests/`
  clean; tidy dead code. *(DOC HALF DONE: WORKBOARD.md reconciled against the actual tasks.md
  markers — Done/Next/Blocked refreshed + over-claims corrected to match `[~]` partials
  (T041/T050/T070/T071). Build+test sweep is green each tick. Dead-code tidy deferred to final polish.)*

---

## Remaining source normalizers (cross-cutting, feed A/F — one source per iteration)

> Each: normalizer module + `NORMALIZER_REGISTRY` entry + `npm run pipeline:run`
> parity check + build green. Prime parallel/loop fodder.

- [x] T110 [P] worldafisha · T111 [P] valenciarusa · T112 [P] vidacultural_Valencia
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

---

## Backlog — user inbox

> Ad-hoc requests land here as tasks; the `/speckit-implement` loop picks them up in
> turn (no need to interrupt mid-iteration). Prefix a message with `бэклог:` / `backlog:`
> to mean "record only, don't drop everything."

- [x] T141 [A/I] **Live-ingest real sources → `source_items` for normalizer debugging**
  (user PERMISSION, 2026-06-21: "технически у нас нет ограничений стянуть из интернета источники
  и занести их в БД как raw source для дальнейшей отладки нормализаторов, разрешаю это делать").
  Fetch REAL source content from the internet and load it into the **local** DB as raw, append-only
  `source_items`, so normalizers can be debugged against REAL data instead of synthetic fixtures.
  This DE-SPECULATES normalizer work and UNBLOCKS **T033/T034** (`entity_sources` writes need real
  `source_items`) + **T136** (live worldafisha≈concerten dedup). Plan: `db:local:up` → run the existing
  dispatcher/ingest stage (`/api/cron/dispatch` or the ingest stage of `scripts/run-pipeline.mjs`) over a
  SUBSET of enabled sources to populate `source_items` (conditional-GET + paced fetches already wired) →
  run normalize→dedup→… and inspect real output → fix normalizers against real rows. Keep it to the LOCAL
  DB for debugging (not prod).
  *(DONE 2026-06-21 — live ingest VERIFIED: `ingestAll()` one polite pass → **890 `source_items`**
  (20 sources ok; 5 err → T147/T148); `normalizeAll()` → **42 events** from REAL data (valenciarusa 20 /
  vidacultural 10 / concerten 5 / valenciabonita-tg 5 / worldafisha 2; hemisferic idempotent). DB PERSISTS
  (no teardown). `source_runs` populated (21 ok) → /api/health should now pass (T143 likely auto-closes).
  Quality findings → **T145–T148**.)*

- [ ] T142 [F] **rutatuta_vlc excursions → distinct colour** (user, `backlog:`). Posts from
  `tg:rutatuta_vlc` are guided EXCURSIONS — they differ from "бездушные общие мероприятия", so give them
  their own visual accent in the feed/calendar (the way feria/festival got a gold accent in **T133**).
  Extend T133's `featureKind` (feria|festival|hemisferic|null) with an `excursion` kind derived from the
  `tg:rutatuta_vlc` source / tags, plus a distinct accent colour + legend entry. Needs the rutatuta_vlc
  normalizer (place/event mining — relates to T064); pairs well with **T141** (real data to verify it).

- [ ] T143 [I] **`/api/health` + `npm run smoke` ergonomics on a seed-only DB** (found by the T102
  E2E run). `pipelineWarnings()` HARD-fails (`ok=false` → 503) when there is "no successful pipeline
  run on record" (`source_runs` empty), so on a freshly-seeded local DB the smoke gate can NEVER pass
  even though all row counts are healthy. Options: (a) demote "no pipeline run on record" to a
  soft/INFO warning when counts are otherwise healthy (keep it a HARD fail on prod where a run is
  expected), (b) seed a synthetic `source_runs` success row in `db:local:setup`, or (c) document that
  a local seed-only health-fail is expected and gate `smoke` on row counts. Likely auto-resolves once
  **T141** live-ingest populates `source_runs`. Low severity; not a render/crash bug.

- [~] T144 [A/E/I] **Local-first data baking → seed; prod = incremental-only** (user, `backlog:`,
  2026-06-21 strategy). Do ALL the heavy lifting LOCALLY and bake the result into `data/seed/`, so
  PROD ships PRE-POPULATED and afterwards collects only INCREMENTAL updates — minimizing AI/compute
  on the server. Concretely: run ingest → normalize → dedup → score → tag → **enrich** (the costly
  `claude -p`/SDK steps) for ALL sources on the LOCAL stack; gradually + politely download all
  available data from every source (builds on **T141**); then EXPORT the normalized + enriched events
  / places / series / occurrences / media (and ideally a `source_items` snapshot + conditional-GET
  cursors/ETags) into `data/seed/` so `db:setup` on prod loads real, enriched data. Prod then runs
  ONLY incremental refresh (conditional-GET 304 skips unchanged; enrich only NEW cards). "Что можем
  прогнать локально — гоним локально." Decompose (triage later): (1) seed-export tooling (dump
  enriched DB → `data/seed/*.json`), (2) bulk local ingest of all sources, (3) local enrich pass,
  (4) prod incremental-only mode. Relates to T141, T050–T056 (enrich), append-only `source_items` +
  cadence/conditional-GET (already built). Likely warrants its own sub-area / triage decomposition.
  *(PART 1 DONE: `scripts/export-seed.mjs` (`npm run export-seed`) — read-only SELECT dump of the live DB
  → seed JSON shape; round-trips via `db:setup`; defaults to scratch `data/seed-export/`, `--commit` →
  `data/seed`. Mirrors `seed.mjs` columns incl. enrich fields; series/occurrences re-derived by
  `db:migrate:series`. Remaining: bulk-ingest-all + local enrich pass + prod incremental-only mode.)*

- [x] T145 [A] **`parseEventDate` fails on real RU/UK date formats** (T141 finding, HIGH). On real
  ingested posts most events get `start_date=null` (worldafisha 53 / valenciarusa 20 / vidacultural 12 /
  valenciabonita-tg 5). The dates ARE present — "МАР 18 19:00", "16 декабря", "30 ноября", "18 марта 2027",
  "23 липня" (Ukrainian) — but the parser doesn't recognise RU/UK month names + abbreviations. Date is the
  core of an afisha → top quality fix. Extend `parseEventDate` (worldafisha.ts, shared) with deterministic
  RU + UK month parsing (full names + abbrevs МАР/ДЕК/…, "DD месяц [YYYY]", "месяц DD"); test against the
  real strings; then re-normalize. Deterministic JS only (T140).
  *(DONE 2026-06-21 — `parseEventDate` rewritten: RU nominative+genitive months + 3-letter abbrevs (any
  case) + UK months (липня=July, грудня=Dec…) + numeric DD.MM/DD-MM + BOTH day-first and month-first word
  order; year-inference = next occurrence on/after `today` (month AND day); fixed a /u-flag `\b` bug that
  skipped leading Cyrillic via a Unicode lookbehind. Signature preserved; flows to ALL normalizers reusing
  it. 16/16 worldafisha tests, 155/155 total, build green. **Verified END-TO-END on the live DB**: deleted
  the 44 stale-parser events, reset `source_items`→pending, re-`normalizeAll()` → **35/44 events now dated**
  (was ~null). KEY FINDING for **T144**: the SEED's `events.json` was itself built with the OLD parser, so
  it carries stale null-dates — the local-first re-bake must re-normalize with this fixed parser. The local
  DB was restored to the canonical seed afterwards; the 898 raw `source_items` persist.)*

- [ ] T146 [A] **Web normalizers ingest junk "events" (nav/contact/list cruft)** (T141 finding). The
  generic web parse + valenciarusa normalizer emit non-events: title `info@valenciarusa.es`, venue
  `valenciarusa.es info@…`; real titles carry a date prefix + "VB" cruft. Add an event-vs-chrome guard
  (drop contact/nav/footer cards) + title cleanup (strip leading date tokens + trailing source tags). Also
  a concerten meta-post ("Добавили на сайт 16 событий…") slipped past `looksLikeEvent`.

- [ ] T147 [A] **`tg:rutatuta_vlc` ingest fails — Neon "unexpected end of hex escape"** (T141 finding).
  `ingestSource('tg:rutatuta_vlc')` errors on INSERT: `could not parse the HTTP request body: unexpected
  end of hex escape` — a special char/encoding in the post content breaks the parameterised query over the
  Neon HTTP proxy. Blocks ALL rutatuta data (and T142). Sanitise the raw content before insert; reproduce
  on the offending post.

- [ ] T148 [A] **`web:cac_*` (4 sources) fetch failed** (T141 finding). `web:cac_agenda/exposiciones/
  actividades/museu` all returned `TypeError: fetch failed` (cac.es). Investigate TLS/HTTP2, bot-block, or
  transient; may need a real User-Agent / retry / timeout tuning. 4 of 25 sources currently yield no data.

- [ ] T149 [D/F] **Hemisfèric display — duplicates + "10 films/day" look wrong** (user, `backlog:`).
  Re-verify the Hemisfèric series/occurrences render: the user sees apparent DUPLICATES and "как будто
  кожен день по 10 фільмів" which shouldn't be. Check `event_occurrences` per series (should be 104 occ /
  11 series), the feed (ONE card per series), calendar bucketing (`.day-hemis`), and whether a re-ingest/
  re-normalize created duplicate series/occurrences. Likely an occurrence-explosion or a series-dedup gap.

- [x] T150 [A] **worldafisha: recover date from the event URL slug + drop /persons/ non-events** (T141
  finding). worldafisha `source_items` carry only the title in `raw_text` (no date) → 79/80 null-dated.
  But the event URL encodes the date: `/event/aleksandr-gudkov-valensiya-2026-11-09` → 2026-11-09. Also
  many entries are `/persons/<artist>` artist pages (NOT events) → drop them. Fix the worldafisha
  normalizer: parse the date from the `url` slug (deterministic regex, T140) + keep only `/event/` URLs.
  *(DONE 2026-06-21 — `dateFromUrl(url)` extracts the trailing YYYY-MM-DD from `/event/` slugs (preferred
  over `parseEventDate(text)`); `isEventUrl` gate drops 57 non-events (56 `/persons/` + 1 index); `cancelled`
  flag on "(отменен)". Measured on live data: 23/23 `/event/` dates recovered (was 0/23 from text). 25/25
  worldafisha tests. **Surfaced → T153**: spain-filter doesn't match Latin-translit city slugs so 21/23
  Valencia/Alicante events are still dropped at the Spain gate.)*

- [x] T151 [A] **Fever normalizer (~81 items)** (T141 finding). `web:fever` had NO normalizer so its raw
  items were ignored. *(DONE 2026-06-21 — `lib/pipeline/normalizers/fever.ts` (`buildFeverEvents` +
  `normalizeFever`, registered). CORRECTED the brief's wrong premise: fever `raw_text` carries NO ISO
  datetime — it's a flattened card string `<venue> <show> [<rating>] <day mon>[ - <day mon>] [Desde] <NN,NN> €`
  with SPANISH dates ("4 jul", "5 dic - 6 feb"). Deterministic parse: strip rating/date/price tail + rank
  prefix → head, split a known Valencia venue, parse "4 jul"→ISO (+range end, cross-year wrap), "Desde
  17,50 €"→price. Drops nav anchors / snapshot / gift-card+waitlist. Live: 45 events emitted / 35 dated.
  13/13 tests. Idempotent ON CONFLICT(dedup_hash).)*

- [ ] T152 [A] **Relative-date parsing for ES telegram (`este fin de semana`, `este mes`)** (T141 finding).
  valenciabonitatelegram posts use relative Spanish dates ("este fin de semana", "este finde", "este mes",
  "hoy"/"mañana") → 15/17 null-dated. Optionally resolve them against the post date (source_item `last_seen`)
  to a concrete weekend/month start. Fuzzy; lower priority than T150/T151.

- [ ] T153 [A] **spain-filter: recognise Latin-transliterated city slugs** (T150 finding, HIGH for
  worldafisha yield). `spain-filter.ts` matches Latin `madrid`/`malaga` + Cyrillic, but NOT the Latin
  TRANSLITERATIONS used in worldafisha URL slugs / RU posts: `valensiya`, `barselona`, `marbelya`,
  `alikante`, `sevilya`, `malaga`(ok)… → 21 of 23 real worldafisha Valencia/Alicante events are dropped at
  the Spain gate even after T150 recovers their dates. Add translit variants to `hasSpainSignal` city stems
  (deterministic, T140). Lifts worldafisha (and any translit-slug source) from ~2 to ~23 kept events.

- [~] T130 [F] **logunespa historical place crawl → seed** (user priority; DELEGATED to a
  background subagent so the main loop keeps moving through the plan — places-only,
  20 posts/batch, resumable backward; agent commits/pushes each batch). Walk the
  channel post-by-post via the PUBLIC single-post embed `t.me/logunespa/<n>?embed=1`
  (no login — same public-preview principle as `t.me/s/`), from the newest (~1800)
  **backward to the start, SLOWLY** (politeness delay, resumable). Per post:
  - structural parse (RELIABLE): message text, `cdn4.telesco.pe` photo(s), outbound
    links incl. **`maps.app.goo.gl`**, hashtags;
  - `claude -p` extract (free-form RU needs the LLM — heuristic name/area validated as
    unreliable on posts 1799/1795): `{is_place, name, area/address, category,
    description_ru, price?}`;
  - dedup + write place candidates to `data/seed/places-logunespa.json` (recommended_by
    = logunespa); geo then resolves the maps links to coords → map pins.
  Build: `lib/pipeline/telegram-post.ts` (parse) + `scripts/crawl-telegram.mjs` (paced
  crawler). Validated extraction shape on posts 1800/1799/1795.
- [x] T132 [A/F] **Fever extractor — drone show missing** (user). The Fever event pages
  (DroneArt Show "next Saturday", Harry Potter) aren't ingested — no Fever extractor yet.
  Fetch individual Fever event pages → events (date/venue/price/poster). Per FR-001/T118.
- [x] T133 [F] **Special-event color categorization** (user). *(done: `feature` field on
  SiteEvent via `featureKind` (feria | festival | hemisferic | null) from source/tags/
  category; gold `--feria` accent for feria/festival on feed cards + calendar day-events
  + legend entry; Hemisfèric stays purple. Extensible per-kind. featureKind verified:
  web:feriadejuliovlc→feria, fireworks→festival, ordinary→null. 33/33, build green.)*
- [ ] T134 [F] **Design polish via design MCP** (user, `backlog:`). Tidy the whole UI
  design using the available design MCP (Vercel `import-claude-design-from-url` /
  `deploy_to_vercel`, or Figma) — proper visual design beyond the first-prototype CSS.
  Out of scope for the minimal CSS pass; do a dedicated design iteration.
- [~] T135 [F] **Informative map popups** (user, `backlog:`). Map markers are currently
  uninformative (often the raw maps-link as the name). Each popup needs a HUMAN-READABLE
  title + a short "why-go" tagline (e.g. "бассейн в парке", "лучшие бургеры") so it's
  clear why you'd go. Two parts: (1) ensure clean `name` + a short `tagline`/`description`
  (the logunespa `claude -p` crawl already produces these — backfill resolves the
  maps-link-named places; enrich fills the rest); (2) richer popup template in
  `Home.tsx` MapPanel (`name` + tagline + category, not just name + location).
  *(PART 2 DONE: `placePopupHtml`/`eventPopupHtml` — readable title (falls back to
  category when the name is still a raw maps link) + category chip + "why-go" excerpt +
  location, HTML-escaped, + popup CSS. PART 1 (clean names/taglines) flows from the
  logunespa crawl + enrich — ongoing.)*
  *(PART 1 GEO DONE — DETERMINISTIC, no LLM: place names are already non-URL (0 raw-URL
  names in the seed). Coordinates resolved + BAKED into `data/seed/places-logunespa.json`
  via `scripts/bake-place-geo.mjs` + `lib/pipeline/geo.ts` `resolvePlaceGeo`/`mapsAddressQuery`
  — follow `maps.app.goo.gl` redirect → geocode the STREET ADDRESS (the maps `q=` leads with
  the venue NAME, which fooled Nominatim into the city-centre fallback centroid; the bare
  address resolves to the exact venue). `isCentroid` guard rejects fallback hits (better null
  than a fake pin). Result: **46/51 places mapped** (was 14), persisted to seed → prod map
  renders deterministically without a slow geocode at db:setup. Same fix improves the LIVE geo
  stage (it was also producing centroids). 5 unresolved stay null. Remaining: short "why-go"
  taglines (enrich/haiku) + a couple of mis-geocoded outliers (e.g. MuVIM) to nudge.)*
- [x] T131 [A] **concerten — Spain-only pre-filter** (user). The channel ALREADY exists
  as `tg:concerten` ("Зарубежная афиша русскоязычных артистов") — it lists RU-artist
  tours across ALL of Europe, so normalize/ingest must pre-filter to Spain. *(DONE —
  pure `lib/pipeline/normalizers/spain-filter.ts`: `isSpainEvent`/`hasSpainSignal`/
  `hasNonSpainSignal` with ES+RU city/region/España signals (Valencia/Madrid/Barcelona/…),
  keeps only explicit-Spain items (drops non-Spain + location-less to avoid overload);
  +3 tests (36/36). **WIRED (this tick)**: `lib/pipeline/normalizers/concerten.ts` gates every
  post through `isSpainEvent` + `hasNonSpainSignal` at normalize time — symmetric to worldafisha;
  drops Europe-wide tours + location-less posts; `spainCity` picks the actual matched ES city.
  9/9 offline tests, registered in `NORMALIZER_REGISTRY`.)*
- [~] T136 [A] **worldafisha ≈ concerten overlap → dedup** (user, `backlog:`). Both
  sources ALREADY exist: `web:worldafisha` (id 9, `https://worldafisha.com/events/ispaniya`)
  and `tg:concerten` (id 2) — both are the same "Зарубежная афиша" RU-artist-tours feed,
  so they list the SAME concerts. No new source to add. The actionable part: cross-source
  **dedup must treat them as overlapping** — a concert appearing in both gets merged into
  ONE event that keeps links to BOTH sources (constitution: dedup keeps every source link).
  Verify `lib/pipeline/dedup.ts` `titleSignature` + ≥2-source `isMergeableGroup` already
  collapses these (artist name + date + Spanish city), and that the merged record carries
  both `entity_sources` rows. Add a focused test once both normalizers (T112) land.
  *(VERIFY-HALF DONE: `tests/dedup.test.mjs` "T136: worldafisha ≈ concerten PAIR" — the
  exact 2-feed pair (`web:worldafisha`+`tg:concerten`, same RU-artist tour, differing
  title framing) collapses to ONE survivor that KEEPS both source links; proves the
  ≥2-distinct-source threshold triggers on the pair alone. 118/118. LIVE wiring still
  pending: the concerten normalizer now EXISTS (this tick) — live worldafisha≈concerten dedup
  awaits real `source_items` rows in the DB to exercise `entity_sources`.)*
- [x] T137 [B] **Drop deprecated `fetchConnectionCache`** (user, `backlog:`). `lib/db.ts:3`
  sets `neonConfig.fetchConnectionCache = true;` — in current `@neondatabase/serverless`
  this option is DEPRECATED (connection caching is always on now), so the line is a
  no-op that only emits a deprecation warning. Fix = delete the line (and any stray docs
  mention). Trivial + zero-risk; verify `npm run build` + a local DB connect still work.
- [x] T138 [B/I] **Production verification / health-check** (user, `backlog:`). Design how we
  confirm the prod pipeline is OK end-to-end: (1) a `/api/health` (or `/api/cron/*?dry=1`)
  route returning pipeline freshness — last `source_runs.finished_at` per source, last
  successful dispatch/refresh/digest, row counts (events/series/places), and stale-source
  flags; (2) post-deploy smoke (GET `/`, `/places`, a detail page → 200 + non-empty);
  (3) the cron routes are fail-closed (Bearer) — verify they reject unauthenticated and
  succeed authenticated; (4) since the enrich engine is `claude -p` (subscription) it is
  ABSENT on Vercel serverless — prod enrich must use the SDK path OR run enrich off-prod;
  the health-check should surface "enrich stalled" without failing the site. Decide
  alerting (the existing weekly digest/rare-alert vs a dedicated health ping).
- [x] T139 [E/I] **`claude -p` model tiering → cost optimization** (user, `backlog:`).
  Both `claude -p` callsites (`enrich-client.ts`, `crawl-telegram.mjs`) ran WITHOUT
  `--model`, inheriting the session default (likely opus — priciest tier); worse,
  `enrich-client`'s `model` opt only recorded an audit string, it never reached the CLI.
  **Eval done** (background subagent, 6 calls: opus/sonnet/haiku × translation/grounded):
  PATH A (RU translation) — **haiku is SAFE** (all 3 correct + natural; haiku fastest 8s).
  PATH B (grounded WebFetch extraction) — **sonnet is the floor, haiku is NOT** (on a dead
  source link haiku returned all-null and gave up; sonnet/opus self-recovered to the real
  page + cited grounded facts; opus only marginally better, not worth the cost). **Code
  done**: `enrich-client.ts` now picks per-path — `pickEnrichModel(web)` → haiku
  (translation) / sonnet (grounded); `opts.model` pins both; env `ENRICH_MODEL` /
  `ENRICH_MODEL_WEB` override per path; the audit `model` now records the ACTUAL per-call
  model. Crawler default `sonnet` (grounded; env `CRAWL_MODEL`). **CRITICAL FIX the eval
  surfaced**: in `-p` (non-interactive) mode WebFetch is BLOCKED without
  `--allowedTools WebFetch` — the model just asks for permission and returns no JSON, so
  the T053 web-grounding (and the crawler's link-following) were SILENTLY broken. Both now
  pass `--allowedTools WebFetch` when grounding (pure `buildClaudeArgs` helper, tested).
  120/120, tsc=0. (Caveat noted: PATH B latency 46s sonnet / 68s opus → keep timeouts
  ≥120s, already 240s. A future eval could test haiku for link-LESS crawler posts.)
- [ ] T140 [cross-cutting] **"JS before LLM" cost rule** (user, `backlog:`, standing
  principle). Everywhere data can be extracted DETERMINISTICALLY (keywords, regex,
  URL/HTML parsing, HTTP redirects, geocoding) — use plain JS, NOT a `claude`/LLM call.
  Reserve the LLM for what only it can do, cheapest tier first: **haiku** for specific/
  simple things (RU translation), sonnet only for genuine grounding/reasoning (see T139).
  Already applied: T135 geocoding moved from an LLM guess to deterministic maps-redirect +
  Nominatim parsing. **Audit candidates** for de-LLM-ing or downgrading to haiku: the
  crawler's `claude -p` extraction (much of name/area/category/price is rule-parseable from
  the post + maps `q=` — reserve the LLM only for the RU description / ambiguous classify);
  enrich fields that are pure copies/parses. Saved as a feedback memory (`prefer-js-over-llm`).
