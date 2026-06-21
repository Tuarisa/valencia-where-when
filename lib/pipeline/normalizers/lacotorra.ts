import { sql } from "../../db";
import { compact, nowIso } from "../util";
import { markRawItem } from "./types";
import {
  parseEventDate,
  upsertPlainEvent,
  type EventInsert,
} from "./worldafisha";
import { parsePrice, isJunkCard } from "./valenciarusa";
import type { RawItem } from "./types";

// T112-family — lacotorra.io/events (web source, key `web:lacotorra`, id 8). RU media
// site ("La Cotorra") whose events agenda is rendered ENTIRELY inside a single
// `page_snapshot` row — the generic web parser's `link_card` rows for this source are
// ALL nav/category/legal chrome (privacy-policy, "Религиозные события", "Предстоящие
// мероприятия", …) and carry NO event. So, unlike fever/worldafisha/valenciarusa
// (which skip the snapshot and parse per-listing link_cards), here we PARSE the
// snapshot and DROP every link_card.
//
// The snapshot's `raw_text` is the flattened agenda page. After site chrome, each
// event renders as a fixed-shape block of consecutive lines:
//
//   <Title>                              e.g. "Выставка о Фриде Кало в Валенсии"
//   [<City>]                             e.g. "Валенсия" / "Мадрид" / "Барселона"
//   <Description …>                      a short teaser, usually ending in "…"/"..."
//   <Date range>                         "9 Jun 2026, 10:00 - 5 Aug 2026, 12:00"
//   <Venue>                              e.g. "Ateneo Mercantil de Valencia"
//
// The DATE line (English month abbreviation + 4-digit year + HH:MM, optionally a
// "<from> - <to>" range) is the reliable anchor. We walk backward from it for the
// city / description / title and forward (one line) for the venue. The City line is
// OPTIONAL: ~7/56 featured blocks omit it because the city is baked into the title
// ("…в Мериде"); we detect that and fall back. lacotorra is multi-city (VLC + Madrid
// + Barcelona); we keep the per-block city (default Valencia) so downstream scoring
// can weigh locality. All dates/venues/prices are extracted by DETERMINISTIC rules
// (T140 — JS before LLM); an unparseable block is skipped, every raw row is marked
// normalized append-only, nothing throws (constitution: fail-soft + append-only).

export const LACOTORRA_SOURCE_KEY = "web:lacotorra";
const SOURCE_URL = "https://lacotorra.io/events";
// Display name — lets isJunkCard recognise bare header/chrome cards.
const LACOTORRA_NAME = "La Cotorra";

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

// A lacotorra date line: "<d> <Mon> <YYYY>, <HH>:<MM>" with an optional
// " - <d> <Mon> <YYYY>, <HH>:<MM>" range tail. English 3-letter month abbreviations
// (the site renders English months even in the RU UI). Anchored to line START so a
// stray date inside a description is not mistaken for a block boundary.
const DATE_LINE =
  /^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4}),\s*(\d{1,2}:\d{2})(?:\s*-\s*(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4}),\s*(\d{1,2}:\d{2}))?/;

// Recognised RU city names lacotorra prints on the optional City line. Used only to
// detect that a separate City line exists (and to set the event city); when absent
// the city is embedded in the title and we default to Valencia.
const CITY_LINE =
  /^(Валенсия|Мадрид|Барселона|Аликанте|Гранада|Севилья|Бильбао|Малага|Мерида|Ла-Корунья|Лас-Пальмас(?:-де-Гран-Канарии)?|Рекена-Утьель|Адемус)$/;

// Map a recognised RU city token to its English/site city name. Anything inside the
// Valencia province (Requena-Utiel, Ademús) and the default fall to "Valencia".
const CITY_MAP: Record<string, string> = {
  Мадрид: "Madrid",
  Барселона: "Barcelona",
  Аликанте: "Alicante",
  Гранада: "Granada",
  Севилья: "Seville",
  Бильбао: "Bilbao",
  Малага: "Malaga",
  Мерида: "Mérida",
  "Ла-Корунья": "A Coruña",
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

const EN_MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

// PURE: parse a lacotorra date line into ISO start/end dates plus the start time.
// `start_date` reuses the shared `parseEventDate` (it returns the FIRST date = the
// range start) for parity with the sibling normalizers; the end date + start time
// come from this line's own regex. Returns nulls when the line is not a date line.
export function parseLacotorraDate(
  line?: string | null,
): { start: string | null; end: string | null; startTime: string | null } {
  const t = compact(line);
  if (!t) return { start: null, end: null, startTime: null };
  const m = DATE_LINE.exec(t);
  if (!m) return { start: null, end: null, startTime: null };

  const startMon = EN_MONTHS[m[2].toLowerCase()] ?? 0;
  const startDay = Number(m[1]);
  let start: string | null = null;
  if (startMon && startDay >= 1 && startDay <= 31) {
    start = `${m[3]}-${pad(startMon)}-${pad(startDay)}`;
  }
  // Fall back to the shared parser if our strict regex somehow disagrees.
  if (!start) start = parseEventDate(t);

  const startTime = m[4] ?? null;

  let end: string | null = null;
  if (m[5] && m[6] && m[7]) {
    const endMon = EN_MONTHS[m[6].toLowerCase()] ?? 0;
    const endDay = Number(m[5]);
    if (endMon && endDay >= 1 && endDay <= 31) {
      end = `${m[7]}-${pad(endMon)}-${pad(endDay)}`;
    }
  }
  return { start, end, startTime };
}

// A venue line is a plausible venue name, NOT another date line and NOT a bare city
// token (those would be the next block's city). Loose by design — best-effort.
function looksLikeVenue(line?: string | null): boolean {
  const t = compact(line);
  if (!t) return false;
  if (DATE_LINE.test(t)) return false;
  if (CITY_LINE.test(t)) return false;
  if (t.length > 160) return false; // a wrapped description, not a venue
  return true;
}

// PURE: turn the lacotorra `page_snapshot` into event blocks. We split the flattened
// raw_text into non-empty lines, find each DATE line, and reconstruct the block by
// looking back (city/description/title) and forward (venue). DB-free; offline-testable.
export function buildLacotorraEvents(
  rows: RawItem[],
  today: Date = new Date(),
): Array<{ draft: EventInsert; sourceItemId: number }> {
  const out: Array<{ draft: EventInsert; sourceItemId: number }> = [];
  const seen = new Set<string>(); // de-dupe identical title+date within one snapshot

  for (const item of rows) {
    const raw = parseRaw(item);
    // ONLY the snapshot carries events for this source; every link_card is chrome.
    if (raw.kind !== "page_snapshot") continue;

    const text = item.raw_text || "";
    const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
    const img = raw.meta?.["og:image"] || null;

    for (let i = 0; i < lines.length; i++) {
      const { start, end, startTime } = parseLacotorraDate(lines[i]);
      if (!start && !DATE_LINE.test(lines[i])) continue; // not a date-anchored block
      if (!DATE_LINE.test(lines[i])) continue;

      // Look BACK for the block's city / description / title.
      // Layout (most blocks):  [..] <Title> <City> <Description> <DATE>
      // Featured blocks omit <City>: [..] <Title> <Description> <DATE>
      const prev1 = lines[i - 1]; // description (ends in …/...)
      const prev2 = lines[i - 2];
      const prev3 = lines[i - 3];

      let cityToken: string | null = null;
      let title: string | null = null;
      let description: string | null = null;

      if (prev2 && CITY_LINE.test(prev2)) {
        // <Title=prev3> <City=prev2> <Description=prev1> <DATE>
        cityToken = prev2;
        description = prev1 ?? null;
        title = prev3 ?? null;
      } else {
        // No separate city line — city is baked into the title.
        // <Title=prev2> <Description=prev1> <DATE>
        description = prev1 ?? null;
        title = prev2 ?? null;
      }

      title = compact(title);
      if (!title || title.length < 3) continue;
      // Drop any block whose "title" is actually chrome (a nav/legal label or a bare
      // city token bleeding through) — deterministic, never matches a real event.
      if (isJunkCard(title, description, LACOTORRA_NAME)) continue;
      if (CITY_LINE.test(title)) continue;

      // Venue: the line right after the date line, when it looks like a venue.
      const venue = looksLikeVenue(lines[i + 1]) ? compact(lines[i + 1]) : null;

      const city = cityToken
        ? CITY_MAP[cityToken] ?? "Valencia"
        : "Valencia";

      // Price/free hint from title+description (most are free-admission notes).
      const haystack = `${title} ${description ?? ""}`;
      const { price, isFree } = parsePrice(haystack);

      const dedupeKey = `${title.toLowerCase()}|${start ?? ""}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      out.push({
        sourceItemId: item.id,
        draft: {
          title: title.slice(0, 300),
          description: compact(description)?.slice(0, 2000) ?? null,
          category: "culture",
          language: "ru",
          start_date: start ?? parseEventDate(lines[i], today),
          end_date: end,
          start_time: startTime,
          venue_name: venue,
          city,
          country: "Spain",
          price,
          is_free: isFree,
          url: item.url ?? SOURCE_URL,
          image_url: img,
          source: LACOTORRA_SOURCE_KEY,
          source_url: item.url ?? SOURCE_URL,
          raw_excerpt: compact(description)?.slice(0, 1000) ?? null,
        },
      });
    }
  }
  return out;
}

// Normalizer for lacotorra. Reads pending raw rows, parses the snapshot into event
// drafts, upserts each idempotently (shared `upsertPlainEvent`), then marks EVERY
// processed raw row normalized append-only — including the dropped link_card chrome
// rows (constitution I: raw layer is append-only; never deletes). `exec` injectable.
export async function normalizeLacotorra(
  { exec = sql }: { exec?: typeof sql } = {},
): Promise<{ created: number; updated: number; processed: number }> {
  const rows = (await exec`
    SELECT * FROM source_items
    WHERE source_key = ${LACOTORRA_SOURCE_KEY}
      AND (normalized_status IS NULL OR normalized_status = 'pending'
           OR normalized_at IS NULL OR normalized_at < last_seen)
  `) as unknown as RawItem[];

  const drafts = buildLacotorraEvents(rows);
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

  // Mark every processed raw row normalized (events came from the snapshot; the
  // link_card chrome rows are dropped but still recorded as processed).
  for (const item of rows) {
    await markRawItem(item.id, "normalized", null, exec);
  }

  return { created, updated, processed: rows.length };
}
