# Data Model: Valencia Radar

Phase 1 output. Reflects the existing `db/schema.sql` (Neon Postgres) plus the
derived state the new stages rely on. **No destructive schema changes** — additions
only if a needed column is missing.

## Entities (existing schema)

### sources
Configured origins. Key fields: `key` (unique), `type` (`telegram|web|ticketing|api`),
`url`, `lang`, `enabled`, `weight` (`gold|good|mine|off`), `last_fetched`.
Used by dedup as the source-weight authority.

### source_runs
Per-execution log: `source_key`, `status`, `started_at`/`finished_at`, `http_status`,
`item_count`, `parser_version`. Observability for FR-017.

### source_items  *(append-only raw — Principle I)*
Raw captured items. Key fields: `dedup_hash` (unique), `source_key`, `external_id`,
`item_type`, `title`, `url`, `raw_text`/`raw_html`/`raw_json`, and the normalization
markers `normalized_at`, `normalized_status` (`normalized|ignored|error`),
`normalized_note`. **Never deleted or mutated by downstream stages** beyond setting
these markers.

### events  *(normalized)*
The afisha entity. Notable fields:
- Identity/text: `dedup_hash`, `title`, `description`, `category`, `language`, `audience`.
- When: `start_date`, `end_date`, `start_time`, `end_time`, `timezone` (default
  `Europe/Madrid`), `status` (default `upcoming`).
- Where: `venue_name`, `district`, `address`, `city`, `country`, `lat`, `lng`,
  `geo_source`, `location_notes`.
- Money/links: `price`, `is_free`, `url`, `venue_url`, `image_url`.
- Provenance: `source`, `source_url`, `raw_excerpt`, `source_item_id`.
- Derived: `tags_json`, `metadata_json`, `score`.
- Enrichment: `title_ru`, `description_ru`, `links_json`, `enrichment_json`,
  `enriched_at`.
- Notify: `notified` (0/1), `notified_at`.

### places  *(normalized, independent output)*
The catalog entity. Notable fields: `name`, `description`, `category`, `area`,
`district`, `address`, geo (`lat`,`lng`,`geo_source`), `price_level`, `occasion`,
`recommended_by`, `source`/`source_url`, `maps_url`, `image_url`, `rating`,
`tags_json`, `metadata_json`.

### media_assets
Images for an entity: `entity_type` (`event|place`), `entity_id`, `url`,
`is_primary`, `sort_order`, `caption`. Unique on `(entity_type, entity_id, url)`.

### notifications
Delivery log: `event_id`, `sent_at`, `channel`, `note`. Backs FR-013 (no repeats).

## Derived state & rules (new stages)

### Dedup match & merge (FR-003, FR-004)
- **Match key**: normalized title/person slug + `city` + date-window (±N days).
- **Survivor**: max `(sources.weight rank, events.score)`.
- **Merge rule**: survivor keeps its own `start_date`; all losers' `source`/`source_url`
  accumulate into `survivor.metadata_json.sources[]`; losers soft-collapse.
- **Invariant**: every contributing source remains discoverable from the survivor.

### Enrichment state (FR-008)
- An event is **un-enriched** when `enriched_at IS NULL`. Enrichment is idempotent
  and per-item; on success sets `title_ru`, `description_ru`, `links_json`,
  `enrichment_json`, `enriched_at`. On failure: leave fields null, record note, skip.

### Notify state (FR-012–FR-014)
- **Digest candidate**: `notified = 0` AND `start_date` within [today, today+horizon]
  AND `score ≥ digestThreshold` AND family-fit tags. On send: set `notified = 1`,
  `notified_at`, and insert a `notifications` row.
- **Rare alert**: `notified = 0` AND `score ≥ alertThreshold` (higher) — dispatched
  out-of-cycle, then marked like above so the weekly digest won't repeat it.

### Scoring (FR-005)
- `events.score` ∈ [0,100]: source weight + language + category + city + date-horizon
  + keyword signals; suppresses perennial/tourist filler, elevates RU/local/family.
  (Existing `score.ts`; tune as normalizers add categories.)

## State transitions

```
source_item: (raw) --normalize--> normalized_status ∈ {normalized, ignored, error}
                              \--> event/place created (if normalized)
event: created --score--> scored --tag--> tagged --geo--> (lat,lng?) 
              --dedup--> survivor|collapsed
              --enrich--> enriched (best-effort)
              --notify--> notified=1 (+ notifications row)
```
