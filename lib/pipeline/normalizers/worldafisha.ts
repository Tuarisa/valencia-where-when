import { sql } from "../../db";
import { compact, eventHash, nowIso } from "../util";
import { isSpainEvent, hasNonSpainSignal } from "./spain-filter";
import type { RawItem } from "./types";

// T110 — worldafisha.com (web source, key `web:worldafisha`, id 9). This is the
// "Зарубежная афиша" RU artist-tours feed — the SAME catalogue as tg:concerten
// (T136), but worldafisha lists tours across ALL of Europe, so we MUST pre-filter to
// Spain (T131 spain-filter) or the feed overloads with Berlin/Paris/Lisbon dates a
// Valencia family can't attend. Raw rows arrive from the generic web parser as
// `link_card` (per-listing anchor) or `page_snapshot` (the listing page itself); we
// parse artist / show / date / city out of the title+text and emit ONE event per
// item. Fail-soft: an unparseable row is skipped, never throws (constitution:
// pipeline is fail-soft + append-only).

export const WORLDAFISHA_SOURCE_KEY = "web:worldafisha";
const SOURCE_URL = "https://worldafisha.com/events/ispaniya";

interface RawWeb {
  kind?: string;
  source_page?: string;
  meta?: Record<string, string>;
}

function parseRaw(item: RawItem): RawWeb {
  try {
    const r = JSON.parse(item.raw_json || "{}");
    return r && typeof r === "object" ? r : {};
  } catch {
    return {};
  }
}

// Month names (RU + ES + EN stems) → 1-based month. Substring-keyed so "июня",
// "июнь", "junio", "june" all resolve.
const MONTHS: Array<[RegExp, number]> = [
  [/янв|enero|january|jan/i, 1],
  [/февр|febrero|february|feb/i, 2],
  [/март|марта|marzo|march|mar/i, 3],
  [/апрел|abril|april|apr/i, 4],
  [/ма[йя]|mayo|may/i, 5],
  [/июн|junio|june|jun/i, 6],
  [/июл|julio|july|jul/i, 7],
  [/авг|agosto|august|aug/i, 8],
  [/сент|septiembre|september|sep/i, 9],
  [/октяб|octubre|october|oct/i, 10],
  [/нояб|noviembre|november|nov/i, 11],
  [/декаб|diciembre|december|dec/i, 12],
];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// PURE: best-effort ISO date (YYYY-MM-DD) from free RU/ES/EN text. Handles
// "21 июня 2026", "21 июня", "21 de junio", "2026-06-21", "21.06.2026", "21/06".
// Returns null when no usable date is present (the event can still render undated).
export function parseEventDate(text?: string | null, today: Date = new Date()): string | null {
  const t = compact(text);
  if (!t) return null;

  // ISO already present
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // numeric DD.MM.YYYY / DD/MM/YYYY / DD-MM-YYYY (also DD.MM with no year)
  const num = /\b(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?\b/.exec(t);
  if (num) {
    const day = Number(num[1]);
    const month = Number(num[2]);
    let year = num[3] ? Number(num[3]) : today.getFullYear();
    if (year < 100) year += 2000;
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      // if no year and the date already passed this year, roll to next year
      if (!num[3] && month < today.getMonth() + 1) year += 1;
      return `${year}-${pad(month)}-${pad(day)}`;
    }
  }

  // "<day> <monthName> [<year>]" (RU/ES, optional "de")
  const named = /\b(\d{1,2})\s+(?:de\s+)?([A-Za-zА-Яа-яёЁ]{3,})\.?(?:\s+(?:de\s+)?(\d{4}))?/u.exec(t);
  if (named) {
    const day = Number(named[1]);
    const monthWord = named[2];
    let month = 0;
    for (const [re, m] of MONTHS) {
      if (re.test(monthWord)) {
        month = m;
        break;
      }
    }
    if (month && day >= 1 && day <= 31) {
      let year = named[3] ? Number(named[3]) : today.getFullYear();
      if (!named[3] && month < today.getMonth() + 1) year += 1;
      return `${year}-${pad(month)}-${pad(day)}`;
    }
  }
  return null;
}

// PURE: turn pending worldafisha raw rows into event drafts, Spain-filtered. The
// snapshot row (the whole listing page) is dropped — it has no single event identity;
// only the per-listing `link_card` rows (and any titled item carrying a Spain signal)
// become events. DB-free so it unit-tests without a connection.
export function buildWorldafishaEvents(
  rows: RawItem[],
  today: Date = new Date(),
): Array<{ draft: EventInsert; sourceItemId: number }> {
  const out: Array<{ draft: EventInsert; sourceItemId: number }> = [];
  for (const item of rows) {
    const raw = parseRaw(item);
    // The full-page snapshot is the index, not an event — skip it.
    if (raw.kind === "page_snapshot") continue;

    const title = compact(item.title);
    if (!title) continue;

    // Spain gate: the listing spans all of Europe. Keep ONLY explicit-Spain items,
    // and additionally drop anything that names a clearly non-Spain hub (a tour line
    // like "Madrid · Berlin" stays; a pure "Berlin" line is dropped).
    const haystack = `${title} ${item.raw_text || ""} ${item.url || ""}`;
    if (!isSpainEvent(haystack)) continue;
    if (hasNonSpainSignal(haystack) && !isSpainEvent(title)) {
      // signal lives only in the body and a non-Spain hub is present → too ambiguous
      // to keep without a Spain signal in the title itself.
      continue;
    }

    const start = parseEventDate(haystack, today);
    out.push({
      sourceItemId: item.id,
      draft: {
        title: title.slice(0, 300),
        description: compact(item.raw_text)?.slice(0, 2000) ?? null,
        category: "concert",
        language: "ru",
        audience: "adult",
        start_date: start,
        city: "Valencia",
        country: "Spain",
        url: item.url ?? SOURCE_URL,
        image_url: raw.meta?.["og:image"] || null,
        source: WORLDAFISHA_SOURCE_KEY,
        source_url: item.url ?? SOURCE_URL,
        raw_excerpt: compact(item.raw_text)?.slice(0, 1000) ?? null,
      },
    });
  }
  return out;
}

// Minimal shape this normalizer writes into `events` (subset of the table columns).
export interface EventInsert {
  title: string;
  description?: string | null;
  category?: string | null;
  language?: string | null;
  audience?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  start_time?: string | null;
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
  source?: string | null;
  source_url?: string | null;
  raw_excerpt?: string | null;
}

// Idempotent upsert of one plain event. Mirrors `upsertSeries`: ON CONFLICT(dedup_hash)
// updates only normalizer-owned fields + last_seen, never touching score / enriched_at /
// enrichment_json / title_ru / description_ru / notified (so a re-ingest preserves all
// downstream enrichment/scoring/notify state — constitution IV idempotency). Returns
// whether the row was freshly inserted.
export async function upsertPlainEvent(
  draft: EventInsert,
  sourceItemId: number,
  exec: typeof sql = sql,
): Promise<{ inserted: boolean }> {
  const ts = nowIso();
  const hash = eventHash({
    title: draft.title,
    start_date: draft.start_date,
    end_date: draft.end_date,
    venue_name: draft.venue_name,
    address: draft.address,
  });
  const rows = (await exec`
    INSERT INTO events (
      dedup_hash, title, description, category, language, audience,
      start_date, end_date, start_time, venue_name, district, address,
      city, country, price, is_free, url, venue_url, image_url,
      source, source_url, raw_excerpt, source_item_id,
      status, first_seen, last_seen
    ) VALUES (
      ${hash}, ${draft.title}, ${draft.description ?? null}, ${draft.category ?? null},
      ${draft.language ?? null}, ${draft.audience ?? null},
      ${draft.start_date ?? null}, ${draft.end_date ?? null}, ${draft.start_time ?? null},
      ${draft.venue_name ?? null}, ${draft.district ?? null}, ${draft.address ?? null},
      ${draft.city ?? "Valencia"}, ${draft.country ?? "Spain"},
      ${draft.price ?? null}, ${draft.is_free ?? null}, ${draft.url ?? null},
      ${draft.venue_url ?? null}, ${draft.image_url ?? null},
      ${draft.source ?? null}, ${draft.source_url ?? null}, ${draft.raw_excerpt ?? null},
      ${sourceItemId}, 'upcoming', ${ts}, ${ts}
    )
    ON CONFLICT (dedup_hash) DO UPDATE SET
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      category = EXCLUDED.category,
      start_date = EXCLUDED.start_date,
      end_date = EXCLUDED.end_date,
      start_time = EXCLUDED.start_time,
      venue_name = EXCLUDED.venue_name,
      district = EXCLUDED.district,
      address = EXCLUDED.address,
      price = EXCLUDED.price,
      is_free = EXCLUDED.is_free,
      url = EXCLUDED.url,
      image_url = EXCLUDED.image_url,
      source_item_id = EXCLUDED.source_item_id,
      last_seen = ${ts}
    RETURNING (xmax = 0) AS inserted
  `) as unknown as Array<{ inserted: boolean }>;
  return { inserted: rows[0]?.inserted === true };
}

// Normalizer for worldafisha. Reads pending raw rows, builds Spain-filtered event
// drafts, upserts each idempotently, then marks every raw row normalized (append-only:
// never deletes raw rows — constitution I). `exec` is injectable for tests.
export async function normalizeWorldafisha(
  { exec = sql }: { exec?: typeof sql } = {},
): Promise<{ created: number; updated: number; processed: number }> {
  const rows = (await exec`
    SELECT * FROM source_items
    WHERE source_key = ${WORLDAFISHA_SOURCE_KEY}
      AND (normalized_status IS NULL OR normalized_status = 'pending'
           OR normalized_at IS NULL OR normalized_at < last_seen)
  `) as unknown as RawItem[];

  const drafts = buildWorldafishaEvents(rows);
  const ts = nowIso();
  let created = 0;
  let updated = 0;

  for (const { draft, sourceItemId } of drafts) {
    try {
      const res = await upsertPlainEvent(draft, sourceItemId, exec);
      if (res.inserted) created++;
      else updated++;
    } catch {
      // fail-soft: skip the bad draft, keep processing the batch
    }
  }

  for (const item of rows) {
    await exec`UPDATE source_items
      SET normalized_at = ${ts}, normalized_status = 'normalized'
      WHERE id = ${item.id}`;
  }

  return { created, updated, processed: rows.length };
}
