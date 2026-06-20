import { sql } from "../../db";
import { nowIso } from "../util";
import { upsertSeries, type SeriesDraft, type OccurrenceDraft } from "../series";
import type { RawItem } from "./types";

export const HEMISFERIC_SOURCE_KEY = "api:hemisferic";

const VENUE = "L'Hemisfèric";
const ADDRESS = "Av. del Professor López Piñero, 7, Valencia";

interface RawHemisferic {
  show_name?: string;
  schedule_date?: string;
  session_times?: string[];
  poster_url?: string | null;
  description?: string | null;
}

function parseRaw(item: RawItem): RawHemisferic {
  try {
    const r = JSON.parse(item.raw_json || "{}");
    return r && typeof r === "object" ? r : {};
  } catch {
    return {};
  }
}

// PURE: turn pending Hemisfèric raw rows into series (one per film) + occurrences
// (one per day × session). This is the model change (research D4): the schedule is
// 11 films × ~9–14 days = 104 raw rows → 11 series, NOT 104 single-shot events.
// Each film is enriched/scored/notified ONCE (via its series); the calendar buckets
// the occurrences by date. DB-free so it unit-tests without a connection.
export function buildHemisfericSeries(
  rows: RawItem[],
): Array<{ series: SeriesDraft; occurrences: OccurrenceDraft[] }> {
  const byShow = new Map<
    string,
    { series: SeriesDraft; occurrences: OccurrenceDraft[]; days: string[] }
  >();

  for (const item of rows) {
    const raw = parseRaw(item);
    const showName = raw.show_name || item.title || "Hemisfèric";
    const day = raw.schedule_date || (item.published_at || "").slice(0, 10) || null;
    const sessions = Array.isArray(raw.session_times) ? raw.session_times : [];

    let group = byShow.get(showName);
    if (!group) {
      group = {
        series: {
          title: showName,
          description: raw.description || showName,
          category: "show",
          language: "es",
          audience: "family",
          recurrence_kind: "sessions",
          venue_name: VENUE,
          district: "Quatre Carreres",
          address: ADDRESS,
          city: "Valencia",
          country: "Spain",
          image_url: raw.poster_url || null,
          url: item.url ?? null,
          source: HEMISFERIC_SOURCE_KEY,
          source_url: item.url ?? null,
          raw_excerpt: item.raw_text ?? null,
        },
        occurrences: [],
        days: [],
      };
      byShow.set(showName, group);
    }
    // backfill a poster/description if the first row lacked one
    if (!group.series.image_url && raw.poster_url) group.series.image_url = raw.poster_url;

    if (day) group.days.push(day);
    const sessionTimes = sessions.length ? sessions : [null];
    for (const t of sessionTimes) {
      group.occurrences.push({
        occurrence_date: day || "",
        start_time: t,
        source_item_id: item.id,
        metadata_json: sessions.length ? JSON.stringify({ session_times: sessions }) : null,
      });
    }
  }

  const out: Array<{ series: SeriesDraft; occurrences: OccurrenceDraft[] }> = [];
  for (const { series, occurrences, days } of byShow.values()) {
    const dated = days.filter(Boolean).sort();
    series.start_date = dated[0] ?? null;
    series.end_date = dated[dated.length - 1] ?? null;
    // drop occurrences with no usable date (can't place them on the calendar)
    out.push({ series, occurrences: occurrences.filter((o) => o.occurrence_date) });
  }
  return out;
}

// Normalizer for the Hemisfèric schedule API. Reads pending raw rows, groups them
// into series + occurrences, and upserts each via the idempotent `upsertSeries`
// (re-ingesting an unchanged schedule inserts nothing new and preserves enrichment).
// `exec` is injectable for tests; never deletes raw rows (constitution I).
export async function normalizeHemisferic(
  { exec = sql }: { exec?: typeof sql } = {},
): Promise<{ created: number; updated: number; processed: number }> {
  const rows = (await exec`
    SELECT * FROM source_items
    WHERE source_key = 'api:hemisferic'
      AND (normalized_status IS NULL OR normalized_status = 'pending'
           OR normalized_at IS NULL OR normalized_at < last_seen)
  `) as unknown as RawItem[];

  const groups = buildHemisfericSeries(rows);
  const ts = nowIso();
  let created = 0;
  let updated = 0;

  for (const g of groups) {
    const res = await upsertSeries(g.series, g.occurrences, { exec });
    if (res.seriesInserted) created++;
    else updated++;
  }

  for (const item of rows) {
    await exec`UPDATE source_items
      SET normalized_at = ${ts}, normalized_status = 'normalized'
      WHERE id = ${item.id}`;
  }

  return { created, updated, processed: rows.length };
}
