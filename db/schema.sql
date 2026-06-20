-- Valencia Radar — Postgres schema (Neon / Vercel Postgres).
-- Ported from the SQLite prototype. Layer 1: ingestion store.
-- Notification + web/map layers read from here.

CREATE TABLE IF NOT EXISTS sources (
    id           SERIAL PRIMARY KEY,
    key          TEXT UNIQUE NOT NULL,
    name         TEXT NOT NULL,
    type         TEXT NOT NULL,          -- telegram | web | ticketing | api
    url          TEXT NOT NULL,
    lang         TEXT,
    enabled      INTEGER NOT NULL DEFAULT 1,
    weight       TEXT,                   -- gold | good | mine | off
    last_fetched TEXT,
    notes        TEXT
);

CREATE TABLE IF NOT EXISTS source_runs (
    id             SERIAL PRIMARY KEY,
    source_key     TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'ok',
    started_at     TEXT NOT NULL,
    finished_at    TEXT,
    fetched_url    TEXT,
    http_status    INTEGER,
    item_count     INTEGER,
    parser_version TEXT,
    notes          TEXT
);
CREATE INDEX IF NOT EXISTS idx_source_runs_source ON source_runs(source_key, started_at DESC);

CREATE TABLE IF NOT EXISTS source_items (
    id                SERIAL PRIMARY KEY,
    dedup_hash        TEXT UNIQUE NOT NULL,
    source_key        TEXT NOT NULL,
    run_id            INTEGER REFERENCES source_runs(id),
    external_id       TEXT,
    item_type         TEXT,
    title             TEXT,
    url               TEXT,
    published_at      TEXT,
    raw_text          TEXT,
    raw_html          TEXT,
    raw_json          TEXT,
    normalized_at     TEXT,
    normalized_status TEXT,
    normalized_note   TEXT,
    first_seen        TEXT NOT NULL,
    last_seen         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_items_source ON source_items(source_key, last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_source_items_type ON source_items(item_type);

CREATE TABLE IF NOT EXISTS events (
    id             SERIAL PRIMARY KEY,
    dedup_hash     TEXT UNIQUE NOT NULL,
    title          TEXT NOT NULL,
    description    TEXT,
    category       TEXT,
    language       TEXT,
    audience       TEXT,
    start_date     TEXT,
    end_date       TEXT,
    start_time     TEXT,
    end_time       TEXT,
    timezone       TEXT DEFAULT 'Europe/Madrid',
    venue_name     TEXT,
    district       TEXT,
    address        TEXT,
    city           TEXT DEFAULT 'Valencia',
    country        TEXT DEFAULT 'Spain',
    lat            DOUBLE PRECISION,
    lng            DOUBLE PRECISION,
    geo_source     TEXT,
    location_notes TEXT,
    price          TEXT,
    is_free        INTEGER,
    url            TEXT,
    venue_url      TEXT,
    image_url      TEXT,
    external_ref   TEXT,
    source         TEXT,
    source_url     TEXT,
    raw_excerpt    TEXT,
    source_item_id INTEGER,
    tags_json      TEXT,
    metadata_json  TEXT,
    title_ru       TEXT,
    description_ru TEXT,
    links_json     TEXT,
    enrichment_json TEXT,
    enriched_at    TEXT,
    status         TEXT DEFAULT 'upcoming',
    score          INTEGER,
    first_seen     TEXT NOT NULL,
    last_seen      TEXT NOT NULL,
    notified       INTEGER NOT NULL DEFAULT 0,
    notified_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_start    ON events(start_date);
CREATE INDEX IF NOT EXISTS idx_events_notified ON events(notified);
CREATE INDEX IF NOT EXISTS idx_events_cat      ON events(category);

CREATE TABLE IF NOT EXISTS places (
    id             SERIAL PRIMARY KEY,
    dedup_hash     TEXT UNIQUE NOT NULL,
    name           TEXT NOT NULL,
    description    TEXT,
    category       TEXT,
    area           TEXT,
    district       TEXT,
    address        TEXT,
    city           TEXT DEFAULT 'Valencia',
    country        TEXT DEFAULT 'Spain',
    lat            DOUBLE PRECISION,
    lng            DOUBLE PRECISION,
    geo_source     TEXT,
    location_notes TEXT,
    price_level    TEXT,
    occasion       TEXT,
    recommended_by TEXT,
    source         TEXT,
    source_url     TEXT,
    url            TEXT,
    maps_url       TEXT,
    image_url      TEXT,
    rating         TEXT,
    notes          TEXT,
    external_ref   TEXT,
    source_item_id INTEGER,
    tags_json      TEXT,
    metadata_json  TEXT,
    first_seen     TEXT NOT NULL,
    last_seen      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_places_cat  ON places(category);
CREATE INDEX IF NOT EXISTS idx_places_area ON places(area);

CREATE TABLE IF NOT EXISTS media_assets (
    id             SERIAL PRIMARY KEY,
    entity_type    TEXT NOT NULL,
    entity_id      INTEGER NOT NULL,
    source_item_id INTEGER,
    url            TEXT NOT NULL,
    mime_type      TEXT,
    width          INTEGER,
    height         INTEGER,
    caption        TEXT,
    credit         TEXT,
    sort_order     INTEGER NOT NULL DEFAULT 0,
    is_primary     INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    UNIQUE(entity_type, entity_id, url)
);
CREATE INDEX IF NOT EXISTS idx_media_entity ON media_assets(entity_type, entity_id, sort_order);

CREATE TABLE IF NOT EXISTS notifications (
    id       SERIAL PRIMARY KEY,
    event_id INTEGER REFERENCES events(id),
    sent_at  TEXT NOT NULL,
    channel  TEXT,
    note     TEXT
);

-- ============================================================================
-- Additive growth for 001-valencia-radar (sub-areas A/C/D/E/G).
-- Constitution VI: additive only, IF NOT EXISTS, never destructive. See
-- specs/001-valencia-radar/data-model.md. event_series is created before the
-- notifications/occurrences references below.
-- ============================================================================

-- A. Ingestion: per-source adaptive cadence + run change-detection.
ALTER TABLE sources
    ADD COLUMN IF NOT EXISTS poll_interval_sec     INTEGER,
    ADD COLUMN IF NOT EXISTS min_interval_sec      INTEGER,
    ADD COLUMN IF NOT EXISTS max_interval_sec      INTEGER,
    ADD COLUMN IF NOT EXISTS next_due_at           TEXT,
    ADD COLUMN IF NOT EXISTS last_changed_at       TEXT,
    ADD COLUMN IF NOT EXISTS etag                  TEXT,
    ADD COLUMN IF NOT EXISTS last_modified         TEXT,
    ADD COLUMN IF NOT EXISTS consecutive_unchanged INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS observed_gap_sec      INTEGER,
    ADD COLUMN IF NOT EXISTS fail_count            INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_sources_due ON sources(enabled, next_due_at);

ALTER TABLE source_runs
    ADD COLUMN IF NOT EXISTS changed      INTEGER,
    ADD COLUMN IF NOT EXISTS not_modified INTEGER;

-- C. Deduplication: contributor link table (source-of-truth provenance).
CREATE TABLE IF NOT EXISTS entity_sources (
    id             SERIAL PRIMARY KEY,
    entity_type    TEXT NOT NULL,                         -- event | place
    entity_id      INTEGER NOT NULL,                      -- survivor events.id / places.id
    source_item_id INTEGER NOT NULL REFERENCES source_items(id),
    source_key     TEXT,
    source_url     TEXT,
    role           TEXT NOT NULL DEFAULT 'merged',        -- primary | merged
    match_method   TEXT,                                  -- url | external_id | maps_url | fuzzy-title | fuzzy-name-geo
    match_score    DOUBLE PRECISION,                      -- 1.0 deterministic, <1 fuzzy
    created_at     TEXT NOT NULL,
    UNIQUE(entity_type, entity_id, source_item_id)
);
CREATE INDEX IF NOT EXISTS idx_entity_sources_entity ON entity_sources(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_sources_item   ON entity_sources(source_item_id);

-- D. Recurring events: parent series (the card) + child occurrences (calendar).
CREATE TABLE IF NOT EXISTS event_series (
    id                 SERIAL PRIMARY KEY,
    dedup_hash         TEXT UNIQUE NOT NULL,
    title              TEXT NOT NULL,
    description        TEXT,
    category           TEXT,
    language           TEXT,
    audience           TEXT,
    start_date         TEXT,
    end_date           TEXT,
    timezone           TEXT DEFAULT 'Europe/Madrid',
    recurrence_kind    TEXT,                              -- sessions | weekly | date_range | single
    recurrence_summary TEXT,
    rrule              TEXT,
    venue_name         TEXT,
    district           TEXT,
    address            TEXT,
    city               TEXT DEFAULT 'Valencia',
    country            TEXT DEFAULT 'Spain',
    lat                DOUBLE PRECISION,
    lng                DOUBLE PRECISION,
    geo_source         TEXT,
    location_notes     TEXT,
    price              TEXT,
    is_free            INTEGER,
    url                TEXT,
    venue_url          TEXT,
    image_url          TEXT,
    source             TEXT,
    source_url         TEXT,
    external_ref       TEXT,
    raw_excerpt        TEXT,
    tags_json          TEXT,
    metadata_json      TEXT,
    title_ru           TEXT,
    description_ru     TEXT,
    links_json         TEXT,
    enrichment_json    TEXT,
    enriched_at        TEXT,
    status             TEXT DEFAULT 'upcoming',
    score              INTEGER,
    notified           INTEGER NOT NULL DEFAULT 0,
    notified_at        TEXT,
    first_seen         TEXT NOT NULL,
    last_seen          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_series_start ON event_series(start_date);
CREATE INDEX IF NOT EXISTS idx_series_score ON event_series(score DESC);

CREATE TABLE IF NOT EXISTS event_occurrences (
    id              SERIAL PRIMARY KEY,
    dedup_hash      TEXT UNIQUE NOT NULL,
    series_id       INTEGER REFERENCES event_series(id),
    occurrence_date TEXT,                                 -- YYYY-MM-DD
    start_time      TEXT,                                 -- HH:MM
    end_time        TEXT,
    status          TEXT DEFAULT 'upcoming',
    source_item_id  INTEGER,
    metadata_json   TEXT,
    first_seen      TEXT NOT NULL,
    last_seen       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_occ_series ON event_occurrences(series_id, occurrence_date);
CREATE INDEX IF NOT EXISTS idx_occ_date   ON event_occurrences(occurrence_date);

-- E/G. Places enrichment + notification state (events already carry these).
ALTER TABLE places
    ADD COLUMN IF NOT EXISTS title_ru        TEXT,
    ADD COLUMN IF NOT EXISTS description_ru  TEXT,
    ADD COLUMN IF NOT EXISTS links_json      TEXT,
    ADD COLUMN IF NOT EXISTS enrichment_json TEXT,
    ADD COLUMN IF NOT EXISTS enriched_at     TEXT,
    ADD COLUMN IF NOT EXISTS notified        INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS notified_at     TEXT;

-- D/G. Notifications: generalize to series + places (keep event_id).
ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS series_id INTEGER REFERENCES event_series(id),
    ADD COLUMN IF NOT EXISTS place_id  INTEGER REFERENCES places(id);
