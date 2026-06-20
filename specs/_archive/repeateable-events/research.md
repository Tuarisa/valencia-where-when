---
spec: repeateable-events
phase: research
created: 2026-06-20T13:30:00Z
provider: n/a (data-model + pipeline research; RFC 5545 referenced)
---

# Research: repeateable-events

## Executive Summary

The Hemisfèric ingest emits **one `events` row per film per day**: the seed holds
**104 event rows that are really only 11 films** across a 14-day window (e.g.
"Oceans: Our Blue Planet" = 14 identical rows, one per date; verified
`distinct_hashes == rows == dates`). The dedup is **cosmetic** — `app/Home.tsx`
groups Hemisfèric per-day *at render time* into a collapsible "N сеансов" cell, but
the DB, feed, dedup, score and (future) enrich all see N rows. The fix is a
**series + occurrences** model: ONE logical event (the "card" = a `series`) owns a
set of dated `occurrences` that power the **calendar**. Recommended over an
RRULE-only approach because Hemisfèric's schedule is **irregular and API-given**
(materialized dates, not a clean rule) and over a `series_id`-on-events approach
because that leaves N enrichable/scoreable rows. The change is **additive + reversible**
(constitution VI): two new tables, no column drops; the existing per-day rows can be
**collapsed in place** by a one-shot migration or **regenerated from append-only
`source_items`** (104 raw Hemisfèric items still present).

## Key Findings

| # | Finding | Evidence (file / data) |
|---|---------|------------------------|
| 1 | **104 Hemisfèric event rows = 11 distinct films.** "Oceans" 14 rows, "Animal Kingdom" 14, "Eclipse+Sun" 14, "Auroras" 13, "Caminando…3D" 11, "Dinosaurios" 11, "3,2,1…" 10, "Postales" 9, "Las Nocturnas" 4, "Recombination" 3. 14 distinct dates. | `node` over `data/seed/events.json` (`source=api:hemisferic`) |
| 2 | **One row per (film, day).** Per title, `distinct_dedup_hash == rows == dates` → the row identity includes the date, so every day spawns a fresh row. | seed analysis; `eventHash` uses `start_date` (`lib/pipeline/util.ts:50-65`) |
| 3 | **Normalizer creates the rows.** `normalizeHemisferic()` loops raw items; `dedup = eventHash({title, start_date=day, …})` → `start_date` in the hash ⇒ a distinct row per day; sessions kept only in `metadata_json.sessions`. One INSERT per day. | `lib/pipeline/normalizers/hemisferic.ts:28-62` |
| 4 | **Ingest already fans out per day.** `parseHemisferic(source, days=14)` loops 14 days × the `cartelerasemanal.jsp?fechacartelera=<day>` API, emitting one raw item per (film, day): `external_id = "<day>:<idcontenido>:<show>"`, `raw_json.session_times[]`. So the raw layer is per-(film,day); the daily session list is right there. | `lib/pipeline/ingest.ts:141-186` |
| 5 | **UI collapse is render-time only.** Calendar bucket-by-day, then `items.filter(is_hemisferic)` rendered inside a `<details>` "Hemisfèric · N сеансов". The **feed** (`FeedCard`) renders **every** Hemisfèric row as its own card — no feed-level collapse at all. | `app/Home.tsx:173-211` (calendar), `:110-114,121-152` (feed) |
| 6 | **`is_hemisferic` is a hardcoded source check.** `row.source === "api:hemisferic"`. The whole "recurring" concept is currently special-cased to one source string. | `lib/queries.ts:99` (`is_hemisferic`) |
| 7 | **Existing spec 001 only collapses per-DAY, not per-FILM.** FR-010 / SC-002 / spec.md §18-36: "one card **per day**… expandable to per-session times." This spec supersedes that to **one card per film** (per series), with days/sessions as occurrences. | `specs/001-valencia-events/spec.md:18-36,143`; `tasks.md:T009` |
| 8 | **Cross-source dedup ≠ recurrence.** `dedup.ts` groups by `titleSignature + city` with a ±3-day window and **splits far-apart dates into separate sub-groups** (`groupByKey`), i.e. it is *designed* to keep a genuine series as separate rows. So dedup will NOT collapse the 14 Hemisfèric days; recurrence is an orthogonal concern. | `lib/pipeline/dedup.ts:90-148` |
| 9 | **Enrich/score waste is real and imminent.** `card-enrich` selects `WHERE enriched_at IS NULL` per row; 14 identical "Oceans" rows ⇒ 14 web-search-billed enrich calls ($10/1k searches) for one film. Score/tag likewise run per row. | `specs/card-enrich/research.md` Finding 1,5; `lib/pipeline/score.ts`/`tags.ts` per-row |
| 10 | **Schema already carries what a series needs.** `events` has `start_date,end_date,start_time,end_time`, `enriched_at`, `score`, `metadata_json`, `dedup_hash`, `status`, `notified`. A `series` row can reuse this exact column vocabulary; occurrences need only `(series_id, date, time)`. | `db/schema.sql:54-99` |
| 11 | **Raw layer is recoverable & append-only.** 104 Hemisfèric `source_items` persist (`external_id="<day>:<id>:<show>"`); migration can **regenerate** series+occurrences from raw instead of trusting the bloated `events`. Constitution I forbids deleting raw. | constitution I; `ingest.ts:160` |
| 12 | **`notifications` FK → `events(id)`.** Notify references an event id; a series must be a thing the notifier can point at (+ "next occurrence"). | `db/schema.sql:157-163` |
| 13 | **Pipeline order has no dedup/enrich today.** `runPipeline` = ingest→normalize→score→tag→geo. `dedup`/`enrich` are built/planned but not wired into `run.ts`. So inserting a "materialize series" step is low-friction. | `lib/pipeline/run.ts` |
| 14 | **RRULE (RFC 5545) is the standard for *rule-based* recurrence**, but emits an **infinite/needs-expansion** set; UIs typically **materialize occurrences** for a bounded window for calendar rendering + per-occurrence overrides (EXDATE / RECURRENCE-ID). Hemisfèric gives explicit dates, not a rule. | RFC 5545 §3.8.5 (RRULE/RDATE/EXDATE); see Sources |

## Decisions

### D1 — Data model: parent `series` + child `occurrences` (NOT RRULE-only, NOT series_id-on-events)

**Decision.** Add two additive tables:
- **`event_series`** — the **card**. One row per logical recurring event (film/show/run).
  Carries all the *card* data: title, description, venue, image, category, tags,
  **enrichment** (`title_ru`,`description_ru`,`enrichment_json`,`enriched_at`),
  **score**, `metadata_json` (incl. `sources[]`), `notified`/`notified_at`,
  `recurrence_summary` (human "ежедневно", and optionally an **RRULE string** when the
  pattern *is* a clean rule — see D1b).
- **`event_occurrences`** — the **calendar rows**. One per (series, date[, time]):
  `series_id`, `occurrence_date`, `start_time`, `end_time`, `status`, `dedup_hash`.
  Sessions-in-a-day become **multiple occurrences** (or one occurrence + `session_times[]`
  in `occurrences.metadata_json`; see Open Q1).

The **feed** queries `event_series` (≈11 Hemisfèric cards). The **calendar** queries
`event_occurrences` JOIN `event_series` (≈104 dated cells). Per-entity page shows the
series card + its full occurrence schedule.

**Rationale.**
- One card, many showtimes is *exactly* how event/cinema apps model "same film, many
  sessions": a **Film/Event aggregate** + child **Session/Showing** rows (Schema.org
  `Event` + `subEvent`/`eventSchedule`; Google "Movie/ScreeningEvent"). The series is the
  enrich/score/notify unit; occurrences are pure calendar data.
- **Enrich/score/notify once** falls out naturally: those columns live on `event_series`,
  so 11 enrich calls instead of 104 (Finding 9). Idempotent: unchanged schedule re-running
  ingest touches only `last_seen`, never re-INSERTs occurrences, never clears `enriched_at`.
- **Reversible/additive** (constitution VI): no `events` column dropped. (See D5 for whether
  `events` stays for single-shot events — recommended yes.)

**Alternatives.**
- **A) RRULE / `recurrence_json` on a single events row.** Store one `events` row + an
  iCalendar RRULE (`FREQ=DAILY;UNTIL=…`) or an explicit `RDATE` list, expand at read time.
  *Rejected as the primary model* because Hemisfèric's schedule is **irregular** (films skip
  days, session times vary per day — see seed), so the "rule" degenerates into an `RDATE`
  list = a denormalized occurrences array in JSON. That loses per-occurrence SQL (can't
  `ORDER BY occurrence_date`, can't index the calendar, can't mark one date cancelled
  cleanly), and the calendar must expand JSON in JS. **BUT** keep an *optional* `rrule`
  text column on `event_series` for sources whose recurrence *is* a clean rule (weekly
  meetup) — store the rule AND still materialize occurrences for the bounded window (D1b).
- **B) `series_id` grouping column on existing `events`.** Add `series_id` + an
  `event_series` parent; keep the 104 `events` rows as the "occurrences". *Rejected* because
  it leaves N enrichable/scoreable/dedupable rows (the core waste the goal targets), forces
  every consumer (`getEvents`, dedup, enrich select) to learn "skip child rows", and
  `events.dedup_hash UNIQUE` keeps fighting per-day identity. A purpose-built thin
  `event_occurrences` table is cleaner than overloading the fat `events` row 104×.

**D1b — RRULE as metadata, occurrences as truth (hybrid).** Materialize occurrences for a
bounded horizon (the ingest's 14-day window, extended each run); *optionally* persist an
RFC 5545 `rrule`/`rdate`/`exdate` summary on the series for display + future "rule-based"
sources. This matches how calendar apps work: **store the rule, render materialized
instances**, expand the rule forward as time advances (RFC 5545 §3.8.5).

### D2 — Normalizer change: emit one series + its occurrences

`normalizeHemisferic()` changes from "INSERT one event per (film,day)" to:
1. **Group** pending raw items by **series identity** = `seriesHash(title + venue + source)`
   (NO date) → one `event_series` per film. Upsert by `series.dedup_hash`.
2. For each raw (film, day) item, **upsert occurrences**: for the day's `session_times[]`,
   write `event_occurrences(series_id, occurrence_date=day, start_time=session)` keyed by
   `occHash(series_id + date + time)` (NO re-insert if present → idempotent).
3. Set series `start_date = min(occurrence_date)`, `end_date = max(occurrence_date)` so the
   card shows the run span; `start_time` = next/typical session for display.
4. Mark raw items `normalized` (append-only, constitution I).

**Identity keys** (mirror `eventHash` style, `sha1short`):
- **Series:** `norm(title) | norm(venue_name) | source` → `event_series.dedup_hash`.
- **Occurrence:** `series_id | occurrence_date | start_time` → `event_occurrences.dedup_hash`.

**Generalization to "potentially other" recurring sources** (constitution-friendly, registry
already exists, `normalize.ts:16`): provide a shared helper `upsertSeries(series, occurrences[])`
in `lib/pipeline/series.ts`. A normalizer is "recurring-aware" when it returns
`{series, occurrences[]}` instead of a flat event. Covers:
- **Weekly events** → one series + RRULE `FREQ=WEEKLY` + materialized occurrences.
- **Ongoing exhibitions with a date range** → one series, `start_date..end_date`, **zero or
  one** occurrence (it's a span, not sessions) — the series card *is* the exhibition.
- **Single-shot events** → series with exactly one occurrence (or stay in `events`; D5).

### D3 — Enrich / score / notify once-per-series (idempotent)

- **Enrich** (`card-enrich`): change the select from `events WHERE enriched_at IS NULL` to
  **`event_series WHERE enriched_at IS NULL`**. `title_ru`/`description_ru`/`enrichment_json`/
  `enriched_at` live on the **series**. 11 calls, not 104. Idempotency = `enriched_at` set
  once; re-running normalize on an unchanged schedule never clears it.
- **Score / tag**: run on `event_series` (the card). `score`/`tags_json` on the series.
- **Notify**: `notifications` points at a series; the digest renders the **series card + its
  next upcoming occurrence** (`MIN(occurrence_date) WHERE occurrence_date >= today`).
  `notified`/`notified_at` on the series (de-dup per constitution V — don't re-alert a series
  whose schedule merely gained a new date; alert on *new series*, optionally re-alert on a
  *materially new run*, Open Q3).
- **"Don't re-process every time"** = the unchanged-schedule run path does **0** INSERTs and
  **0** `enriched_at` resets; only `last_seen` bumps. This is the explicit goal (b).

### D4 — UI / calendar / feed (data-backed, replaces render-time collapse)

- **Feed** (`Home.tsx` `FeedCard` + `getEvents`): list **series** → one Hemisfèric card per
  film. The current per-row feed (104 cards) becomes ~11.
- **Calendar** (`Home.tsx` `Calendar`): bucket **occurrences** by date; the existing
  `<details>`/"N сеансов" collapse stays, but now reads `occurrences` (data-backed) instead
  of `is_hemisferic` filtering of duplicate event rows. `is_hemisferic` special-case → a
  generic `is_series`/`occurrence_count` flag.
- **Per-entity page** (`app/events/[id]/page.tsx`): show the **full schedule** (all
  occurrences with dates + session times) for a series, not a single date.
- **Required changes**: `lib/queries.ts` gains `getSeries()` (feed) + `getOccurrences()`
  (calendar) and a `SiteSeries` shape carrying `occurrences[]`; `Home.tsx` calendar maps
  occurrences; `toSiteEvent` splits into series/occurrence mappers. (Detail of routing in
  Open Q4: `/events/:id` vs `/series/:id`.)

### D5 — Keep `events` for single-shot; `series` for recurring (recommended)

Don't migrate ALL events into series. Single-shot Telegram/web events stay in `events`
(228 non-Hemisfèric rows untouched). Only **recurring/multi-session** sources populate
`event_series`/`event_occurrences`. The site unions both for the feed. Rationale: smallest,
most reversible change; avoids rewriting 13 normalizers at once. (Alternative: unify
everything under series with single-occurrence rows — cleaner long-term, larger blast radius;
defer to a later spec.)

## Proposed Schema (additive — constitution VI)

```sql
-- The "card": one logical recurring event. Enrichment + score + notify live HERE.
CREATE TABLE IF NOT EXISTS event_series (
    id             SERIAL PRIMARY KEY,
    dedup_hash     TEXT UNIQUE NOT NULL,      -- sha1short(norm(title)|norm(venue)|source)
    title          TEXT NOT NULL,
    description    TEXT,
    category       TEXT,
    language       TEXT,
    audience       TEXT,
    -- run span (derived from occurrences) for the card label:
    start_date     TEXT,                      -- MIN(occurrence_date)
    end_date       TEXT,                      -- MAX(occurrence_date)
    timezone       TEXT DEFAULT 'Europe/Madrid',
    -- recurrence description (optional rule; occurrences remain the truth — D1b):
    recurrence_kind    TEXT,                  -- 'sessions' | 'weekly' | 'date_range' | 'single'
    recurrence_summary TEXT,                  -- human: "ежедневно, 3 сеанса"
    rrule              TEXT,                  -- optional RFC 5545 RRULE/RDATE for rule-based sources
    -- where:
    venue_name     TEXT, district TEXT, address TEXT, city TEXT DEFAULT 'Valencia',
    country TEXT DEFAULT 'Spain', lat DOUBLE PRECISION, lng DOUBLE PRECISION,
    geo_source TEXT, location_notes TEXT,
    -- money/links/media:
    price TEXT, is_free INTEGER, url TEXT, venue_url TEXT, image_url TEXT,
    -- provenance:
    source TEXT, source_url TEXT, external_ref TEXT, raw_excerpt TEXT,
    -- derived + enrichment (ONCE per series):
    tags_json TEXT, metadata_json TEXT,
    title_ru TEXT, description_ru TEXT, links_json TEXT,
    enrichment_json TEXT, enriched_at TEXT,
    status TEXT DEFAULT 'upcoming', score INTEGER,
    notified INTEGER NOT NULL DEFAULT 0, notified_at TEXT,
    first_seen TEXT NOT NULL, last_seen TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_series_start ON event_series(start_date);
CREATE INDEX IF NOT EXISTS idx_series_score ON event_series(score DESC);

-- The "calendar rows": one per (series, date, session-time).
CREATE TABLE IF NOT EXISTS event_occurrences (
    id              SERIAL PRIMARY KEY,
    dedup_hash      TEXT UNIQUE NOT NULL,     -- sha1short(series_id|date|time)
    series_id       INTEGER NOT NULL REFERENCES event_series(id),
    occurrence_date TEXT NOT NULL,            -- YYYY-MM-DD
    start_time      TEXT,                     -- HH:MM (null for all-day / date-range)
    end_time        TEXT,
    status          TEXT DEFAULT 'upcoming',  -- upcoming | cancelled (EXDATE-style)
    source_item_id  INTEGER,                  -- which raw (film,day) produced it
    metadata_json   TEXT,                     -- e.g. all session_times for the day
    first_seen TEXT NOT NULL, last_seen TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_occ_series ON event_occurrences(series_id, occurrence_date);
CREATE INDEX IF NOT EXISTS idx_occ_date   ON event_occurrences(occurrence_date);
```

Notes: column vocabulary copied from `events` so render/format helpers
(`eventLocationLabel`, `formatDateLabel`, `loadTags`) work unchanged. `notifications`
keeps `event_id`; add a nullable `series_id INTEGER REFERENCES event_series(id)` (additive).

## Migration Plan for Existing Rows

**104 Hemisfèric `events` rows → 11 series + 104 occurrences.** Two options:

- **M-A (recommended): regenerate from raw `source_items`.** The 104 append-only raw items
  (`external_id="<day>:<id>:<show>"`, `raw_json.session_times[]`) are intact. Run the
  rewritten `normalizeHemisferic()` to populate `event_series`/`event_occurrences` from
  scratch, then **soft-retire** the old per-day `events` rows by setting
  `status='superseded'` (NOT deleted — constitution I/VI reversible). Cleanest: the new
  normalizer is the single source of truth; no bespoke backfill SQL.
- **M-B: collapse in place.** A one-shot migration script: `GROUP BY seriesHash(title,venue)`
  over `events WHERE source='api:hemisferic'`, INSERT one `event_series` per group (copy the
  best/any row's card fields), INSERT one `event_occurrence` per existing row
  `(start_date, metadata_json.sessions)`, then mark the source `events` `status='superseded'`.
  Use if re-running ingest/normalize is undesirable.

Either way: **no data loss** (raw preserved; old events soft-retired, not dropped), **counts**:
seed today = 104 Hemisfèric event rows → after = **11 `event_series` + 104 `event_occurrences`**
(plus ~228 untouched single-shot `events`). Seed file `data/seed/events.json` either
regenerated post-pipeline or supplemented with `event_series.json`/`event_occurrences.json`.

## Cross-Spec Impact

| Spec | Impact | Needed update |
|------|--------|---------------|
| `001-valencia-events` | **FR-010/SC-002/spec.md §18-36 say "one card per DAY".** This spec changes the model to "one card per FILM (series)". T009 (verify per-day collapse) is superseded. dedup `groupByKey` (T024) intentionally keeps a series split → it must **skip series-owned occurrences** (don't re-dedup occurrences). | **High.** Amend FR-010 to "one series card; calendar shows occurrences"; note dedup runs on series/single-events, not occurrences. |
| `card-enrich` | Enrich select target moves `events → event_series`; `enriched_at`/`enrichment_json` on series. 104→11 enrich calls (cost + idempotency win). Worked example (event 106) shape unchanged. | **High.** Re-point the batch select + write target to `event_series`; everything else (schema shape, web tools) stands. |
| `vercel-workflow` | Per-series enrich step = same fan-out (`Promise.all` of `enrichOne(series)`); a new "materialize series/occurrences" step can be added to `runPipeline`. | **Medium.** Add a normalize→series materialization step; enrich fan-out keys on series. |
| `local-run` | Pure additive tables + `db:setup`/seed; no driver/path change. New seed files load through same `scripts/seed.mjs` path. | **Low.** Add the two tables to schema apply + seed loader. |
| `llm-testing` | Enrich now runs per-series; test fixtures key on a series, not a duplicated row. | **Low.** Update fixture entity. |

## Risks

- **R1 — Feed/calendar split bug:** feed must read series, calendar must read occurrences; a
  half-migration (series exist but calendar still reads `events`) double-shows Hemisfèric.
  *Mitigation:* migrate feed + calendar together; gate old `is_hemisferic` path off.
- **R2 — dedup double-handling:** `dedup.ts` over `events` must NOT also see occurrences, or
  it'll try to merge calendar rows. *Mitigation:* occurrences live in a separate table; dedup
  query unchanged (only scans `events`); series get their own (lighter) dedup if needed.
- **R3 — Notify churn:** a schedule gaining a new date must not re-notify the whole series.
  *Mitigation:* `notified` on series; alert on *new series*, not new occurrence (Open Q3).
- **R4 — Session granularity choice (Open Q1)** changes occurrence row counts (per-session vs
  per-day) and the calendar render — decide before schema lands.
- **R5 — Two card types in the feed** (`events` + `event_series`) means the feed query is a
  UNION; ordering by score across two tables needs care. *Mitigation:* a `SiteEvent`-shaped
  view/mapper over both, sort in JS (feed is already JS-sorted in `Home.tsx`).

## Feasibility / Risk / Effort

| Aspect | Assessment | Notes |
|--------|------------|-------|
| Technical Viability | **High** | Additive tables; raw layer intact for regen; registry + render helpers reusable; well-trodden "event+session" pattern. |
| Risk Level | **Medium** | Touches normalize, queries, Home.tsx, enrich select, dedup scope, seed. Coordinated feed+calendar cutover (R1) is the main hazard. |
| Effort | **L** | New schema + `series.ts` helper + rewrite `hemisferic.ts` + `getSeries`/`getOccurrences` + `Home.tsx` feed/calendar + detail page + migration + cross-spec amendments. Each is small; the surface is wide. |

## Open Questions (for requirements)

1. **Occurrence granularity:** one occurrence **per session** (multiple rows/day, true
   showtimes in the calendar) OR one **per day** with `session_times[]` in JSON (matches
   today's "N сеансов" `<details>`)? Recommend **per-session** (data-backed calendar, future
   per-session cancellations) — confirm.
2. **Keep single-shot events in `events` (D5) or unify all under series** with single
   occurrences? Recommend D5 (smaller blast radius) — confirm.
3. **Notify policy for series:** alert once on new series only? Re-alert when a *new run*
   (new `start_date` after a gap) appears? Never re-alert on added dates within a run?
4. **Routing/identity for the card:** `/events/:id` (union) vs new `/series/:id`? Affects
   `page_url` + `notifications` FK shape.
5. **Series dedup across sources:** if two sources list the same recurring show, do series
   themselves get cross-source dedup (like `events` do), or is series identity strictly
   `title+venue+source`? (Recommend per-source identity now; cross-source series-dedup later.)
6. **`end_time` / `end_date` semantics for date-range exhibitions** (a span, not sessions):
   zero occurrences + series span, or one synthetic occurrence? (Recommend span-only.)

## Sources

- `db/schema.sql:54-163` — events/places/media/notifications schema (column vocabulary reused)
- `lib/pipeline/normalizers/hemisferic.ts:9-66` — current one-row-per-(film,day) INSERT
- `lib/pipeline/ingest.ts:141-186` — `parseHemisferic` per-day fan-out, `session_times[]`
- `lib/pipeline/normalize.ts:16-26` — normalizer registry (extension point)
- `lib/pipeline/dedup.ts:90-148` — `groupByKey` deliberately splits far-apart dates (≠ recurrence)
- `lib/pipeline/util.ts:50-65` — `eventHash` (date-in-hash → per-day rows); pattern for `seriesHash`/`occHash`
- `lib/queries.ts:91-158` — `toSiteEvent`/`getEvents`; `is_hemisferic` special-case (:99)
- `lib/format.ts:81-134` — `formatDateLabel`/`eventLocationLabel` (reusable on series)
- `app/Home.tsx:173-211` — render-time per-day Hemisfèric collapse ("N сеансов" `<details>`)
- `app/Home.tsx:110-152` — feed renders every Hemisfèric row (no feed collapse)
- `app/events/[id]/page.tsx` — single-date detail page (needs full-schedule view)
- `data/seed/events.json` — 104 Hemisfèric rows = 11 films × 14 days (verified by script)
- `specs/001-valencia-events/spec.md:18-36,143` (FR-010 per-DAY collapse — superseded)
- `specs/card-enrich/research.md` Findings 1,5,9 — enrich select/cost; geo stays separate
- `specs/vercel-workflow/research.md` D-WF1 — per-card step fan-out (reuse for per-series)
- `.specify/memory/constitution.md` I (append-only raw), IV (idempotent enrich), VI (reversible/additive)
- RFC 5545 (iCalendar) §3.8.5 — RRULE / RDATE / EXDATE / RECURRENCE-ID recurrence model
- Schema.org `Event` + `subEvent` / `eventSchedule`; Google ScreeningEvent (movie+showtimes) — "event + child session" modeling pattern
