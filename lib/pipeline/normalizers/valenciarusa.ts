import { sql } from "../../db";
import { compact, nowIso } from "../util";
import { parseEventDate, upsertPlainEvent, type EventInsert } from "./worldafisha";
import type { RawItem } from "./types";

// T111 — valenciarusa.es (web source, key `web:valenciarusa`, id 7). The most
// PRECISE local RU agenda: each listing carries a date, venue and often a price. Raw
// rows arrive from the generic web parser as `link_card` (per-listing anchor) or
// `page_snapshot` (the agenda page itself). We pull date / venue / address / price
// out of the title+text and emit ONE event per listing. Already Valencia-local, so
// NO Spain pre-filter is needed (unlike worldafisha). Fail-soft: an unparseable row
// is skipped, never throws (constitution: pipeline is fail-soft + append-only).

export const VALENCIARUSA_SOURCE_KEY = "web:valenciarusa";
const SOURCE_URL = "https://www.valenciarusa.es/sobytiya";

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

// PURE: a price token from free RU/ES text. Recognises "10 €", "€10", "10 евро",
// "10 eur", "от 15€", and free admission ("бесплатно", "вход свободный", "gratis",
// "free", "entrada libre"). Returns { price, isFree } — either field may be null.
export function parsePrice(text?: string | null): { price: string | null; isFree: number | null } {
  const t = compact(text);
  if (!t) return { price: null, isFree: null };
  const lower = t.toLowerCase();
  if (/бесплатн|вход свободн|вход бесплатн|gratis|gratuit|entrada libre|free entry|free admission|\bfree\b/.test(lower)) {
    return { price: "Free", isFree: 1 };
  }
  const m = /(?:от\s*)?(\d{1,4})(?:[.,]\d{1,2})?\s*(?:€|евро|eur|euros?)\b|(?:€|eur)\s*(\d{1,4})/i.exec(t);
  if (m) {
    const amount = m[1] ?? m[2];
    if (amount) return { price: `${amount} €`, isFree: 0 };
  }
  return { price: null, isFree: null };
}

// Venue cue words (RU/ES) — when one precedes a proper-noun phrase we treat the rest
// of that segment as the venue name. Best-effort; venue stays null when unclear.
const VENUE_CUES = /(?:в\s+|место[:\s]+|venue[:\s]+|в\s+зале\s+|teatro\s+|sala\s+|centro\s+|museo\s+|palau\s+)/i;

// PURE: best-effort venue name from a line. Looks for a cue word followed by a
// capitalised phrase. Returns null when nothing confident is found.
export function parseVenue(text?: string | null): string | null {
  const t = compact(text);
  if (!t) return null;
  // direct address-ish "venue, address" or "@ Venue" patterns first
  const at = /(?:@|📍)\s*([^\n,;]{3,80})/.exec(t);
  if (at) return compact(at[1]);
  const cue = VENUE_CUES.exec(t);
  if (cue) {
    const after = t.slice(cue.index + cue[0].length);
    const m = /^([A-ZА-ЯÀ-Ü][\p{L}0-9'’.\- ]{2,60})/u.exec(after);
    if (m) return compact(m[1]);
  }
  return null;
}

// PURE: best-effort street address ("Calle/Av./Plaza … 12"). Returns null when none.
export function parseAddress(text?: string | null): string | null {
  const t = compact(text);
  if (!t) return null;
  const m = /\b((?:calle|c\/|av\.?|avenida|avda\.?|plaza|pl\.|paseo|carrer|carretera)\s+[\p{L}0-9'’.\- ]{2,60}\d{0,4})/iu.exec(t);
  return m ? compact(m[1]) : null;
}

// PURE: turn pending valenciarusa raw rows into event drafts (date/venue/address/
// price extracted where derivable). The full-page snapshot is dropped (no single
// event identity). DB-free so it unit-tests without a connection.
export function buildValenciarusaEvents(
  rows: RawItem[],
  today: Date = new Date(),
): Array<{ draft: EventInsert; sourceItemId: number }> {
  const out: Array<{ draft: EventInsert; sourceItemId: number }> = [];
  for (const item of rows) {
    const raw = parseRaw(item);
    if (raw.kind === "page_snapshot") continue;

    const title = compact(item.title);
    if (!title) continue;

    const haystack = `${title} ${item.raw_text || ""}`;
    const start = parseEventDate(haystack, today);
    const { price, isFree } = parsePrice(haystack);
    const venue = parseVenue(haystack);
    const address = parseAddress(haystack);

    out.push({
      sourceItemId: item.id,
      draft: {
        title: title.slice(0, 300),
        description: compact(item.raw_text)?.slice(0, 2000) ?? null,
        category: "culture",
        language: "ru",
        start_date: start,
        venue_name: venue,
        address,
        city: "Valencia",
        country: "Spain",
        price,
        is_free: isFree,
        url: item.url ?? SOURCE_URL,
        image_url: raw.meta?.["og:image"] || null,
        source: VALENCIARUSA_SOURCE_KEY,
        source_url: item.url ?? SOURCE_URL,
        raw_excerpt: compact(item.raw_text)?.slice(0, 1000) ?? null,
      },
    });
  }
  return out;
}

// Normalizer for valenciarusa. Reads pending raw rows, builds event drafts, upserts
// each idempotently (shared `upsertPlainEvent`), then marks every raw row normalized
// (append-only — constitution I). `exec` is injectable for tests.
export async function normalizeValenciarusa(
  { exec = sql }: { exec?: typeof sql } = {},
): Promise<{ created: number; updated: number; processed: number }> {
  const rows = (await exec`
    SELECT * FROM source_items
    WHERE source_key = ${VALENCIARUSA_SOURCE_KEY}
      AND (normalized_status IS NULL OR normalized_status = 'pending'
           OR normalized_at IS NULL OR normalized_at < last_seen)
  `) as unknown as RawItem[];

  const drafts = buildValenciarusaEvents(rows);
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
