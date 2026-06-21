import { sql } from "../../db";
import { compact } from "../util";
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
// STRATEGY (T140 — deterministic JS, NO LLM): the page_snapshot is the AUTHORITATIVE set of
// real, dated Valencia events. The generic web parser only emitted a `/e/` link_card for a
// SUBSET of the cards (9 anchors → 7 distinct ids on the live rows), but the snapshot lists
// every card with its title + date-expr + venue. Keying emission off the link_cards
// therefore DROPPED ~half the real events (e.g. "Música coral en directo", "PENYAIR en
// VALENCIA", "Inside Daidalonic 2026", "Concierto Coral Internacional" — fully dated, but
// no anchor). FIX: drive emission from the SNAPSHOT cards; attach the canonical `/e/` URL
// when a same-title link_card exists, else fall back to the listing URL + the snapshot row.
//
// A snapshot card renders as one of two shapes:
//   • PHYSICAL Valencia card → "<title> <date-expr>\n<venue>\nCheck ticket price on event"
//     (a venue line precedes the marker). These are the real events we emit.
//   • ONLINE / out-of-town card → "<title> <date-expr-with-foreign-tz>\nCheck ticket price
//     on event" — NO venue line, and the time carries a non-local tz ("GMT+1","EDT","PDT",
//     "CDT","GMT+12"). These are global webinars / US job fairs, NOT Valencia plans → DROP.
//
// We de-dupe cards by normalized title (the snapshot repeats each card 2–3×). Undated real
// events still emit (start_date null) — a wrong date is worse than none (mirrors fever/
// worldafisha). Fail-soft + append-only: an unparseable row is skipped, every processed raw
// row is marked normalized, nothing throws (constitution).

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
  title: string;
  dateExpr: string;
  venue: string | null;
  online: boolean;
}

// A leading date token marks where the date-expr begins inside a "title <date>" line.
// ES relative/weekday OR English "Mon," etc. The `(.*?)` before it is the title.
const DATE_START = new RegExp(
  "^(.*?)\\s+(" +
    "hoy\\b|ma[nñ]ana\\b|" +
    "lunes\\b|martes\\b|mi[eé]rcoles\\b|jueves\\b|viernes\\b|s[aá]bado\\b|domingo\\b|" +
    "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\\s" +
    ")(.*)$",
  "i",
);

// PURE: a non-local timezone suffix on the time marks a card as ONLINE / out-of-town
// (global webinar, US job fair). The Valencia listing renders local cards with NO tz at
// all; only the foreign cards carry one. Matches "GMT+1", "GMT+12", "EDT", "PDT", "CDT", …
const FOREIGN_TZ = /\b(GMT[+-]\d{1,2}|UTC[+-]\d{1,2}|[ECMP][DS]T)\b/;

// PURE: index the page_snapshot by normalized title → { title, dateExpr, venue, online }.
// Each card renders as "<title> <date-expr>\n<venue>\nCheck ticket price on event" for a
// PHYSICAL Valencia card, or "<title> <date-expr+tz>\nCheck ticket price on event" (no
// venue line) for an ONLINE / out-of-town card. We anchor on the "Check ticket price on
// event" marker (present on EVERY card). The title+date line is i-2 when a venue line
// sits at i-1, or i-1 when the marker follows the title directly (online). We split the
// date-expr off the END of the title line by its leading date token; the prefix is the
// title. Online cards (foreign tz, no venue) are indexed with `online:true` so the caller
// can drop them. Keyed by normalized title; first occurrence wins (the page repeats cards).
export function buildSnapshotIndex(snapshotText?: string | null): Map<string, SnapshotEntry> {
  const index = new Map<string, SnapshotEntry>();
  if (!snapshotText) return index;
  const lines = snapshotText.split("\n").map((l) => l.replace(/\s+/g, " ").trim());

  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== "Check ticket price on event") continue;

    // The title+date line is i-2 (a venue line at i-1) OR i-1 (marker follows title
    // directly, i.e. an online card with no venue). Prefer i-2 when it parses as a
    // title+date line; otherwise treat i-1 as the title line (online card).
    const prev1 = lines[i - 1] ?? "";
    const prev2 = lines[i - 2] ?? "";
    let m = prev2 ? DATE_START.exec(prev2) : null;
    let venue: string | null = compact(prev1);
    if (!m) {
      // No title+date at i-2 → online card whose title+date IS at i-1, no venue line.
      m = prev1 ? DATE_START.exec(prev1) : null;
      venue = null;
    }
    if (!m) continue;

    const title = compact(m[1]) ?? "";
    if (!title) continue;
    // date-expr = the matched token + the remainder; trim a trailing "+ N more".
    const rawDateExpr = compact(`${m[2]}${m[3]}`) ?? "";
    const dateExpr = rawDateExpr.replace(/\s*\+\s*\d+\s+more\s*$/i, "");
    // ONLINE = no venue line AND a foreign-tz time. Both must hold: a Valencia card
    // always has a venue line, and never carries a tz suffix.
    const online = venue === null && FOREIGN_TZ.test(rawDateExpr);

    const key = titleKey(title);
    if (!index.has(key)) index.set(key, { title, dateExpr, venue, online });
  }
  return index;
}

// PURE: index the `/e/` link_cards by normalized title → canonical URL + the row id that
// carried it. The snapshot has no anchors, so this is how a snapshot card recovers its
// deep `/e/` link. De-duped on the path-without-query (the live rows list the same event
// id twice under different `?aff=` params); first occurrence wins, so a stable row id is
// attributed to each event. `snapshotId` is the fallback source_item id for cards that
// have no link_card at all.
export interface LinkCardRef {
  url: string;
  sourceItemId: number;
}

export function buildLinkCardIndex(rows: RawItem[]): Map<string, LinkCardRef> {
  const byTitle = new Map<string, LinkCardRef>();
  const seenUrl = new Set<string>();
  for (const item of rows) {
    if (!isEventbriteEventUrl(item.url)) continue; // chrome / poi / nav → not an /e/ event
    const title = compact(item.title);
    if (!title) continue;
    const canonical = eventbriteCanonicalUrl(item.url as string);
    if (seenUrl.has(canonical)) continue;
    seenUrl.add(canonical);
    const key = titleKey(title);
    if (!byTitle.has(key)) byTitle.set(key, { url: canonical, sourceItemId: item.id });
  }
  return byTitle;
}

// PURE: turn pending Eventbrite raw rows into event drafts. SNAPSHOT-DRIVEN — the snapshot
// is the authoritative set of real Valencia cards (the link_cards only anchor a subset).
// We emit ONE event per distinct snapshot card, drop online/out-of-town cards, and attach
// the canonical `/e/` deep link when a same-title link_card exists (else the listing URL).
// DB-free (offline unit-testable). `today` is injected for deterministic relative-date
// resolution.
export function buildEventbriteEvents(
  rows: RawItem[],
  today: Date = new Date(),
): Array<{ draft: EventInsert; sourceItemId: number }> {
  // Find the snapshot row (the authoritative card source) and build the lookup once.
  let snapshot = "";
  let snapshotId = 0;
  let snapshotImage: string | null = null;
  for (const item of rows) {
    const raw = parseRaw(item);
    if (raw.kind === "page_snapshot") {
      snapshot = item.raw_text || "";
      snapshotId = item.id;
      snapshotImage = raw.meta?.["og:image"] || null;
      break;
    }
  }
  const cards = buildSnapshotIndex(snapshot);
  const links = buildLinkCardIndex(rows);

  const out: Array<{ draft: EventInsert; sourceItemId: number }> = [];
  const emitted = new Set<string>();

  for (const [key, card] of cards) {
    if (card.online) continue; // global webinar / out-of-town job fair → drop
    const title = card.title;
    // Deterministic chrome guard (shared) — catches a stray nav/badge line that slipped
    // through the card shape (e.g. "Explore more events").
    if (isJunkCard(title, title, EVENTBRITE_NAME)) continue;

    const start = parseEventbriteDate(card.dateExpr, today);
    const start_time = parseEventbriteTime(card.dateExpr);

    // Attach the canonical /e/ deep link when a same-title link_card exists; otherwise
    // attribute the event to the snapshot row and link to the listing page.
    const link = links.get(key);
    const url = link?.url ?? SOURCE_URL;
    const sourceItemId = link?.sourceItemId ?? snapshotId;
    emitted.add(key);

    out.push({
      sourceItemId,
      draft: {
        title: title.slice(0, 300),
        category: "culture",
        language: "es",
        audience: "all",
        start_date: start,
        start_time,
        venue_name: card.venue,
        city: "Valencia",
        country: "Spain",
        url,
        image_url: snapshotImage,
        source: EVENTBRITE_SOURCE_KEY,
        source_url: url,
        raw_excerpt: title.slice(0, 1000),
      },
    });
  }

  // Second pass: an `/e/` link_card whose title has NO snapshot card still emits, undated
  // (the snapshot can be truncated or the anchor scraped without a matching listing card).
  // A wrong date is worse than none (mirrors fever/worldafisha); the canonical /e/ URL +
  // correct title are still real.
  for (const [key, ref] of links) {
    if (emitted.has(key)) continue;
    const title = compact(rowTitleFor(rows, ref.sourceItemId)) ?? "";
    if (!title) continue;
    if (isJunkCard(title, title, EVENTBRITE_NAME)) continue;
    emitted.add(key);
    out.push({
      sourceItemId: ref.sourceItemId,
      draft: {
        title: title.slice(0, 300),
        category: "culture",
        language: "es",
        audience: "all",
        start_date: null,
        start_time: null,
        venue_name: null,
        city: "Valencia",
        country: "Spain",
        url: ref.url,
        image_url: snapshotImage,
        source: EVENTBRITE_SOURCE_KEY,
        source_url: ref.url,
        raw_excerpt: title.slice(0, 1000),
      },
    });
  }
  return out;
}

// PURE: recover the original title for a link_card source_item id.
function rowTitleFor(rows: RawItem[], id: number): string | null {
  for (const r of rows) if (r.id === id) return r.title ?? null;
  return null;
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
