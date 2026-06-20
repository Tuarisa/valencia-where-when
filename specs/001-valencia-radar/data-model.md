# Data Model: Valencia Radar

Phase 1 output. Reflects the **existing** `db/schema.sql` (Neon Postgres) plus the
**additive** growth the consolidated sub-areas require. **No destructive schema
changes** (Constitution VI) — every new column/table/index ships as
`... IF NOT EXISTS` against `db/schema.sql` + `scripts/apply-schema.mjs`.

## Verified facts about the current schema (do not re-add)

- `events` **already has**: `title_ru`, `description_ru`, `links_json`,
  `enrichment_json`, `enriched_at`, `notified`/`notified_at`, `score`, `geo_source`,
  `metadata_json`, `tags_json`, `source_item_id`, `external_ref`, `venue_url`.
- `events` **has NO `maps_url` column** (it has `external_ref` + `venue_url`). The
  events-maps-link storage decision is **resolved**: store the Google-Maps link as a
  `links_json` entry `{label:"Google Maps", url}` (renders today, no migration); only
  add `events.maps_url IF NOT EXISTS` if a later need arises. `places` **does have
  `maps_url`**.
- `places` **has NO enrichment columns** — adding `title_ru`, `description_ru`,
  `links_json`, `enrichment_json`, `enriched_at`, `notified`, `notified_at` is an
  additive change (sub-areas E + G).
- `source_runs` has `http_status`, `item_count`, `parser_version` but **no**
  `duration_ms`, `error_message`, `changed`, or `not_modified` — add `changed` and
  `not_modified` (sub-area A).
- `sources` has **no cadence columns** — add the adaptive-cadence set (sub-area A).
- `notifications` currently has only `event_id` (+ `sent_at`, `channel`, `note`) —
  generalize to events, series, **and** places (sub-areas D + G).

## Entities (existing schema)

### sources
Configured origins. Key fields: `key` (unique), `type` (`telegram|web|ticketing|api`),
`url`, `lang`, `enabled`, `weight` (`gold|good|mine|off`), `last_fetched`.
Used by dedup as the source-weight authority and by the dispatcher for cadence.

### source_runs
Per-execution log: `source_key`, `status`, `started_at`/`finished_at`, `http_status`,
`item_count`, `parser_version`. Observability for FR-017.

### source_items  *(append-only raw — Principle I)*
Raw captured items. Key fields: `dedup_hash` (unique), `source_key`, `external_id`,
`item_type`, `title`, `url`, `raw_text`/`raw_html`/`raw_json`, `first_seen`,
`last_seen`, and the normalization markers `normalized_at`, `normalized_status`
(`pending|normalized|ignored|error`), `normalized_note`. **Never deleted or mutated
by downstream stages** beyond setting these markers / bumping `last_seen`.

### events  *(normalized single-shot)*
The afisha entity for one-off events. Notable fields: identity/text (`dedup_hash`,
`title`, `description`, `category`, `language`, `audience`); when (`start_date`,
`end_date`, `start_time`, `end_time`, `timezone` default `Europe/Madrid`, `status`
default `upcoming`); where (`venue_name`, `district`, `address`, `city`, `country`,
`lat`, `lng`, `geo_source`, `location_notes`); money/links (`price`, `is_free`,
`url`, `venue_url`, `image_url`, `external_ref`); provenance (`source`, `source_url`,
`raw_excerpt`, `source_item_id`); derived (`tags_json`, `metadata_json`, `score`);
enrichment (`title_ru`, `description_ru`, `links_json`, `enrichment_json`,
`enriched_at`); notify (`notified` 0/1, `notified_at`).

### places  *(normalized, independent output)*
The catalog entity. Notable fields: `name`, `description`, `category`, `area`,
`district`, `address`, geo (`lat`,`lng`,`geo_source`), `price_level`, `occasion`,
`recommended_by`, `source`/`source_url`, `maps_url`, `image_url`, `rating`,
`source_item_id`, `tags_json`, `metadata_json`.

### media_assets
Images for an entity: `entity_type` (`event|place`), `entity_id`, `url`,
`is_primary`, `sort_order`, `caption`. Unique on `(entity_type, entity_id, url)`.

### notifications
Delivery log: `event_id`, `sent_at`, `channel`, `note`. Backs FR-013 (no repeats).

## Additive schema changes (by sub-area)

All `IF NOT EXISTS` against `db/schema.sql`, applied by `scripts/apply-schema.mjs`.

### A. Ingestion — adaptive cadence (sub-area A, FR-019)
Add to **`sources`**:
`poll_interval_sec INTEGER`, `min_interval_sec INTEGER`, `max_interval_sec INTEGER`,
`next_due_at TEXT` (ISO; dispatcher cursor), `last_changed_at TEXT` (ISO),
`etag TEXT`, `last_modified TEXT`, `consecutive_unchanged INTEGER NOT NULL DEFAULT 0`,
`observed_gap_sec INTEGER` (EWMA of inter-change gaps),
`fail_count INTEGER NOT NULL DEFAULT 0`.
`CREATE INDEX IF NOT EXISTS idx_sources_due ON sources(enabled, next_due_at)`.

Add to **`source_runs`**: `changed INTEGER` (1 if new items produced),
`not_modified INTEGER` (1 if HTTP 304).

Cadence defaults (seeded per type in `sources.json`/`scripts/seed.mjs`):
`poll_interval = clamp(observed_gap_sec × 0.33, min, max)`; on change reset toward
min (`consecutive_unchanged=0`, `last_changed_at=now`); on no-change
`consecutive_unchanged++`, back-off `× 1.5` (capped); on error `fail_count++`,
`min(base × 2^fail_count, max) + jitter`; EWMA α = 0.3. Per-type bounds: telegram
`min 600s / max 3h`; web `min 1h / max 24h`; ticketing+api `min 2h / max 24h`.

### C. Deduplication — `entity_sources` link table (sub-area C, FR-003/FR-004)
New table (the **source-of-truth** provenance record):
`entity_sources( id SERIAL PK, entity_type TEXT NOT NULL  -- 'event'|'place',
entity_id INTEGER NOT NULL  -- survivor events.id / places.id,
source_item_id INTEGER NOT NULL REFERENCES source_items(id),
source_key TEXT, source_url TEXT, role TEXT NOT NULL DEFAULT 'merged' -- 'primary'|'merged',
match_method TEXT  -- 'url'|'external_id'|'maps_url'|'fuzzy-title'|'fuzzy-name-geo',
match_score DOUBLE PRECISION  -- 1.0 deterministic, <1 fuzzy, created_at TEXT NOT NULL,
UNIQUE(entity_type, entity_id, source_item_id) )`.
Indexes: `(entity_type, entity_id)` and `source_item_id`.

Merge convention (**resolved**, see research C / contradiction #2): losers carry
`status='duplicate'` + `metadata_json.merged_into=<survivor_id>`; the survivor keeps
`metadata_json.sources[]` (events) / `metadata_json.recommended_by[]` (places) as a
denormalized render convenience. The 90 existing seed duplicate rows are migrated to
this single convention before dedup is wired. `entity_sources` is authoritative;
`sources[]` is convenience. Survivor `id` is the **stable canonical id** (reuse
`events.id`/`places.id`; no separate `canonical_id`).

### D. Recurring events — `event_series` + `event_occurrences` (sub-area D, FR-018)
New table **`event_series`** (the card; column vocabulary mirrors `events` so render
helpers work unchanged): `id SERIAL PK`, `dedup_hash TEXT UNIQUE`, `title`,
`description`, `category`, `language`, `audience`, `start_date`, `end_date`,
`timezone` default `Europe/Madrid`, `recurrence_kind` (`sessions|weekly|date_range|single`),
`recurrence_summary`, `rrule` (optional RFC 5545), `venue_name`, `district`, `address`,
`city` default `Valencia`, `country` default `Spain`, `lat`, `lng`, `geo_source`,
`location_notes`, `price`, `is_free`, `url`, `venue_url`, `image_url`, `source`,
`source_url`, `external_ref`, `raw_excerpt`, `tags_json`, `metadata_json`, `title_ru`,
`description_ru`, `links_json`, `enrichment_json`, `enriched_at`, `status` default
`upcoming`, `score`, `notified` default 0, `notified_at`, `first_seen NOT NULL`,
`last_seen NOT NULL`.

New table **`event_occurrences`** (the dated sessions; feeds the calendar):
`id SERIAL PK`, `dedup_hash TEXT UNIQUE`, `series_id INTEGER REFERENCES event_series(id)`,
`occurrence_date TEXT` (YYYY-MM-DD), `start_time TEXT` (HH:MM|null), `end_time TEXT`,
`status TEXT` default `upcoming`, `source_item_id INTEGER`, `metadata_json` (e.g.
`session_times[]`), `first_seen NOT NULL`, `last_seen NOT NULL`.

Indexes: `idx_series_start ON event_series(start_date)`,
`idx_series_score ON event_series(score DESC)`,
`idx_occ_series ON event_occurrences(series_id, occurrence_date)`,
`idx_occ_date ON event_occurrences(occurrence_date)`.

Identity: series `dedup_hash = sha1short(norm(title) | norm(venue_name) | source)`;
occurrence `dedup_hash = sha1short(series_id | occurrence_date | start_time)`.

Seed effect: 104 Hemisfèric `events` rows → **11 `event_series` + 104
`event_occurrences` + ~228 untouched single-shot `events`**. Old Hemisfèric event
rows are marked `status='superseded'` (not deleted). Occurrence granularity =
**per session** (multiple rows/day with true showtimes) — resolved from
repeateable-events Q1.

### E. Enrichment — places columns + canonical schema (sub-area E, FR-008/FR-021)
Add to **`places`** (additive; events already have these):
`title_ru TEXT`, `description_ru TEXT`, `links_json TEXT`, `enrichment_json TEXT`,
`enriched_at TEXT`, `notified INTEGER NOT NULL DEFAULT 0`, `notified_at TEXT`.

Canonical `enrichment_json` shape (single source of truth; persisted whole as an
audit blob, fields promoted to columns with `COALESCE` guards so model nulls never
clobber good values). Constrained-decoding rules: `additionalProperties:false` on
every object; **no** `min/max/minLength/maxLength` in the JSON-schema (bounds checked
in tests); required `[title_ru, description_ru, confidence]`:

```jsonc
{
  "title_ru": "string",                 // short headline, ≤~72 chars (test-checked)
  "description_ru": "string",
  "category": "string|null",
  "start_date": "string|null",          // YYYY-MM-DD
  "end_date": "string|null",
  "start_time": "string|null",          // HH:MM
  "end_time": "string|null",
  "venue_name": "string|null",
  "address": "string|null",
  "district": "string|null",
  "price": "string|null",               // e.g. "40 €"
  "is_free": "boolean|null",
  "maps_url": "string|null",            // uri; only if found/safe
  "image_url": "string|null",           // uri
  "links": [{ "label": "string", "url": "string" }],
  "citations": [{ "url": "string", "supports": "string" }],
  "ocr_text": "string|null",            // raw text read off the poster
  "confidence": 0.0,                    // 0–1, REQUIRED
  "notes": "string|null"                // conflicts / gaps / provenance
}
```

### D + G. Notifications — generalize to series & places (sub-areas D + G, FR-013)
Add to **`notifications`**: `series_id INTEGER REFERENCES event_series(id)` (nullable)
and a way to log place deliveries — either `place_id INTEGER REFERENCES places(id)`
(nullable) **or** the pair `entity_type TEXT` + `entity_id INTEGER`. Keep the
existing `event_id`. Chosen approach: add nullable `series_id` and `place_id` columns
(minimal, additive, keeps `event_id`). A delivery references exactly one of
`event_id` / `series_id` / `place_id`.

## Derived state & rules (new stages)

### Dedup match & merge (FR-003, FR-004) — sub-area C
- **Events block key**: `dedupKey = titleSignature(title) | slugify(city)`.
  **Places block key**: `placeKey = nameSignature(name) | area-or-district-slug | category`.
- **Strong-match pre-pass** (deterministic, `match_score=1.0`): exact normalized
  `url`, `(source, external_id)`, resolved `maps_url`, or person/series URL — before
  any fuzzy comparison.
- **Fuzzy** (pure-TS, no heavy deps): Jaro-Winkler name/title ≥ τ **and** ≥2
  corroborating signals (e.g. name + geo, or title + date within ±3 days). Implement
  Jaro-Winkler (~30–40 lines) + haversine (~8 lines) inline.
- **Geo guard (mandatory)**: proximity NEVER merges alone; only `geo_source='map_url'`
  votes; IGNORE coords when `geo_source='nominatim-area-fallback'` or coords equal a
  known centroid (hardcoded blacklist incl. Madrid Puerta del Sol `40.4168,-3.7035`);
  corroborating distance R = 75–120 m via haversine.
- **Survivor**: max `(sources.weight rank, score)` for events; `(weight-rank,
  has-coords, first_seen)` for places. Conflicting dates resolve to the survivor's.
- **Same-person far-date** (e.g. Komissarenko 2026-06-21 vs 2026-07-21, seed ids
  2/106/110) → link as related via `entity_sources`, **do not** hard-merge.
- **Recurring occurrences are out of scope for dedup**: dedup scans only `events`
  (and `places`), never `event_occurrences`.
- **Invariant**: every contributing source remains discoverable from the survivor.
- **Verification cases**: Komissarenko 3→1 survivor with 3 `entity_sources` rows;
  Madrid-centroid trio (ids 10/11/12) and pool/café trio (ids 4/7/8) MUST NOT merge
  despite identical coords.

### Enrichment state (FR-008, FR-021) — sub-area E
- An event/series/place is **un-enriched** when `enriched_at IS NULL`. Selection:
  `... WHERE enriched_at IS NULL ORDER BY score DESC NULLS LAST LIMIT $limit`.
  Enrichment is idempotent and per-item; on success it writes the promoted columns
  (with `COALESCE` guards), the full `enrichment_json`, and `enriched_at`. On failure:
  leave fields null, record a note, skip (base record stays renderable).
- **Ground-or-flag**: never invent dates/prices/venue/address (null + note the gap);
  conflicts recorded in `notes` with the higher-authority value chosen and confidence
  lowered; every added fact grounded by a `citations[]` url; names/dates/numbers
  preserved verbatim in translation.
- **Model tiering**: default `claude-haiku-4-5-20251001`; escalate to
  `claude-opus-4-8` for poster-only/heavy-OCR, `confidence < 0.8`, or conflict cards.
  Determinism via constrained decoding + `effort: low` (no temperature on Opus 4.8).
  Enrich does **not** call Nominatim — it proposes clean `venue_name`/`address`/
  `maps_url` and `geo.ts` geocodes afterward.
- **Re-enrichment trigger** (resolved): re-enrich when `enriched_at IS NULL` **or**
  `last_seen > enriched_at` (source changed) **or** an explicit force flag.

### Notify state (FR-012–FR-014, FR-021) — sub-area G
- **Digest candidate**: `notified = 0` AND `start_date` within `[today, today+horizon]`
  AND `score ≥ digestThreshold` AND family-fit tags AND `confidence ≥ holdThreshold`.
  On send: set `notified = 1`, `notified_at`, insert a `notifications` row.
  For a series, render the series card + its next upcoming occurrence
  (`MIN(occurrence_date) ≥ today`).
- **Rare alert**: `notified = 0` AND `score ≥ alertThreshold` (higher bar) —
  dispatched out-of-cycle, then marked so the weekly digest won't repeat it.
- **New places block**: places with `notified = 0` newly catalogued since last digest;
  marked on send.

### Scoring (FR-005)
- `events.score` / `event_series.score` ∈ [0,100]: source weight + language +
  category + city + date-horizon + keyword signals; suppresses perennial/tourist
  filler, elevates RU/local/family. (Existing `score.ts`; tune as normalizers add
  categories.)

### Resolved threshold table (named defaults — tune later, but live in ONE place)
- Enrichment: `confidence < 0.6` → hold from digest; `0.6–0.8` → flag for review;
  escalate Haiku→Opus when `< 0.8` or poster-only/conflict.
- Eval: RU-quality `llm-rubric ≥ 0.7`; venue Levenshtein `≥ 0.85`; date match `±0` days.
- Cadence: see sub-area A above (interval × 0.33, back-off × 1.5, EWMA α 0.3, per-type
  bounds); ingest pool concurrency 4–6 via `Promise.allSettled`; 429/`Retry-After`
  backoff.

## State transitions

```
source_item: (raw) --normalize--> normalized_status ∈ {normalized, ignored, error}
                              \--> event | place | (event_series + event_occurrences)

event/series: created --dedup--> survivor | duplicate(merged_into) (+ entity_sources)
                      --score--> scored --tag--> tagged
                      --enrich--> enriched (best-effort, grounded) --geo--> (lat,lng?)
                      --notify--> notified=1 (+ notifications row)

occurrence: created/updated by normalize; idempotent (unchanged schedule = only last_seen bumps);
            never enriched/scored/notified directly (its series is).
```

Canonical stage order: **ingest → normalize → dedup → score → tag → enrich → geo**
(dedup immediately after normalize; enrich before geo so enrich-filled
venue/address raise geo coverage — Constitution V v1.1.0).
