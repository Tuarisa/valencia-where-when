---
description: "Task list for Valencia Radar (001-valencia-events)"
---

# Tasks: Valencia Radar — curated events & places radar

**Input**: Design documents from `specs/001-valencia-events/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Lightweight `node:test` units for pure logic (per plan D5). `npm run build`
is the compile gate for every task.

**Organization**: Grouped by user story (US1–US5). This is an EXISTING codebase — most
tasks EXTEND files in `lib/pipeline/`, `app/`, `scripts/`. Each task must end green
(`npm run build`) and be committed (constitution VI).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency)
- **[Story]**: US1–US5; Setup/Foundational/Polish have no story label

---

## Phase 1: Setup (Shared Infrastructure)

- [ ] T001 Add `node:test` harness: create `tests/` dir + `npm run test` → `node --test tests/` in `package.json`; one smoke test in `tests/smoke.test.mjs`.
- [ ] T002 [P] Add `.github/workflows/scheduler.yml` skeleton (manual `workflow_dispatch` only for now) that can POST to cron endpoints with `Authorization: Bearer ${{ secrets.CRON_SECRET }}` (per research D1).
- [ ] T003 [P] Document env + run flow deltas in `README.md` (new `/api/cron/enrich`, `/api/cron/digest`, `npm run test`).

**Checkpoint**: harness + scheduler scaffolding exist; build green.

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: complete before user-story work.

- [ ] T004 Verify/align `db/schema.sql` against data-model.md; confirm enrichment columns (`title_ru`, `description_ru`, `links_json`, `enrichment_json`, `enriched_at`), `notified`/`notified_at`, and `notifications` exist. Add an idempotent migration only if a column is missing. Run `npm run db:schema` against a dev DB.
- [ ] T005 Refactor `lib/pipeline/normalize.ts` into a **registry/dispatch** keyed by `source_key`/`item_type`; move the existing Hemisfèric path to `lib/pipeline/normalizers/hemisferic.ts` as the first registry entry. Export `normalizeAll()`. No behavior change yet (build + existing data parity).
- [ ] T006 [P] Add shared normalizer types/helpers in `lib/pipeline/normalizers/types.ts` (`EventDraft`, `PlaceDraft`, `NormalizedOut`, status enum) and a `markRawItem(status, note)` helper that never deletes `source_items`.
- [ ] T007 [P] Add `tests/normalize-registry.test.mjs` asserting dispatch routes a sample raw item to the right normalizer and unknown sources return `ignored`.

**Checkpoint**: pipeline still runs (`npm run pipeline:run`), registry in place, raw layer still append-only.

---

## Phase 3: User Story 1 — Curated events website (Priority: P1) 🎯 MVP

**Goal**: A curated feed + current-month calendar + venue map + per-entity detail
pages, with Hemisfèric collapsed and (when present) RU-translated content.

**Independent Test**: Load `/` on seed data — only real events show; calendar opens on
current month; Hemisfèric = one card/day with session times; detail pages have source
links.

- [ ] T008 [US1] Audit `app/page.tsx` + `lib/queries.ts`: ensure the feed query excludes raw/ignored items and orders upcoming events; add a "curated only" filter (score/normalized).
- [ ] T009 [US1] Confirm calendar in `app/Home.tsx` defaults to current month (SC-005) and Hemisfèric days render as one collapsible color-coded card with session times (FR-010). Fix if regressed.
- [ ] T010 [P] [US1] Ensure event/place detail pages (`app/events/[id]/page.tsx`, `app/places/[id]/page.tsx`) show source link, tags, image, and prefer `title_ru`/`description_ru` when set, with clickable links from `links_json` (FR-011).
- [ ] T011 [P] [US1] Verify Leaflet map plots events/places with `lat`/`lng`; hide markers without coords cleanly.
- [ ] T012 [US1] Add `tests/feed-query.test.mjs` for the curated-filter + current-month calendar helper (pure functions extracted from query/format layer).

**Checkpoint**: MVP afisha works end-to-end on seed data; build green.

---

## Phase 4: User Story 2 — Weekly curated digest (Priority: P1)

**Goal**: Friday ~09:00 Europe/Madrid digest of family-fit events in a 2–3 week
horizon + "new places" block; no repeats.

**Independent Test**: `POST /api/cron/digest?mode=weekly&dry=1` selects only fitting,
in-horizon, above-threshold, un-notified events + a places block; running without
`dry` twice yields 0 repeats.

- [ ] T013 [US2] Implement `lib/pipeline/notify.ts`: `selectDigest({horizonDays, threshold})` pure selector (family-fit tags + `notified=0` + date window + score) returning events + new places.
- [ ] T014 [US2] Add `app/api/cron/digest/route.ts` (Bearer `CRON_SECRET`): builds digest; `?dry=1` no writes; otherwise sets `notified=1`/`notified_at` and inserts `notifications` rows (FR-012/FR-013).
- [ ] T015 [P] [US2] Pluggable sender stub in `lib/pipeline/notify.ts` (`sendDigest(payload)`), default = render-to-text/dry; transport (Telegram/email) behind an env flag — start dry (research open item).
- [ ] T016 [US2] Wire the weekly trigger in `.github/workflows/scheduler.yml` (`0 7 * * 5`, in-handler local-time check).
- [ ] T017 [P] [US2] `tests/digest-select.test.mjs`: horizon boundaries, threshold, already-notified exclusion, family-fit filter (SC-002/SC-008).

**Checkpoint**: digest selects correctly and never repeats; build green.

---

## Phase 5: User Story 3 — Rare-event alert (Priority: P2)

**Goal**: Out-of-cycle alert for high-value items; marked so never duplicated.

**Independent Test**: feed an above-`alertThreshold` event → one alert → not re-sent or
re-listed in weekly digest.

- [ ] T018 [US3] Extend `lib/pipeline/notify.ts` with `selectAlerts({alertThreshold})` (higher bar than digest) and reuse the mark-notified bookkeeping.
- [ ] T019 [US3] Support `?mode=alert` in `app/api/cron/digest/route.ts` (or a sibling route) to dispatch alerts; mark notified.
- [ ] T020 [P] [US3] `tests/alert-select.test.mjs`: only above-threshold + un-notified selected; idempotent re-run sends nothing.

**Checkpoint**: alerts fire once; build green.

---

## Phase 6: User Story 4 — Places / restaurants catalog (Priority: P2)

**Goal**: Categorized catalog (cuisine, district, occasion, price, recommender),
renderable independently of events.

**Independent Test**: `/places` lists places with facet filters; breaking an event
normalizer doesn't affect it.

- [ ] T021 [US4] Add place-mining normalizers in `lib/pipeline/normalizers/` for place-rich sources (rutatuta_vlc, logunespa, gosvetlanada, Fever gastro) → `places` with `category`, `area`/`district`, `occasion`, `price_level`, `recommended_by` (FR-015).
- [ ] T022 [US4] Add `app/places/page.tsx` catalog surface with facet filters; reuse `app/places/[id]/page.tsx` for detail.
- [ ] T023 [P] [US4] Place categorization helper + `tests/place-categorize.test.mjs` (occasion/price/cuisine inference).

**Checkpoint**: catalog renders independently; build green.

---

## Phase 7: User Story 5 — Trustworthy dedup + geo coverage (Priority: P3)

**Goal**: Same real-world event collapses to one entry (correct date, all source
links); ≥80% of located events on the map.

**Independent Test**: triple a known event (Слава Комиссаренко) with conflicting dates →
one survivor with reliable date + `metadata_json.sources[]`; geo coverage ≥80% of
located events.

- [ ] T024 [US5] Implement `lib/pipeline/dedup.ts`: match-key (person/title-slug + city + date-window) grouping; survivor by `(source weight, score)`; accumulate `metadata_json.sources[]`; soft-collapse losers; never delete `source_items` (FR-003/FR-004).
- [ ] T025 [US5] Insert `dedup` into `lib/pipeline/run.ts` between `tag` and `geo` (and expose via `/api/cron/refresh`).
- [ ] T026 [P] [US5] `tests/dedup.test.mjs`: 3-record concert with date conflict → 1 survivor, reliable date, all sources retained.
- [ ] T027 [US5] Expand geo coverage in `lib/pipeline/geo.ts`: resolve `maps.app.goo.gl`, geocode `address`/`venue_name`; keep ≥1.1s Nominatim pacing + real User-Agent; raise the per-run cap sensibly (SC-004).
- [ ] T028 [P] [US5] `tests/geo-extract.test.mjs`: map-link/address parsing → query string (pure logic, no network).

**Checkpoint**: dedup + geo meet SC-003/SC-004; build green.

---

## Phase 8: Full source normalizers (cross-cutting, feeds US1/US2)

> One source per task — ideal Ralph iterations. Each: normalizer module + dispatch
> entry + `npm run pipeline:run` parity check + build green.

- [ ] T029 [P] worldafisha normalizer → events (`lib/pipeline/normalizers/worldafisha.ts`)
- [ ] T030 [P] valenciarusa normalizer → events
- [ ] T031 [P] vidacultural_Valencia normalizer → events (+ place posts)
- [ ] T032 [P] concerten (gastroli) normalizer → events
- [ ] T033 [P] Palau de la Música normalizer → events (title/date/venue cleanup)
- [ ] T034 [P] CAC (agenda/exposiciones/actividades/museu) normalizer → events
- [ ] T035 [P] visitvalencia normalizer → events
- [ ] T036 [P] lacotorra normalizer → events
- [ ] T037 [P] **Fever extractor** — fetch individual event pages (DroneArt Show, Harry Potter) in `lib/pipeline/ingest.ts` + normalizer
- [ ] T038 [P] Ticketmaster normalizer → events
- [ ] T039 [P] Songkick normalizer → events
- [ ] T040 [P] Valencia Bonita normalizer → events
- [ ] T041 [P] Hoy Valencia normalizer → events
- [ ] T042 [P] laganzua normalizer → events

---

## Phase 9: Card enrichment (cross-cutting, improves US1/US2)

- [ ] T043 Implement `lib/pipeline/enrich.ts`: `enrichCards({limit, dry})` — capped batch of `enriched_at IS NULL` events, per-item `claude -p` (OCR poster, RU `title_ru`/`description_ru`, `links_json`, short-title/body split), per-item try/catch, idempotent writes (FR-008, constitution IV).
- [ ] T044 Add `app/api/cron/enrich/route.ts` (Bearer): runs a capped batch; returns `{attempted, enriched, skipped, errors}`; NOT added to synchronous `runPipeline`.
- [ ] T045 [P] Wire enrich trigger into `.github/workflows/scheduler.yml` after ingest.
- [ ] T046 [P] `tests/enrich-parse.test.mjs`: parsing of a mocked `claude -p` response into the enrichment fields; failure path leaves base record valid (SC-006).

---

## Phase 10: Polish & Cross-Cutting

- [ ] T047 [P] Update `WORKBOARD.md` Done/Next as tasks complete.
- [ ] T048 Run `quickstart.md` validation scenarios 1–7 end-to-end.
- [ ] T049 [P] Decide cron cadence: confirm GitHub Actions scheduler vs Vercel Pro; document final choice in `plan.md`/`README.md` (research D1).
- [ ] T050 [P] `npm run build` + `node --test tests/` clean; tidy any dead code.

---

## Dependencies & Execution Order

- **Setup (P1)** → **Foundational (P2, esp. T005 registry)** blocks normalizers (Phase 8) and most US work.
- **US1 (Phase 3)** is the MVP — do first after Foundational.
- **US2/US3** depend on `notify.ts` (T013) which depends on scoring/tags (existing) + curated data.
- **US4** independent of events stories (constitution III) — can run anytime after Foundational.
- **US5 dedup (T024)** best after several normalizers (Phase 8) produce duplicates to merge.
- **Enrichment (Phase 9)** improves US1/US2 but is independent/best-effort — anytime after Foundational.

### Parallel opportunities
- All Phase 8 normalizers are `[P]` (separate files) — prime parallel/loop fodder.
- Test tasks `[P]` alongside their implementation.

## Implementation Strategy (MVP first)

1. Phase 1 Setup → Phase 2 Foundational.
2. Phase 3 (US1) → **validate MVP afisha**.
3. Phase 4 (US2 digest) → validate no-repeat.
4. Then US4 catalog, US3 alerts, US5 dedup/geo, and grind Phase 8 normalizers + Phase 9 enrichment one source/stage per iteration.
5. Phase 10 polish + quickstart validation.

## Notes
- Every task: end on green `npm run build`, commit with a descriptive message.
- `[P]` = different files, no dependency. Keep raw `source_items` append-only.
- Normalizers (Phase 8) are the highest-volume, most loop-friendly backlog.

---

## Phase 11: Convergence

> Appended by `/speckit-converge` — gaps found in the existing code that the spec
> requires but no T001–T050 task covers. Ordered HIGH → LOW.

- [ ] T051 Generalize notification delivery tracking to **places** so the digest "new places on the radar" block never repeats: add place-level notified state (e.g. `places.notified`/`notified_at` or extend `notifications` with `entity_type`+`entity_id`) and use it in `selectDigest()` — per FR-013, US2/AC3 (partial)
- [ ] T052 Make the new `/api/cron/enrich` and `/api/cron/digest` routes **require** `CRON_SECRET` (fail closed — 401 when unset/mismatched), unlike the existing optional guard in `app/api/cron/refresh/route.ts` — per Constitution V (partial)
- [ ] T053 Add the spec-named but unconfigured sources to `data/seed/sources.json` + ingest: **elcontacto.ru, russpain, eventbrite** (enabled) and **SpainNewsOnline** (configured `enabled=0`/`weight=off`) — per FR-001 (missing)
- [ ] T054 Align cron HTTP method across `app/api/cron/*` routes and `.github/workflows/scheduler.yml` (existing `refresh` is GET; contracts assume POST) so the scheduler triggers all endpoints consistently — per plan: contracts (partial)
- [ ] T055 Document new environment variables in `.env.example` (enrichment/`claude` availability and notification transport token/webhook) so deploys are reproducible — per FR-008 (missing)
