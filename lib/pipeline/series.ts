import { sql } from "../db";
import { norm, nowIso, sha1short } from "./util";

// Recurring / many-session offerings (sub-area D, research D1/D2). A parent
// `event_series` (the card) + child `event_occurrences` (the dated sessions). A
// recurrence-aware normalizer builds one SeriesDraft + N OccurrenceDrafts and calls
// `upsertSeries`, which is IDEMPOTENT: re-ingesting an unchanged schedule inserts
// nothing new and never resets `enriched_at`/`score`/`notified` (only bumps
// `last_seen`). Enrich/score/notify then run ONCE per series, not per occurrence.
// Pure helpers are DB-free + unit-testable; `upsertSeries({exec})` takes an
// injectable executor (mirrors dedup) so it never opens a DB at import time.

export interface SeriesDraft {
  title: string;
  description?: string | null;
  category?: string | null;
  language?: string | null;
  audience?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  timezone?: string | null;
  recurrence_kind?: string | null; // sessions | weekly | date_range | single
  recurrence_summary?: string | null;
  venue_name?: string | null;
  district?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  price?: string | null;
  is_free?: number | null;
  url?: string | null;
  venue_url?: string | null;
  image_url?: string | null;
  source: string;
  source_url?: string | null;
  external_ref?: string | null;
  raw_excerpt?: string | null;
}

export interface OccurrenceDraft {
  occurrence_date: string; // YYYY-MM-DD
  start_time?: string | null; // HH:MM
  end_time?: string | null;
  status?: string | null;
  source_item_id?: number | null;
  metadata_json?: string | null;
}

// PURE: stable series identity — norm(title) | norm(venue) | source. Same show from
// the same source collapses to one series row (cross-source series dedup is deferred).
export function seriesHash(s: Pick<SeriesDraft, "title" | "venue_name" | "source">): string {
  return sha1short(`${norm(s.title)}|${norm(s.venue_name)}|${s.source}`);
}

// PURE: stable occurrence identity — series_id | date | start_time. One row per
// (series, date, session); re-running an unchanged schedule hits the same hash.
export function occurrenceHash(seriesId: number, occurrenceDate: string, startTime?: string | null): string {
  return sha1short(`${seriesId}|${occurrenceDate}|${startTime ?? ""}`);
}

export interface UpsertSeriesResult {
  seriesId: number;
  seriesInserted: boolean;
  occurrences: number;
}

// Idempotent upsert of one series + its occurrences. ON CONFLICT(dedup_hash) updates
// only normalizer-owned fields + last_seen — it deliberately does NOT touch
// score / enriched_at / enrichment_json / title_ru / description_ru / notified, so a
// re-ingest preserves all downstream enrichment/scoring/notify state (constitution
// IV idempotency). Returns the stable series id and how many occurrences it owns.
export async function upsertSeries(
  series: SeriesDraft,
  occurrences: OccurrenceDraft[],
  { exec = sql }: { exec?: typeof sql } = {},
): Promise<UpsertSeriesResult> {
  const ts = nowIso();
  const hash = seriesHash(series);
  const tz = series.timezone ?? "Europe/Madrid";
  const city = series.city ?? "Valencia";
  const country = series.country ?? "Spain";

  const rows = (await exec`
    INSERT INTO event_series (
      dedup_hash, title, description, category, language, audience,
      start_date, end_date, timezone, recurrence_kind, recurrence_summary,
      venue_name, district, address, city, country,
      price, is_free, url, venue_url, image_url,
      source, source_url, external_ref, raw_excerpt,
      status, first_seen, last_seen
    ) VALUES (
      ${hash}, ${series.title}, ${series.description ?? null}, ${series.category ?? null},
      ${series.language ?? null}, ${series.audience ?? null},
      ${series.start_date ?? null}, ${series.end_date ?? null}, ${tz},
      ${series.recurrence_kind ?? null}, ${series.recurrence_summary ?? null},
      ${series.venue_name ?? null}, ${series.district ?? null}, ${series.address ?? null},
      ${city}, ${country},
      ${series.price ?? null}, ${series.is_free ?? null}, ${series.url ?? null},
      ${series.venue_url ?? null}, ${series.image_url ?? null},
      ${series.source}, ${series.source_url ?? null}, ${series.external_ref ?? null},
      ${series.raw_excerpt ?? null},
      'upcoming', ${ts}, ${ts}
    )
    ON CONFLICT (dedup_hash) DO UPDATE SET
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      category = EXCLUDED.category,
      start_date = EXCLUDED.start_date,
      end_date = EXCLUDED.end_date,
      recurrence_kind = EXCLUDED.recurrence_kind,
      recurrence_summary = EXCLUDED.recurrence_summary,
      venue_name = EXCLUDED.venue_name,
      district = EXCLUDED.district,
      address = EXCLUDED.address,
      price = EXCLUDED.price,
      is_free = EXCLUDED.is_free,
      url = EXCLUDED.url,
      image_url = EXCLUDED.image_url,
      last_seen = ${ts}
    RETURNING id, (xmax = 0) AS inserted
  `) as unknown as Array<{ id: number; inserted: boolean }>;

  const seriesId = rows[0].id;
  const seriesInserted = rows[0].inserted === true;

  for (const occ of occurrences) {
    const occHash = occurrenceHash(seriesId, occ.occurrence_date, occ.start_time);
    await exec`
      INSERT INTO event_occurrences (
        dedup_hash, series_id, occurrence_date, start_time, end_time,
        status, source_item_id, metadata_json, first_seen, last_seen
      ) VALUES (
        ${occHash}, ${seriesId}, ${occ.occurrence_date}, ${occ.start_time ?? null},
        ${occ.end_time ?? null}, ${occ.status ?? "upcoming"}, ${occ.source_item_id ?? null},
        ${occ.metadata_json ?? null}, ${ts}, ${ts}
      )
      ON CONFLICT (dedup_hash) DO UPDATE SET
        start_time = EXCLUDED.start_time,
        end_time = EXCLUDED.end_time,
        status = EXCLUDED.status,
        last_seen = ${ts}
    `;
  }

  return { seriesId, seriesInserted, occurrences: occurrences.length };
}
