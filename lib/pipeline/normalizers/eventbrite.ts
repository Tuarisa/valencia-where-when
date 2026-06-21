import { sql } from "../../db";
import { compact, nowIso } from "../util";
import { parseEventDate, upsertPlainEvent, type EventInsert } from "./worldafisha";
import { isJunkCard } from "./valenciarusa";
import { markRawItem } from "./types";
import type { RawItem } from "./types";

// web:eventbrite (id 26, type `ticketing`, lang es). Listing page:
//   https://www.eventbrite.es/d/spain--valencia/events/
//
// REAL shape (verified on the live local DB, 61 rows): the generic web parser emits
//   • ONE `page_snapshot` row (id 247) — the flattened listing page. This is the ONLY
//     place the DATE and VENUE live. Eventbrite renders each card as:
//        "<title> <date-expr>\n<venue>\nCheck ticket price on event"
//     where <date-expr> is a Spanish RELATIVE phrase ("hoy a las 22:30",
//     "mañana a las 20:30", "viernes a las 09:00", "lunes a las 08:00") OR an English
//     ABSOLUTE phrase ("Thu, Jul 2, 7:00 PM", "Sat, Jun 27, 8:30 PM"). A trailing
//     "+ N more" (multi-session) may follow the time.
//   • MANY `link_card` rows — per-anchor. raw_text == title == just the event name; the
//     URL is the deep link. The REAL Valencia events are the `/e/<slug>-<id>` cards
//     (e.g. .../e/fuckup-nights-valencia-vol-xliv-tickets-1992117357643). The trailing
//     number is the Eventbrite event ID, NOT a date — there is NO date in the slug.
//     Every OTHER link_card is chrome: `/poi/` venue pages, `/d/`,`/b/` city-browse,
//     `/l/`,`/organizer/`,`/help/`,`/support/`,`/ttd/`,`/how-it-works`,`/spectrum/`,
//     `/directory/`, cookie/nav anchors → all dropped.
//
// STRATEGY (T140 — deterministic JS, NO LLM): the `/e/` link_cards are the authoritative
// list of real events (correct title + canonical URL). The snapshot is a side-table we
// index by normalized title to look up each event's date + venue. We emit ONE event per
// distinct `/e/` URL (the live rows duplicate Pub Crawl / Jazz at Loom under different
// `?aff=` query params — same event id, so we de-dupe on the path-without-query).
// Undated real events still emit (start_date null) — a wrong date is worse than none
// (mirrors fever/worldafisha). Fail-soft + append-only: an unparseable row is skipped,
// every processed raw row is marked normalized, nothing throws (constitution).

export const EVENTBRITE_SOURCE_KEY = "web:eventbrite";
const SOURCE_URL = "https://www.eventbrite.es/d/spain--valencia/events/";
const EVENTBRITE_NAME = "Eventbrite";

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

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// Spanish weekday names (lowercased, accent-insensitive after stripping) → 0=Sunday.
const ES_WEEKDAYS: Record<string, number> = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
};

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function toIso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// PURE: pull a leading "HH:MM" 24h time out of an Eventbrite date-expr ("a las 22:30"
// or a 12h "7:00 PM"). Returns "HH:MM" 24h or null.
export function parseEventbriteTime(expr?: string | null): string | null {
  const t = compact(expr);
  if (!t) return null;
  // 12-hour "7:00 PM" / "8:30 AM" (English absolute cards)
  const m12 = /\b(\d{1,2}):(\d{2})\s*(AM|PM)\b/i.exec(t);
  if (m12) {
    let h = Number(m12[1]) % 12;
    if (/pm/i.test(m12[3])) h += 12;
    return `${pad(h)}:${m12[2]}`;
  }
  // 24-hour "a las 22:30" or a bare "22:30"
  const m24 = /\b(\d{1,2}):(\d{2})\b/.exec(t);
  if (m24) {
    const h = Number(m24[1]);
    if (h >= 0 && h <= 23) return `${pad(h)}:${m24[2]}`;
  }
  return null;
}

// PURE (T140, deterministic): resolve an Eventbrite card date-expr to an ISO date,
// relative to the injected `today` (defaults to real now). Handles, in order:
//   • Spanish relative "hoy"  → today
//   • Spanish relative "mañana" → today + 1
//   • Spanish weekday "viernes"/"lunes"/… → NEXT occurrence of that weekday on/after
//     today (today counts if it IS that weekday)
//   • English absolute "Thu, Jul 2" / "Sat, Jun 27" → via parseEventDate (month-first)
// Returns null when nothing usable (e.g. an online card carrying only a foreign tz).
// NOTE: we do NOT guess a date for a bare weekday in another language — only ES/EN
// here, matching what the live Valencia listing actually emits.
export function parseEventbriteDate(
  expr?: string | null,
  today: Date = new Date(),
): string | null {
  const raw = compact(expr);
  if (!raw) return null;
  const lower = stripAccents(raw.toLowerCase());

  // hoy / mañana (accent already stripped → "manana")
  if (/\bhoy\b/.test(lower)) return toIso(today);
  if (/\bmanana\b/.test(lower)) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    return toIso(d);
  }

  // Spanish weekday → next occurrence on/after today.
  for (const [name, dow] of Object.entries(ES_WEEKDAYS)) {
    const re = new RegExp(`\\b${name}\\b`);
    if (re.test(lower)) {
      const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      let delta = (dow - base.getDay() + 7) % 7;
      // a weekday name means the UPCOMING one; "today is that weekday" → today (delta 0)
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + delta);
      return toIso(d);
    }
  }

  // English absolute ("Thu, Jul 2, 7:00 PM") — reuse the shared month-first parser,
  // which infers the year to the next occurrence on/after `today`.
  return parseEventDate(raw, today);
}

// PURE: an Eventbrite link is a real single event ONLY when its path is `/e/<slug>`.
// Everything else (`/poi/`, `/d/`, `/b/`, `/l/`, `/organizer/`, `/help/`, `/support/`,
// `/ttd/`, `/how-it-works`, `/spectrum/`, `/directory/`, cookie/nav) is chrome.
export function isEventbriteEventUrl(url?: string | null): boolean {
  return !!url && /eventbrite\.[a-z.]+\/e\//i.test(url);
}

// PURE: canonical key for an `/e/` event = the path WITHOUT the `?aff=` query (the live
// rows list the same event id twice under different affiliate params). Falls back to the
// full url when it can't be parsed.
export function eventbriteCanonicalUrl(url: string): string {
  return url.split(/[?#]/)[0];
}

// PURE: normalize a title for snapshot lookup. The link_card title and the snapshot's
// rendered title are byte-identical for the real events, but we still compact + lowercase
// + strip accents so a stray accent/spacing difference can't break the join.
function titleKey(title: string): string {
  return stripAccents(compact(title)?.toLowerCase() ?? "");
}

export interface SnapshotEntry {
  dateExpr: string;
  venue: string | null;
}

// PURE: index the page_snapshot text by title → { dateExpr, venue }. Each card renders
// as "<title> <date-expr>\n<venue>\nCheck ticket price on event". We anchor on the
// "Check ticket price on event" marker (present on EVERY real card), walk back two lines
// to recover venue and the title+date line, then split the date-expr off the END of that
// line by the leading date token ("hoy"/"mañana"/weekday/"Mon,"…). The remaining prefix
// is the title. Keyed by normalized title; first occurrence wins (the page repeats cards).
export function buildSnapshotIndex(snapshotText?: string | null): Map<string, SnapshotEntry> {
  const index = new Map<string, SnapshotEntry>();
  if (!snapshotText) return index;
  const lines = snapshotText.split("\n").map((l) => l.replace(/\s+/g, " ").trim());

  // A leading date token marks where the date-expr begins inside the "title <date>" line.
  // ES relative/weekday OR English "Mon," etc. The `(.*?)` before it is the title.
  const DATE_START = new RegExp(
    "^(.*?)\\s+(" +
      "hoy\\b|ma[nñ]ana\\b|" +
      "lunes\\b|martes\\b|mi[eé]rcoles\\b|jueves\\b|viernes\\b|s[aá]bado\\b|domingo\\b|" +
      "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\\s" +
      ")(.*)$",
    "i",
  );

  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== "Check ticket price on event") continue;
    const venueLine = lines[i - 1] ?? "";
    const titleDateLine = lines[i - 2] ?? "";
    if (!titleDateLine) continue;
    const m = DATE_START.exec(titleDateLine);
    if (!m) continue;
    const title = compact(m[1]) ?? "";
    if (!title) continue;
    // date-expr = the matched token + the remainder; trim a trailing "+ N more".
    const dateExpr = compact(`${m[2]}${m[3]}`)?.replace(/\s*\+\s*\d+\s+more\s*$/i, "") ?? "";
    const venue = compact(venueLine);
    const key = titleKey(title);
    if (!index.has(key)) index.set(key, { dateExpr, venue });
  }
  return index;
}

// PURE: turn pending Eventbrite raw rows into event drafts. Keeps ONLY distinct `/e/`
// link_cards; looks up date + venue in the snapshot index by title. DB-free (offline
// unit-testable). `today` is injected for deterministic relative-date resolution.
export function buildEventbriteEvents(
  rows: RawItem[],
  today: Date = new Date(),
): Array<{ draft: EventInsert; sourceItemId: number }> {
  // Find the snapshot row (the only date/venue source) and build the lookup once.
  let snapshot = "";
  for (const item of rows) {
    if (parseRaw(item).kind === "page_snapshot") {
      snapshot = item.raw_text || "";
      break;
    }
  }
  const index = buildSnapshotIndex(snapshot);

  const out: Array<{ draft: EventInsert; sourceItemId: number }> = [];
  const seen = new Set<string>();

  for (const item of rows) {
    const raw = parseRaw(item);
    if (raw.kind === "page_snapshot") continue; // the index, not an event
    if (!isEventbriteEventUrl(item.url)) continue; // chrome / poi / nav → drop

    const title = compact(item.title);
    if (!title) continue;
    // Deterministic chrome guard (shared) — also catches a stray bare-name card.
    if (isJunkCard(title, item.raw_text, EVENTBRITE_NAME)) continue;

    // De-dupe the same event listed under different `?aff=` params (same `/e/` path).
    const canonical = eventbriteCanonicalUrl(item.url as string);
    if (seen.has(canonical)) continue;
    seen.add(canonical);

    const hit = index.get(titleKey(title));
    const start = hit ? parseEventbriteDate(hit.dateExpr, today) : null;
    const start_time = hit ? parseEventbriteTime(hit.dateExpr) : null;
    const venue = hit?.venue ?? null;

    out.push({
      sourceItemId: item.id,
      draft: {
        title: title.slice(0, 300),
        description: compact(item.raw_text)?.slice(0, 2000) ?? null,
        category: "culture",
        language: "es",
        audience: "all",
        start_date: start,
        start_time,
        venue_name: venue,
        city: "Valencia",
        country: "Spain",
        url: item.url ?? SOURCE_URL,
        image_url: raw.meta?.["og:image"] || null,
        source: EVENTBRITE_SOURCE_KEY,
        source_url: item.url ?? SOURCE_URL,
        raw_excerpt: compact(item.raw_text)?.slice(0, 1000) ?? null,
      },
    });
  }
  return out;
}

// Normalizer for Eventbrite. Reads pending raw rows, builds event drafts, upserts each
// idempotently (shared `upsertPlainEvent`), then marks EVERY processed raw row normalized
// — append-only (never deletes a raw row, constitution I). `exec` is injectable for tests.
export async function normalizeEventbrite(
  { exec = sql }: { exec?: typeof sql } = {},
): Promise<{ created: number; updated: number; processed: number }> {
  const rows = (await exec`
    SELECT * FROM source_items
    WHERE source_key = ${EVENTBRITE_SOURCE_KEY}
      AND (normalized_status IS NULL OR normalized_status = 'pending'
           OR normalized_at IS NULL OR normalized_at < last_seen)
  `) as unknown as RawItem[];

  const drafts = buildEventbriteEvents(rows);
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

  // Mark every processed raw row normalized (incl. dropped chrome / snapshot) — the
  // append-only bookkeeping that prevents re-processing on the next run.
  for (const item of rows) {
    await markRawItem(item.id, "normalized", null, exec);
  }

  return { created, updated, processed: rows.length };
}
