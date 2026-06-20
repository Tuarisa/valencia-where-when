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
