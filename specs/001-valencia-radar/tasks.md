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
- [x] T033 [C] Add the `entity_sources` writes: one row per contributing
  `source_item_id` (UNIQUE upsert), `role`, `match_method`, `match_score`; survivor id
  stable. *(DONE 2026-06-21 — UNBLOCKED by the live ingest (898 real `source_items`). Pure
  `entitySourceRows(survivor, members, method)` (survivor `role='primary'/'self'`, losers
  `'duplicate'`+`'strong'`/`'fuzzy'`; skips members w/o `source_item_id`; DB-free, +4 tests) +
  idempotent FK-safe `writeEntitySource` (`INSERT … SELECT … WHERE EXISTS(source_items) ON
  CONFLICT DO UPDATE`) — a dangling/seed-only `source_item_id` is a silent no-op (offline/seed
  path safe, PROVEN: id 9999999 → no error, no insert). Wired into BOTH merge paths; merge
  logic + over-merge guards (T035/T141/T156) UNCHANGED. Live DB: entity_sources 0→1, FK holds,
  idempotent re-run. 301/301, build green.)*
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

- [x] T142 [F] **rutatuta_vlc excursions → distinct colour** (user, `backlog:`). Posts from
  `tg:rutatuta_vlc` are guided EXCURSIONS — they differ from "бездушные общие мероприятия", so give them
  their own visual accent in the feed/calendar (the way feria/festival got a gold accent in **T133**).
  Extend T133's `featureKind` (feria|festival|hemisferic|null) with an `excursion` kind derived from the
  `tg:rutatuta_vlc` source / tags, plus a distinct accent colour + legend entry. Needs the rutatuta_vlc
  normalizer (place/event mining — relates to T064); pairs well with **T141** (real data to verify it).
  *(DONE 2026-06-21 — turned out to be DATED EVENTS, not places. (A) `lib/pipeline/normalizers/rutatuta.ts`
  (mirror vidacultural/concerten; `category='excursion'`, Valencia/RU, parseEventDate handles "17 июня") +
  registered; 17 source_items → 6 excursions w/ dates+prices; 7 tests. (B) `featureKind`→`'excursion'` for
  `tg:rutatuta_vlc`/`category='excursion'` + teal accent `--excursion:#0f8a7e` on feed cards + calendar +
  legend entry "экскурсии". **BONUS: 2 shared-helper bugs fixed** — `parsePrice` trailing-`\b` dropped EVERY
  `€10`/`25 евро` price for ALL telegram normalizers; `parseEventDate` numeric branch read a duration
  "1,5-2 часа" as a date. Both regression-free, 316/316. NOTE: these fixes improve prices/dates across all
  normalizers → a seed re-bake (T160) would capture the now-parsed prices/dates on existing events.)*

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

- [x] T146 [A] **Web normalizers ingest junk "events" (nav/contact/list cruft)** (T141 finding). *(DONE
  2026-06-21 — deterministic `isJunkCard(title, body, sourceName?)` in valenciarusa.ts, reused by
  vidacultural.ts: drops bare email/@handle, nav/legal labels (Контакты/Подписаться/Войти/Правовая
  информация/Política/Cookies RU+UK+ES+EN), bare channel-header lines, "pinned a photo/message" (strips
  `499 views 15:28`/`25°` chrome first). Live: valenciarusa 22→19, vidacultural 17→10; 0 real events lost.
  16 tests. Pre-existing parsePrice trailing-"40 €" quirk noted, out of scope.)* — original finding:
  generic web parse + valenciarusa normalizer emit non-events: title `info@valenciarusa.es`, venue
  `valenciarusa.es info@…`; real titles carry a date prefix + "VB" cruft. Add an event-vs-chrome guard
  (drop contact/nav/footer cards) + title cleanup (strip leading date tokens + trailing source tags). Also
  a concerten meta-post ("Добавили на сайт 16 событий…") slipped past `looksLikeEvent`.

- [x] T147 [A] **`tg:rutatuta_vlc` ingest fails — Neon "unexpected end of hex escape"** (T141 finding).
  `ingestSource('tg:rutatuta_vlc')` errors on INSERT: `could not parse the HTTP request body: unexpected
  end of hex escape` — a special char/encoding in the post content breaks the parameterised query over the
  Neon HTTP proxy. Blocks ALL rutatuta data (and T142). Sanitise the raw content before insert; reproduce
  on the offending post.
  *(DONE 2026-06-21 — ROOT CAUSE: `parseTelegram` does `title.slice(0,200)`, which cut mid-emoji and left a
  LONE HIGH SURROGATE (U+D83D) that can't be UTF-8-encoded → the Neon HTTP driver fails serialising it.
  FIX: pure `sanitizeText()` in `util.ts` (strips lone surrogates + C0/C1 controls except TAB/LF/CR + DEL +
  BMP noncharacters), applied in `upsertSourceItem` to every text field written (INSERT+UPDATE); `dedup_hash`
  still from the raw item (identity unchanged). General ingest-robustness fix. Live: rutatuta now ingests
  (17 parsed / 8 new rows), idempotent, logunespa regression ok, clean RU+emoji preserved. +8 tests, 309/309.
  rutatuta data now flows → unblocks T142 (still needs a rutatuta normalizer + the excursion accent).)*

- [x] T148 [A] **`web:cac_*` (4 sources) fetch failed → FIXED (incomplete TLS chain)** (T141 finding).
  Root cause was NOT bot-block/404/transient: cac.es serves an INCOMPLETE TLS cert chain (missing
  intermediate CA) → Node's `fetch`/undici rejects with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` (curl tolerates
  it via the system CA bundle). FIX (`lib/pipeline/util.ts`): a per-host `INSECURE_TLS_HOSTS` allowlist
  (`cac.es` only) + pure `needsInsecureTls(url)` selector; allowlisted hosts bypass undici for a built-in
  `node:https` GET with `rejectUnauthorized:false` (follows redirects, keeps conditional-GET/UA/timeout) —
  NOT a global TLS weakening. Live re-ingest: 4/4 sources OK http 200 → **113 source_items**
  (actividades 38 / agenda 24 / exposiciones 21 / museu 30); `source_runs` all `ok`. 6 focused
  `needsInsecureTls` tests (no network). NB: no cac normalizer yet → these normalize to `ignored` (→ T177).
  **HARDENED (user decision, 2026-06-23):** replaced the `rejectUnauthorized:false` bypass with the missing
  intermediate CA BUNDLED in-repo (`certs/cac-es-intermediate.pem`, `PerfectSSL`, valid → 2034) and added to
  the trust list (`ca: [...tls.rootCertificates, intermediate]`); renamed `INSECURE_TLS_HOSTS`→`EXTRA_CA_HOSTS`
  / `needsInsecureTls`→`needsExtraCa`. TLS verification now stays FULLY ON (`rejectUnauthorized:true`, default —
  `false` gone everywhere). VERIFIED functionally: a bare `fetch` still fails `UNABLE_TO_VERIFY_LEAF_SIGNATURE`,
  the patched `fetchText` returns 200 (253KB/545KB) — proving the bundled CA (not a disabled check) is what
  works. cert force-tracked past the `*.pem` ignore via a `!certs/*.pem` exception (it's a public CA, needed at
  runtime). build 0, tests 389/389.

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

- [x] T153 [A] **spain-filter: recognise Latin-transliterated city slugs** (T150 finding, HIGH for
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

- [~] T144-norms **10 remaining event normalizers built + wired** (palau/ticketmaster/songkick/
  visitvalencia/hoyvalencia/eventbrite/laganzua/lacotorra/elcontacto/russpain). *(DONE: all 10 built
  against REAL live data, registered in `NORMALIZER_REGISTRY` (17 total), 289/289 tests, build green.
  Real-data measure: 709 raw → 367 events, 239 dated (65%). GOOD: palau 10/10, ticketmaster 28/28.
  Quality issues → T154.)*

- [ ] T154 [A] **Fix the suspicious new normalizers (real-data quality)** (T144-norms finding). The 10
  new normalizers pass synthetic tests but several misbehave on REAL data (adversarial verify died on the
  session limit): **visitvalencia** 56 events / 0 dated (dates not parsed), **lacotorra** 8 raw → 56 events
  (explosion?), **laganzua** 1/47 (over-filter), **eventbrite** 7/61 (low yield), **elcontacto** 0/3 +
  **russpain** 0/4 (RU sites, 0 events). Diagnose each on live `source_items` + fix the parser
  deterministically; drop chrome, parse real dates, don't fabricate. Then re-measure + adversarial-verify.
  (songkick 8-dated/26 + hoyvalencia 38/76 have plausible explanations — verify if time permits.)

- [ ] T155 [C] **Verify dedup post strongMatchKey-fix — no under-merge** (user, `backlog:`). After the
  bake found strongMatchKey over-merging multi-event-per-page sources (lacotorra 56→1) and the key was
  tightened to `url|titleSignature|start_date`, CONFIRM the opposite failure didn't appear: genuine
  duplicates must STILL collapse (the fuzzy pass: titleSignature + date-window + ≥2-distinct-source), so
  events don't PROLIFERATE. Empirically re-run dedup on the live DB + check (a) lacotorra ~56 survive
  (over-merge gone), (b) known cross-source dups still merge to one (e.g. worldafisha≈concerten,
  ticketmaster≈songkick same concert). ("убедись после фикса что дедуп работает и дубли не наплодятся".)

- [x] T156 [C] **dedup over-merges same-source curated events (feria)** (found during the bake). Running
  `dedup()` on the live DB collapsed 41 of 43 `web:feriadejuliovlc` events into 2 (they are 43 DISTINCT
  festival events from ONE source). The `isMergeableGroup` ≥2-distinct-source guard should refuse to merge
  same-source events (recurring/series, not dups) — investigate why feria slips through (strong pre-pass on
  a shared key? fuzzy pass guard gap?) and fix. Sidestepped for the seed bake (curated taken from their
  files), but the LIVE pipeline would over-merge feria on prod. Pairs with T155.
  *(DONE 2026-06-21 — ROOT CAUSE was NOT venue/geo (event dedup has NO geo path; centroid was a red
  herring): the 41 DB duplicates are STALE artifacts of the OLD url-ALONE `strongMatchKey` (the 43 feria
  events share just 2 URLs → 2 strong groups → 41 collapsed). Already fixed by the T141 `url|titleSignature|
  start_date` key (verified: 43 distinct keys → 0 merges). HARDENED on top: `isStrongCollapsible(group)`
  gates the strong pre-pass with the ≥2-distinct-source rule (cross-source OR same-source+real-title =
  genuine re-fetch; same-source untitled groups RELEASED to the fuzzy pass, none dropped). 20/20 dedup tests
  (+2 T156); regression confirmed — worldafisha+concerten still merges, lacotorra survives. The live DB
  still shows the 41 stale dups (read-only verify) — cleared on the next clean re-bake (T157).)*

- [x] T157 [C] **Run geo on the baked seed events (lat/lng for the map)** (bake follow-up). The seed bake
  ran normalize→dedup→score→tag but SKIPPED geo (Nominatim, slow/network). So the 239 freshly-baked
  events.json rows have null lat/lng → not on the map (they DO show in feed/calendar by date). Run
  `geoEnrich` over them (paced) + re-export, OR let the live pipeline fill geo. Deterministic geo per T135.
  *(DONE 2026-06-21 — `geoEnrich(300, 1100)` on the live DB: events_updated 170, places_updated 46.
  Re-exported `data/seed/events.json` with coords: **155/239 events geocoded (65%)**, 0 null-date kept.
  By source: lacotorra 50/56, fever 33/34, ticketmaster 22/22, eventbrite 14/14, palau 10/10, vidacultural
  9/9, songkick 8/8; the 84 null are venues that only resolve to the València centroid → kept null per the
  `isCentroid` guard (better null than a fake pin, T135). The map now renders ~155 dated events + places.)*

- [x] T144-enrich **Local enrich pass — RU translations baked into the seed** (T144 stage). *(DONE
  2026-06-21 — `claude -p` (haiku, key-free) enrich on the live DB: attempted 303 / **enriched 303 / 0
  errors**. Re-exported `data/seed/events.json` (343) with RU: **239/239 derived events have `title_ru`
  (100%)**, 214 `description_ru`; the LLM also cleans noisy titles (e.g. "Hola amig@s. Os traemos…" →
  "Фестиваль Июля 2026"). Engine + quality verified on a 2-event probe first. This closes the heavy
  local-first compute (T144): the seed now ships ingested + normalized + deduped + geo'd + ENRICHED.)*

- [x] T158 [E] **Enrich the curated + Hemisfèric seed events too (full RU coverage)** (T144-enrich
  follow-up). The local enrich covered the 239 derived events; still un-enriched in the seed: the curated
  `events-feria-julio-2026.json` (43) / `events-fever.json` (2) / `events-logunespa.json` (10) — these are
  exported from their FILES (the live-DB copies WERE enriched but feria is stale-merged so I kept the files);
  and the 104 `api:hemisferic` events (they're series, not plain events, so `enrichCards` skipped them).
  To finish: reset the stale feria duplicates → re-export the curated from the enriched DB; enrich the
  Hemisfèric series (per-series, once) + bake. Then 100% RU coverage across the seed.
  *(DONE 2026-06-21 — reset 41 stale feria dups → 43 upcoming; re-exported feria(43)/logunespa(10)/fever(2)
  from the enriched live DB (all title_ru, 0 null dates; fever KEPT — DroneArt, distinct from the 34 derived
  fever). Enriched the 104 Hemisfèric events via 11 distinct-show `claude -p` calls (e.g. "Oceans: Our Blue
  Planet" → "Океаны: наша голубая планета", "3,2,1…¡Despegamos!" → "3,2,1… Взлёт!") applied to all
  occurrences. **Seed is now 100% RU: events.json 343/343 title_ru, all 4 files 0 null dates, 11 Hemisfèric
  series preserved, 0 id collisions.** Helper `scripts/enrich-hemis-seed.mjs`.)*

- [x] T159 [F] **"Личные рекомендации" source + add 3 tea shops to the map** (user, `backlog:`,
  2026-06-21). User wants (a) a new place SOURCE/category for personal chat recommendations
  (`recommended_by` = "личные рекомендации" / similar) — manually-curated places that people suggest in
  chats, NOT a crawled feed; and (b) these 3 specific tea shops (Улун/пуэр, recommended in a Valencia
  chat) added as map points. Resolve each `maps.app.goo.gl` short link → follow redirect → geocode the
  venue (deterministic, `lib/pipeline/geo.ts` `resolvePlaceGeo`/`mapsAddressQuery`, per T135) → add as a
  place (name/category=чайный магазин, lat/lng, source="личные рекомендации", maps_url) into the seed
  (`data/seed/places-*.json` or a new `places-recommendations.json`) → renders on the map like other places.
  Links:
  - https://maps.app.goo.gl/x2mR49odjwgaiUga9?g_st=ic
  - https://maps.app.goo.gl/ZyMuaf7M4Q6BqX8c6?g_st=ic
  - https://maps.app.goo.gl/YTut5mmZnBseXpB59
  (The personal-recs "source" is a curated input pattern — define how such ad-hoc places are added without
  a crawler; could be a small `data/seed/places-recommendations.json` + a `source` row, or a simple add-place
  helper. Pairs with the place-mining / map surface work.)

- [ ] T160 [E] **Re-bake the seed to capture the parsePrice/parseEventDate fixes** (T142 follow-up).
  T142 fixed two shared helpers (`parsePrice` trailing-`\b` dropped all `€10`/`25 евро` prices; `parseEventDate`
  numeric branch misread durations as dates) that the already-baked 239 derived seed events were normalized
  WITHOUT. A re-bake (reset source_items → normalize→dedup→score→tag→geo→enrich → re-export) would add the
  now-parsed prices + fix the few mis-parsed numeric dates. Optional polish; the seed is already correct on
  dates/RU — this just enriches prices. Low priority.
  *(MEASURED 2026-06-21 — a SURGICAL price backfill (re-parse `parsePrice` over existing events' `raw_excerpt`)
  does NOT work: 138/238 derived events have no price, but their `raw_excerpt` is title-only (e.g. "SHAPE UP
  Valencia", "Денис Чужой, Stand Up") — the price text lives in the FULL post `raw_text`, not the excerpt. So
  recovering prices needs a FULL re-bake (re-normalize from `source_items.raw_text` → which re-creates events
  → loses enrichment unless re-enriched, ~50 min `claude -p`). Marginal value (prices on ~telegram events) vs
  heavy cost → DEFERRED. Do it only as part of a future full local-first re-bake, not standalone.)*

- [ ] T162 [E/I] **Authorize the Claude agent (enrich engine) in PROD** (user, `backlog:`, 2026-06-21).
  The enrich engine is `claude -p` (Claude subscription / OAuth CLI) — it does NOT exist on Vercel
  serverless (no CLI binary, no interactive login). Decide how prod enriches NEW cards. Options:
  1. **No prod enrich (simplest, default).** The seed is PRE-ENRICHED; prod runs incremental ingest only
     (`runPipeline()` passes no `enrichClient`). New cards stay un-enriched until a periodic OFF-prod pass
     (run `claude -p` enrich locally against a copy / re-bake → re-deploy the seed, or push enriched rows to
     the prod DB). Zero prod secret. `/api/health` shows "enrich stalled (info)" — info-only, never fails.
  2. **SDK path on prod.** Use `@anthropic-ai/sdk` + an **`ANTHROPIC_API_KEY`** (API key ≠ subscription) as a
     Vercel env var; build a SDK-based `EnrichClient` (enrich.ts is engine-agnostic — `createSdkEnrichClient`)
     and inject it in the enrich cron/route. Works on serverless; costs API tokens (haiku translation / sonnet
     grounded per T139). Enables live prod enrich of new cards.
  3. **Off-prod worker.** A small always-on box / scheduled CI (GitHub Actions) job runs `claude -p` enrich
     against the prod Neon DB (or regenerates seed deltas). Keeps the subscription, no API-key cost, needs a host.
  RECOMMENDATION: ship with **(1)** for launch (pre-enriched seed + incremental); add **(2)** (SDK + API key)
  when live prod enrich is wanted. Either way the local `claude -p` flow stays for the heavy bake. Decide +
  (if (2)) build `createSdkEnrichClient` + wire `ANTHROPIC_API_KEY` + the enrich cron (T055, was deferred on
  the Workflow SDK — can run as a plain route instead).

- [ ] T163 [F] **Design pass — dalnoboi.org as the base (use Claude Design MCP)** (user, `backlog:`,
  2026-06-21; the concrete brief for T134). Requirements:
  - **Colour scheme + visual base from http://dalnoboi.org/** — "это наш дизайн и сайт" (the user's own
    site) → take its palette/look as the base for Valencia Radar's UI.
  - **Tag cloud by frequency** — a tag cloud weighted by tag frequency across events/places (tags already
    exist in `tags_json`); bigger = more frequent. A new feed/sidebar component.
  - **Lazy loading of posts/events** — the feed should lazy-load (infinite scroll / on-demand) instead of
    rendering everything at once (the feed is ~340 events).
  - **Categorization** — clearer category grouping/filtering in the feed (categories already on events:
    concert/exhibition/excursion/…).
  - **Use Claude Design** — the design MCP (Vercel `import-claude-design-from-url` from dalnoboi.org, or
    Figma) to derive the design, then implement in `app/` (Home.tsx + globals.css), preserving the existing
    data/render layer (queries.ts, the featureKind accents incl. the new `--excursion`, the map/calendar).
  Substantial visual iteration — likely its own multi-step effort. Keep the deterministic-from-DB render.

- [x] T164 [docs] **Token-cost estimate ($) for `claude -p`/API enrich + AI-less-prod option** (user,
  `backlog:`, 2026-06-21). Estimate the monthly $ spend if prod enriches WITH an API key, and flesh out the
  option where prod is AI-LESS and the user enriches LOCALLY (subscription) on a trigger.
  *(ANSWERED 2026-06-21 — see `specs/001-valencia-radar/cost-estimate.md`. TL;DR: at the live cadence the
  API-key bill is **single-digit $/month** (haiku translate $1/$5·MTok, sonnet ground $3/$15·MTok; Batch
  −50%); the recommended shape is **AI-less prod + local subscription bake on a trigger** = $0 AI on the
  server. Decision belongs to T162 option (1) vs (2).)*

- [x] T165 [B] **Cron / per-source poll-frequency scheme — is there one?** (user, `backlog:`, 2026-06-21:
  "а что там с кроном и подсчётом того как часто каждый источник будет дёргаться? есть схема?").
  *(ANSWERED — YES, the adaptive-cadence dispatcher (T011–T015, built). One `*/15` cron tick →
  `/api/cron/dispatch` → `selectDueSources()` polls ONLY sources whose `next_poll_at` is due; per-source
  interval = `computePollInterval` = `clamp(observed_gap × 0.33, min, max)`, backoff `×1.5` when a fetch is
  unchanged / `×2` on error; conditional-GET (ETag/If-Modified-Since) → `304` short-circuits to
  `source_runs.not_modified` (no normalize, no AI). Per-TYPE seed defaults: telegram 10 min–3 h, web 1 h–24 h,
  ticketing/api 2 h–24 h. So a fast-moving Telegram channel is checked ~every 10–30 min while a static venue
  page settles toward once/day — automatically, no per-source cron config. Documented in `cost-estimate.md`.)*

- [x] T166 [docs] **Human-readable architecture diagram of the built system** (user, `backlog:`,
  2026-06-21: "нарисуй человекопонятную схему архитектуры того что получилось"). Produce a clear,
  non-engineer-friendly diagram (sources → ingest → pipeline stages → DB → site/notify) with the local-bake
  vs prod-incremental split and the AI touchpoints marked. *(DELIVERED 2026-06-21 → `ARCHITECTURE.md`.)*

- [x] T167 [review] **Independent senior-architect code review (fresh eyes)** (user, `backlog:`, 2026-06-21:
  "проведи код ревью в отдельном агенте так будто ты никогда не видел код, будет независим и действуй как
  сениор архитектор, приведи примеры структурных улучшений архитектуры"). Run in a SEPARATE agent that
  reviews the actual code (not the design docs) and gives concrete STRUCTURAL improvement examples. *(IN
  PROGRESS — background agent writing `specs/001-valencia-radar/code-review-independent.md`.)*

- [x] T168 [C] **Dedup gap — visible duplicate cards in the feed** (user, 2026-06-21, with screenshots).
  TWO live duplicate pairs the current dedup misses:
  1. **Oxxxymiron, 2026-06-28** — id 25182 `web:worldafisha` ("Oxxxymiron - Oxxxymiron Tour 2026
     «Национальность: нет»") vs id 25209 `web:valenciarusa` ("ИЮН 28 2 сеансов от 69 € Oxxxymiron в
     Валенсии…"). CROSS-source. Missed because the valenciarusa title carries a date/price NOISE PREFIX,
     so `titleSignature` diverges → no strong/fuzzy match. Fix: strip leading date/price noise (and the
     normalizer should not emit it) before signature; core token "oxxxymiron" then matches cross-source.
  2. **Rod Stewart, 2026-06-30 21:00** — id 25305 ("Rod Stewart") vs id 25299 ("Rod Stewart | Paquetes
     VIP"), BOTH `web:ticketmaster`. SAME-source variant ("main" + "VIP packages"). The ≥2-distinct-source
     merge guard (added to stop over-merge) blocks it. Fix: a SEPARATE same-source rule — same date(+time)
     +venue and one title is the other minus a ticket-tier suffix (`| Paquetes VIP`/`VIP пакеты`/`VIP
     packages`) → collapse, keep BOTH ticket links.
  Constraints (constitution): keep a link to EVERY source (entity_sources/metadata), do NOT over-merge
  genuinely distinct same-day same-venue events, keep the geo guard. Also SCAN for other such near-dups
  ("и ещё один" implies more), add regression tests, re-run dedup on the local DB so losers flip to
  `status='duplicate'`, re-bake `data/seed/events.json`. *(IN PROGRESS — background fix agent.)*
  3. **DroneArt Show: Harry Potter (Шоу дронов), 2026-06-26 Fri** (user, screenshots) — id 25524
     `web:lacotorra` ("Шоу дронов по вселенной «Гарри Поттера»", Fri **12:00** ← WRONG time, drone shows
     are night) vs id 1101 `web:fever` ("DroneArt Show: Harry Potter™", Fri 22:30). CROSS-source dup, both
     Friday. Also id 1102 (fever, Sat 27th 22:30) is already `status='duplicate'` → user says show is
     "только в пятницу" → confirm real dates from the Fever page and drop/keep the Sat occurrence
     accordingly; fix the lacotorra 12:00 time.

- [x] T169 [normalizer] **Eventbrite date off-by-one (weekday/date mismatch)** (user, 2026-06-21,
  `/events/25487`). Event 25487 "Saturday Language Exchange & Party" (`web:eventbrite`) is stored
  `start_date=2026-06-21` which is a **Sunday** — a weekly Saturday event landed one day late. The RENDER is
  correct (`lib/format.ts:14` computes weekday in UTC), so this is a NORMALIZER data bug — likely a timezone
  shift parsing the Eventbrite datetime (UTC vs Europe/Madrid → −1 day). CHECK whether it is SYSTEMIC across
  ALL `web:eventbrite` events (compare stored `start_date` weekday vs the title/source weekday); if so, fix
  the eventbrite normalizer's date parse (parse in Europe/Madrid, not UTC) and re-bake. Add a test.

- [x] T170 [normalizer] **lacotorra (all-Spain aggregator) → HYBRID city filter** (user decision via
  AskUserQuestion, 2026-06-21). `web:lacotorra` (https://lacotorra.io/events, ENABLED, a goldmine — 56
  events incl. the user-wanted Cirque du Soleil id 25501 + «Алиса в Стране чудес» CaixaForum València id
  25491, BOTH in Valencia ✓) aggregates events across ALL Spain → ~22/56 are Madrid (12) / Barcelona (8) /
  other. User chose **hybrid**: KEEP all Valencia / Comunitat Valenciana events (34); from OTHER cities keep
  ONLY major headliners (user examples: Linkin Park, BTS, Sting, Bruno Mars, Garbage, Cirque du Soleil),
  DROP small regional non-Valencia events. Implement DETERMINISTICALLY (T140 — JS, no LLM): in the lacotorra
  normalizer, `isValenciaRegion(city/location_notes)` → keep; else keep only if the title matches a curated
  HEADLINER allowlist (big international acts) — otherwise mark the raw row processed but don't emit the
  event (or set status so it's excluded from the feed). Add a test (Valencia kept / Madrid-small dropped /
  Madrid-headliner kept). MUST land AFTER the in-flight T168 Bug-3 lacotorra fix (same file — serialize, do
  NOT edit concurrently). Then re-normalize lacotorra on the local DB + re-bake the seed. This policy
  generalizes to other all-Spain aggregators (see [[valencia-radar-content-policy]]).

- [x] T171 [normalizer] **Class-C date-parse bugs in vidacultural / valenciabonita** (found by the T168
  fix agent's scan, 2026-06-21). `vidacultural` id 25216 (title "Неділя 28 червня" but stored 2026-08-07 —
  wrong date) and id 25214 (stored year 2027 instead of 2026); `valenciabonita-telegram` id 25230 ("feliz
  sábado" but stored a Monday). Date-parse bugs in `vidacultural.ts` + `valenciabonita-telegram.ts` (NOT the
  four T168/T169 normalizers). Build fixtures from the real rows, fix the parsers (UK/RU weekday handling +
  year inference), add regression tests, re-normalize on the live DB.

- [x] T172 [geo] **Mis-geo: Alicante events tagged city=Valencia** (found by the T168 fix agent,
  2026-06-21). Би-2 + Орбакайте source URLs contain `-alikante-` but rows are stored `city='Valencia'`. The
  normalizer/geo should read the city from the URL slug / address, not blanket-default to Valencia. Check
  how widespread (other `-alikante-`/`-barselona-` slugs tagged Valencia) and fix the city assignment.

- [x] T173 [bake] **Proper seed re-bake preserving curated + Hemisfèric (picks up T168/T169 fixes)** (user
  rule: confirm destructive `data/seed/` overwrite first). The T168/T169 dedup + date fixes are live in code
  + the local DB but NOT in `data/seed/events.json` — the T168 agent skipped the export because a naive
  `export-seed --commit` REGRESSES the seed: (a) the live DB has 0 `api:hemisferic` rows (they live in
  `event_series` after the migration → would drop the 104→11 series cutover, the "Tick L" regression), and
  (b) would reintroduce ~9 null-date `tg:logunespa` rows. So PROD still ships the pre-fix seed. Need a
  curated-merge re-bake: corrected derived events from the live DB + the 104 curated `api:hemisferic` +
  curated feria/fever/logunespa, 0 null dates → confirm the overwrite with the user → re-bake → round-trip
  verify on a throwaway DB. NOTE: the user's LOCAL site (localhost, reads the live DB) ALREADY shows the
  fixes; this is only for the prod-shipping seed.

- [x] T174 [F] **CSS autoprefixer warning in dev-server logs** (user, `backlog:`, 2026-06-21: "фиксани
  потом что это за хрень в логах"). `app/globals.css` (~line 111:73) uses a bare `end` value
  (`justify-content: end` / `align-items: end` / `align-self: end`) → autoprefixer warns "end value has
  mixed support, consider using flex-end instead". Cosmetic only (dev-server log noise, no render impact).
  Fix: replace the bare `end` with `flex-end` at that rule (and any siblings). One-line CSS change; verify
  the warning is gone. Low priority. *(The other harmless "Skipped not serializable cache item … Warning"
  webpack line is a known Next 14.2 dev-cache quirk, not our bug.)*

- [x] T175 [D/F] **NEW event category «экспозиция» (standing/long-running event over a date span)** (user,
  `backlog:`, 2026-06-21, marked **важно!!**). A third kind of event distinct from one-offs and recurring
  series: a PERMANENT/standing event that runs continuously from date A to date B at a fixed venue —
  exhibitions / museum expositions. User examples: выставка «Алисы в Стране чудес» (id 25491, CaixaForum
  València), Titanic, «новая экспозиция в музее». Currently these render as a single card on their start day
  (or worse, risk looking like a daily event). REQUIREMENTS:
  1. **Model/detect.** Mark an event as an exposition when it has a multi-day `start_date..end_date` span AND
     is an exhibition-type (category выставка/exhibition/экспозиция/museum show). Ensure the normalizers
     CAPTURE `end_date` for these (many exhibitions have an open-until date — today it may be dropped). Add a
     `featureKind='exposition'` (see `lib/queries.ts` `featureKind` — currently feria|festival|hemisferic|
     excursion|null) + a distinct thin accent colour (a new `--exposition` CSS var, like `--excursion`).
  2. **Calendar render (the key ask).** Render an exposition as a horizontal **spanning bar across ALL days
     of its [start,end] range at the TOP of the calendar month grid** — like a multi-day all-day event /
     "location" strip in corporate Google Calendar — a THIN bar, visually clearly "это идёт постоянно", NOT a
     per-day card duplicated 60×. It must still be visible/clickable on every day it spans (don't miss it),
     but occupy one continuous lane, not flood each day. Multiple overlapping expositions → stack in separate
     lanes. Clicking the bar → the event detail.
  3. **Feed.** Show ONE card (as now) but flagged as ongoing — e.g. «идёт до DD месяца» / «постоянная
     экспозиция», so users see it's a standing thing, not a single date.
  Touch points: `lib/queries.ts` (featureKind + expose start/end span + an `is_exposition` flag on SiteEvent),
  `app/Home.tsx` (calendar grid — add a spanning-bar lane above the day cells; feed badge), `app/globals.css`
  (`--exposition` accent + the bar style), the relevant normalizers (capture `end_date`). Relates to the
  recurring model (`event_series`) but is SIMPLER (one continuous span, no discrete occurrences) and to the
  design pass [[T163]]. Likely its own multi-step effort; keep the deterministic-from-DB render.

- [x] T176 [I] **SHIP-BLOCKER: fresh `db:setup` fails — `sources.url` NOT NULL vs curated null url**
  (found by the T173 re-bake agent, 2026-06-21). A clean/prod `db:setup` (DEPLOY.md Phase 1) crashed because
  `data/seed/sources.json` `curated:recommendations` has `url: null` (it's a curated, `enabled=0` pseudo-source
  with no crawl URL — T159 pattern) but `db/schema.sql` declared `sources.url TEXT NOT NULL`. The persistent
  local `main` DB predated T159 so it never hit this; ONLY a fresh DB (= every prod deploy) did. FIX: relaxed
  `sources.url` to nullable in `db/schema.sql` (curated sources legitimately have no URL; `CREATE TABLE IF NOT
  EXISTS` means the live `main` table is unaffected — fresh setups only). VERIFIED on a throwaway DB: fresh
  `db:setup` now exit 0, 0 errors, `curated:recommendations` loads with null url, 352 events / 0 null dates /
  11 series. Unblocks prod deploy.

- [ ] T177 [A] **build a cac.es normalizer** (exposiciones → expositions, agenda/actividades → events).
  Unblocked by T148 (the 4 `web:cac_*` sources now ingest: 113 `source_items` live — actividades 38 /
  agenda 24 / exposiciones 21 / museu 30 — currently normalizing to `ignored` for lack of a normalizer).
  Build `lib/pipeline/normalizers/cac.ts` (+ register in `NORMALIZER_REGISTRY`): route `web:cac_exposiciones`
  (and likely `web:cac_museu`) → the standing/long-running **exposition** category (cross-ref the new T175
  exposition feature: continuous start/end span, `is_exposition`), and `web:cac_agenda`/`web:cac_actividades`
  → dated **events**. cac.es is the Ciudad de las Artes y las Ciencias (a flagship Valencia venue), so this
  is high-value content. Deterministic parse first (T140); inspect the real `source_items` HTML/links for
  date + title structure before writing rules.
