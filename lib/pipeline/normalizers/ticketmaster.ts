import { sql } from "../../db";
import { compact } from "../util";
import {
  parseEventDate,
  upsertPlainEvent,
  type EventInsert,
} from "./worldafisha";
import { parsePrice, isJunkCard } from "./valenciarusa";
import { markRawItem } from "./types";
import type { RawItem } from "./types";

// T1xx — ticketmaster.es Valencia (ticketing source, key `web:ticketmaster`, id 14).
// The generic web parser stores each Ticketmaster listing as a `link_card` row whose
// `title` (== `raw_text`) is the FLATTENED card text and whose `url` is the deep link.
// There is NO ISO datetime; the date lives in the card TEXT (NOT the URL slug — the
// slug is the artist/event name only). Per live rows the real shapes are, for the
// `/event/<slug>/<id>` listings we keep:
//
//   (A) full-Spanish form (left column of the listing):
//       "domingo, 6 de septiembre de 2026, 20:30 dom 6 sept 20:30 RAWAYANA - ¿Dónde
//        Es El After? World Tour Roig Arena"
//        └ long weekday + "<D> de <month> de <YYYY>" + time, then a DUPLICATED short
//          "<wd> <D> <mon> [<YYYY>] <HH:MM>" cell, then "<TITLE> <VENUE>".
//
//   (B) "Entradas" form (right column / per-ticket-type listing):
//       "Entradas Carlos Rivera, Valencia Plaza de Toros de Valencia 27/6/26, 21:00"
//        └ "Entradas <TITLE>, Valencia <VENUE> <D/M/YY>, <HH:MM>".
//
// Both forms parse via `parseEventDate` (it reads "6 de septiembre de 2026" AND
// "27/6/26"). We additionally pull the start time, split a KNOWN Valencia venue off
// the title, and read a price when present (most TM cards carry none → null). Rows
// that are NOT single dated events — `/artist/`, `/venue/`, `/discover/`, `/help/`,
// `/feature/` nav, blog/business/help external links, and the page snapshot — are
// dropped (we keep ONLY `/event/` listings, mirroring worldafisha's `isEventUrl`).
// Deterministic (T140 — JS before LLM), fail-soft + append-only (constitution).

export const TICKETMASTER_SOURCE_KEY = "web:ticketmaster";
const SOURCE_URL = "https://www.ticketmaster.es/discover/valencia";

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

// PURE: a row is a real single event only when its URL is an `/event/<slug>/<id>`
// listing. `/artist/<name>` rows are performer profile pages (often undated, and they
// duplicate the `/event/` rows); `/venue/<name>` are venue pages; `/discover/`,
// `/help/`, `/feature/` and the external blog/business links are nav/chrome. All are
// dropped — only `/event/` carries one date + venue + title.
export function isTicketmasterEventUrl(url?: string | null): boolean {
  return !!url && /\/event\//.test(url);
}

// Known Valencia venues Ticketmaster appends to a card. Used to split the venue off
// the TAIL of the full-Spanish form's "<title> <venue>" (no delimiter separates them).
// Longest-first so a more specific venue wins over a shorter prefix of it.
const KNOWN_VENUES = [
  "Palacio de Congresos de Valencia",
  "Estadi Ciutat de València",
  "Plaza de Toros de Valencia",
  "Auditorio Roig Arena",
  "Sala Jerusalem",
  "Sala Moon",
  "Roig Arena",
].sort((a, b) => b.length - a.length);

// PURE: pull the start time ("21:00", "0:00", "20:30") out of a card. The "Entradas"
// form ends with ", <HH:MM>"; the full-Spanish form repeats the time. Returns the
// FIRST HH:MM (the canonical start) normalized to zero-padded "HH:MM", or null.
export function parseTicketmasterTime(text?: string | null): string | null {
  const t = compact(text);
  if (!t) return null;
  const m = /\b(\d{1,2}):(\d{2})\b/.exec(t);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

// PURE: split a known venue off the END of a "<title> <venue>" head, returning
// { title, venue }. When no known venue ends the head, the whole head is the title and
// venue is null (we never guess a venue from an arbitrary trailing phrase — a wrong
// venue is worse than none).
export function splitTicketmasterVenue(head: string): {
  title: string;
  venue: string | null;
} {
  const h = head.trim();
  for (const v of KNOWN_VENUES) {
    if (h.endsWith(" " + v)) {
      return { title: h.slice(0, h.length - v.length).trim(), venue: v };
    }
    if (h === v) return { title: v, venue: v };
  }
  return { title: h, venue: null };
}

// Leading "<long weekday>, <D> de <month> de <YYYY>, <HH:MM> <short wd> <D> <mon>
// [<YYYY>] <HH:MM>" preamble of the full-Spanish form. We cut everything up to and
// including the SECOND (short) time cell so what remains is "<title> <venue>".
const FULL_PREAMBLE =
  /^[A-Za-zÀ-ÿ]+,\s*\d{1,2}\s+de\s+[A-Za-zÀ-ÿ]+\s+de\s+\d{4},\s*\d{1,2}:\d{2}\s+[A-Za-zÀ-ÿ]+\.?\s+\d{1,2}\s+[A-Za-zÀ-ÿ]+\.?\s+(?:\d{4}\s+)?\d{1,2}:\d{2}\s+/;

// "Entradas <title>, Valencia <venue> <D/M/YY>, <HH:MM>" — the per-ticket-type form.
// Title = group 1, venue+date tail = group 2. We then strip the trailing date/time
// off group 2 to isolate the venue.
const ENTRADAS = /^Entradas\s+(.+?),\s*Valencia\s+(.+)$/i;
// Trailing "<D/M/YY>, <HH:MM>" (or "<D/M/YYYY> <HH:MM>") date cell of the Entradas form.
const ENTRADAS_TAIL = /\s+\d{1,2}\/\d{1,2}\/\d{2,4},?\s*\d{1,2}:\d{2}\s*$/;

// PURE: derive { title, venue } from a Ticketmaster card title across both forms.
// Form (B) "Entradas …, Valencia …" is detected first (it leads with "Entradas");
// otherwise we strip the full-Spanish preamble (A) and split a known venue off the
// tail. Returns the best-effort title (never empty when the head has text) + venue.
export function parseTicketmasterHead(rawTitle: string): {
  title: string;
  venue: string | null;
} {
  const t = rawTitle.trim();

  // Form (B): "Entradas <TITLE>, Valencia <VENUE> <date>, <time>"
  const ent = ENTRADAS.exec(t);
  if (ent) {
    const title = ent[1].trim();
    // group 2 = "<VENUE> <D/M/YY>, <HH:MM>" → drop the trailing date/time → venue.
    let venuePart = ent[2].replace(ENTRADAS_TAIL, "").trim();
    // prefer the canonical known-venue spelling when it matches the tail.
    const known = splitTicketmasterVenue(venuePart).venue;
    const venue = known ?? (venuePart || null);
    return { title, venue };
  }

  // Form (A): strip the duplicated weekday/date/time preamble, then split venue off
  // the tail of the remaining "<title> <venue>".
  const head = t.replace(FULL_PREAMBLE, "").trim();
  if (head && head !== t) {
    return splitTicketmasterVenue(head);
  }

  // No recognised preamble — fall back to splitting a known venue off whatever we have.
  return splitTicketmasterVenue(t);
}

// PURE: turn pending Ticketmaster raw rows into event drafts. Keeps ONLY `/event/`
// listing cards (drops `/artist/`, `/venue/`, nav/chrome, the page snapshot, and
// junk via isJunkCard). DB-free so it unit-tests offline. Undated rows still emit
// (start_date null) — a wrong date is worse than none (mirrors worldafisha/fever).
export function buildTicketmasterEvents(
  rows: RawItem[],
  today: Date = new Date(),
): Array<{ draft: EventInsert; sourceItemId: number }> {
  const out: Array<{ draft: EventInsert; sourceItemId: number }> = [];
  for (const item of rows) {
    const raw = parseRaw(item);
    // The full-page snapshot is the listing index, not an event — skip it.
    if (raw.kind === "page_snapshot") continue;
    // Keep ONLY real `/event/` listings; `/artist/`, `/venue/`, `/discover/`,
    // `/help/`, `/feature/`, blog/business/help links are not single events.
    if (!isTicketmasterEventUrl(item.url)) continue;

    const rawTitle = compact(item.title);
    if (!rawTitle) continue;
    // Deterministic non-event / chrome guard (shared, T146). A real dated listing is
    // never matched; nav/legal/email/header cards are dropped.
    if (isJunkCard(rawTitle, item.raw_text, "Ticketmaster")) continue;

    const { title, venue } = parseTicketmasterHead(rawTitle);
    if (!title) continue;

    const start = parseEventDate(rawTitle, today);
    const startTime = parseTicketmasterTime(rawTitle);
    const { price, isFree } = parsePrice(rawTitle);

    out.push({
      sourceItemId: item.id,
      draft: {
        title: title.slice(0, 300),
        description: rawTitle.slice(0, 2000),
        category: "concert",
        language: "es",
        audience: "all",
        start_date: start,
        start_time: startTime,
        venue_name: venue,
        city: "Valencia",
        country: "Spain",
        price,
        is_free: isFree,
        url: item.url ?? SOURCE_URL,
        image_url: raw.meta?.["og:image"] || null,
        source: TICKETMASTER_SOURCE_KEY,
        source_url: item.url ?? SOURCE_URL,
        raw_excerpt: rawTitle.slice(0, 1000),
      },
    });
  }
  return out;
}

// Normalizer for Ticketmaster. Reads pending raw rows, builds event drafts, upserts
// each idempotently (shared `upsertPlainEvent`), then marks EVERY processed raw row
// normalized append-only (including dropped rows — never deletes raw rows,
// constitution I). `exec` is injectable for tests.
export async function normalizeTicketmaster(
  { exec = sql }: { exec?: typeof sql } = {},
): Promise<{ created: number; updated: number; processed: number }> {
  const rows = (await exec`
    SELECT * FROM source_items
    WHERE source_key = ${TICKETMASTER_SOURCE_KEY}
      AND (normalized_status IS NULL OR normalized_status = 'pending'
           OR normalized_at IS NULL OR normalized_at < last_seen)
  `) as unknown as RawItem[];

  const drafts = buildTicketmasterEvents(rows);
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

  // Append-only: mark every raw row processed (incl. dropped nav/artist/venue rows).
  for (const item of rows) {
    await markRawItem(item.id, "normalized", null, exec);
  }

  return { created, updated, processed: rows.length };
}
