import { sql } from "../../db";
import { compact, nowIso } from "../util";
import { upsertPlainEvent, type EventInsert } from "./worldafisha";
import { isJunkCard } from "./valenciarusa";
import { markRawItem } from "./types";
import type { RawItem } from "./types";

// T112-family — songkick.com Valencia metro feed (web/ticketing source, key
// `web:songkick`, id 16). The generic web parser stores each anchor on the metro
// page as a `link_card` (`item_type='mixed'`) row plus one `page_snapshot`
// (`item_type='snapshot'`). The REAL structure, learned from the live rows, is that
// a single concert/festival is split across TWO rows that SHARE the same `url`:
//
//   • a TITLE row whose `title` (== `raw_text`) is the flattened
//       "<Artist> <Venue>"            e.g. "Razorlight Sala Moon"
//     (festival title rows carry the lineup:
//       "<Festival> <YYYY> <a, b, and c>")
//   • a DATE row whose `title` leads with the gig date and then the venue/city:
//       "<Weekday> <DD> <Mon> <YYYY> <Venue> <City>, Spain"
//       e.g. "Tue 17 Nov 2026 Sala Moon Valencia, Spain"
//
// There is NO ISO datetime and NO date in the URL slug — the ONLY exact date is in
// the partner DATE row. So we GROUP rows by url, take the title from the title row
// and the date from the date row. Festival slugs end in a YEAR ("…-2026"), but a
// bare year is NOT a usable start_date (no month/day), so a festival with no date
// row emits start_date=null — a wrong pin is worse than none (mirrors worldafisha /
// fever). Non-event anchors (the snapshot, /venues/, /artists/, /leaderboards/,
// /info/ footer links, and off-host tourbox/accounts/campaigns chrome) are dropped.
// Deterministic (T140 — JS before LLM); fail-soft + append-only (constitution I).

export const SONGKICK_SOURCE_KEY = "web:songkick";
const SOURCE_URL = "https://www.songkick.com/metro-areas/28802-spain-valencia";

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

// English month abbreviations as Songkick renders them in the date row ("17 Nov").
const EN_MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

// A Songkick date prefix: "<Weekday> <DD> <Mon> <YYYY>", e.g. "Tue 17 Nov 2026".
// The weekday is fixed 3-letter English; the year is always explicit (no inference).
const DATE_PREFIX =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2})\s+([A-Za-z]{3,4})\s+(\d{4})\b/;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// PURE: a row whose title leads with a Songkick "<Weekday> <DD> <Mon> <YYYY>" prefix
// is the DATE partner of an event url. Used both to detect such rows and to extract
// their ISO date / trailing venue.
export function isDateRow(title?: string | null): boolean {
  return DATE_PREFIX.test(compact(title) ?? "");
}

// PURE: parse "<Weekday> <DD> <Mon> <YYYY> <Venue> <City>, Spain" → { start, venue }.
// The year is explicit so no inference is needed. The venue is the text between the
// date prefix and the trailing ", Spain" (with the city word trimmed off the end);
// it stays null when not confidently isolable. Returns nulls when no date prefix.
export function parseSongkickDateRow(
  title?: string | null,
): { start: string | null; venue: string | null } {
  const t = compact(title);
  if (!t) return { start: null, venue: null };
  const m = DATE_PREFIX.exec(t);
  if (!m) return { start: null, venue: null };
  const day = Number(m[1]);
  const month = EN_MONTHS[m[2].toLowerCase()] ?? 0;
  const year = Number(m[3]);
  if (!month || day < 1 || day > 31) return { start: null, venue: null };
  const start = `${year}-${pad(month)}-${pad(day)}`;

  // Tail after the date prefix: "<Venue> <City>, Spain". Drop a trailing
  // ", Spain"/", España", then trim the trailing city token (Valencia / a beach
  // town). What remains is the best-effort venue.
  let tail = t.slice(m[0].length).trim();
  tail = tail.replace(/,\s*(?:Spain|Espa(?:ñ|n)a)\s*$/i, "").trim();
  // Remove a single trailing city/locality word ("Valencia", "Cullera Beach"…). We
  // only strip a recognised city tail so a multi-word venue is preserved.
  tail = tail.replace(/\s+(?:Valencia|Val(?:è|e)ncia|Cullera(?:\s+Beach)?|Benic(?:à|a)ssim|Benicasim)\s*$/i, "").trim();
  const venue = compact(tail) || null;
  return { start, venue };
}

// PURE: is this url a real Songkick event listing (a concert or a festival)? Only
// these two path classes are single events; /venues/, /artists/, /leaderboards/,
// /info/ and the off-host tourbox/accounts/campaigns links are chrome → dropped.
export function isSongkickEventUrl(url?: string | null): boolean {
  if (!url) return false;
  return /^https?:\/\/(?:www\.)?songkick\.com\/(?:concerts|festivals)\//i.test(url);
}

// PURE: from a flattened concert title-row ("<Artist> <Venue>"), strip a known
// trailing venue so the title is the act. Festival title rows ("<Festival> <YYYY>
// …lineup") are returned unchanged (the whole string is the event name). `venue` is
// the venue parsed from the date row, used as the suffix to strip when present.
export function songkickTitle(rawTitle: string, venue: string | null): string {
  const t = compact(rawTitle) ?? "";
  if (venue) {
    // strip a trailing ", Spain"-free venue suffix if the title ends with it
    const suffix = " " + venue;
    if (t.toLowerCase().endsWith(suffix.toLowerCase())) {
      const head = t.slice(0, t.length - suffix.length).trim();
      if (head) return head;
    }
  }
  return t;
}

// PURE: turn pending songkick raw rows into event drafts. Groups the title row and
// the date row that share a url, keeps only /concerts/ and /festivals/ listings,
// drops chrome via isSongkickEventUrl + isJunkCard. DB-free so it unit-tests offline.
export function buildSongkickEvents(
  rows: RawItem[],
  _today: Date = new Date(),
): Array<{ draft: EventInsert; sourceItemId: number }> {
  // Group event rows by url. Each group collects its title row(s) and date row(s).
  interface Group {
    url: string;
    titleItem: RawItem | null;
    dateItem: RawItem | null;
  }
  const groups = new Map<string, Group>();

  for (const item of rows) {
    const raw = parseRaw(item);
    if (raw.kind === "page_snapshot") continue; // the index page, not an event
    if (!isSongkickEventUrl(item.url)) continue; // venues/artists/leaderboards/chrome
    const url = item.url as string;
    const title = compact(item.title);
    if (!title) continue;

    let g = groups.get(url);
    if (!g) {
      g = { url, titleItem: null, dateItem: null };
      groups.set(url, g);
    }
    if (isDateRow(title)) {
      // prefer the first date row seen for a url
      if (!g.dateItem) g.dateItem = item;
    } else {
      // prefer the LONGEST non-date title (festival lineup row beats a bare
      // "<Artist> <Venue>" row), so the most descriptive title wins.
      if (!g.titleItem || (title.length > (compact(g.titleItem.title)?.length ?? 0))) {
        g.titleItem = item;
      }
    }
  }

  const out: Array<{ draft: EventInsert; sourceItemId: number }> = [];
  for (const g of groups.values()) {
    // Anchor the event on the title row when present, else the date row (a url that
    // only ever appeared as a date row is still a real listing).
    const anchor = g.titleItem ?? g.dateItem;
    if (!anchor) continue;

    const rawTitle = compact(anchor.title) ?? "";
    // Drop pure chrome/nav cards (defensive — most are already excluded by url).
    if (isJunkCard(rawTitle, anchor.raw_text)) continue;

    const { start, venue } = g.dateItem
      ? parseSongkickDateRow(g.dateItem.title)
      : { start: null as string | null, venue: null as string | null };

    // If the anchor IS a date row (no title row existed), derive the title from the
    // post-date tail instead of leaving the weekday prefix in the title.
    const baseTitle = isDateRow(rawTitle)
      ? (venue ?? parseSongkickDateRow(rawTitle).venue ?? rawTitle)
      : songkickTitle(rawTitle, venue);
    const title = compact(baseTitle);
    if (!title) continue;

    const meta = parseRaw(anchor).meta;

    out.push({
      sourceItemId: anchor.id,
      draft: {
        title: title.slice(0, 300),
        description: rawTitle.slice(0, 2000),
        category: "concert",
        language: "en",
        audience: "all",
        start_date: start,
        venue_name: venue,
        city: "Valencia",
        country: "Spain",
        url: g.url,
        image_url: meta?.["og:image"] || null,
        source: SONGKICK_SOURCE_KEY,
        source_url: g.url,
        raw_excerpt: rawTitle.slice(0, 1000),
      },
    });
  }
  return out;
}

// Normalizer for Songkick. Reads pending raw rows, builds grouped event drafts,
// upserts each idempotently (shared upsertPlainEvent), then marks EVERY processed
// raw row normalized append-only — including the snapshot, chrome, and the date
// rows that were folded into their title row (never deletes raw rows —
// constitution I). `exec` is injectable for tests.
export async function normalizeSongkick(
  { exec = sql }: { exec?: typeof sql } = {},
): Promise<{ created: number; updated: number; processed: number }> {
  const rows = (await exec`
    SELECT * FROM source_items
    WHERE source_key = ${SONGKICK_SOURCE_KEY}
      AND (normalized_status IS NULL OR normalized_status = 'pending'
           OR normalized_at IS NULL OR normalized_at < last_seen)
  `) as unknown as RawItem[];

  const drafts = buildSongkickEvents(rows);
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

  // Append-only bookkeeping: mark every raw row we read as normalized (incl. dropped
  // chrome and the date rows folded into their title row).
  for (const item of rows) {
    await markRawItem(item.id, "normalized", null, exec);
  }

  return { created, updated, processed: rows.length };
}
