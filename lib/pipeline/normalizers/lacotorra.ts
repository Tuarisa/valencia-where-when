import { sql } from "../../db";
import { compact } from "../util";
import {
  parseEventDate,
  runPlainNormalizer,
  type EventInsert,
} from "./shared";
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

// ── T170: HYBRID city filter ────────────────────────────────────────────────
// lacotorra covers ALL of Spain (~34 Valencia / Comunitat Valenciana events + ~22
// elsewhere: Madrid, Barcelona, Granada, Bilbao, A Coruña, Mérida, Las Palmas…).
// For a Valencia afisha the user chose a HYBRID policy:
//   • KEEP every event in the Comunitat Valenciana (provinces València, Alacant/
//     Alicante, Castelló/Castellón — incl. their towns).
//   • From OTHER Spanish cities keep ONLY major international headliners
//     (Linkin Park, BTS, Sting, Bruno Mars, Garbage, Cirque du Soleil, …).
//   • DROP everything else.
// All of this is DETERMINISTIC (T140 — JS, no LLM). The signal: lacotorra bakes the
// city into the RU title as a trailing "…в <Городе>" (and sometimes in a separate
// city line / geocoded location_notes). The stored `city` column is UNRELIABLE here
// (it defaults to "Valencia" when no city line is present, so many real Madrid/
// Granada/Mérida events sit under city='Valencia') — so we read all three signals.

// RU + Latin stems for Comunitat Valenciana places (province cities & well-known
// towns). Matched as case-insensitive substrings against title + city + location_notes.
// "comunitat/comunidad valenciana" is the geocoder's region label (location_notes).
const CV_STEMS: string[] = [
  // region label (appears in geocoded location_notes)
  "comunitat valenciana", "comunidad valenciana", "comunitat valencià",
  // Valencia city/province (RU + Latin) — "валенс"/"valenc" covers Валенсия/Валенсии/
  // València/Valencia. NOTE: do NOT add a bare "valencia" that could match Catalan
  // place names; "valenc" is specific enough here.
  "валенс", "valenc",
  // Alicante / Alacant province (RU + Latin)
  "аликанте", "alicante", "alacant",
  // Castellón / Castelló province (RU + Latin)
  "кастельон", "кастельоне", "castellón", "castelló", "castellon",
  // CV towns / comarcas that lacotorra prints WITHOUT the region word
  "адемус", "адемусе", "ademús", "ademuz",         // Ademús (Valencia prov.)
  "сагунто", "sagunto", "sagunt",                  // Sagunto
  "гандия", "gandia", "gandía",                    // Gandía
  "эльче", "elche", "elx",                         // Elche (Alicante)
  "бенидорм", "benidorm",                          // Benidorm (Alicante)
  "хатива", "xàtiva", "xativa", "játiva",          // Xàtiva
  "честе", "cheste",                               // Cheste (circuit)
  "рекена", "requena", "утьель", "utiel",          // Requena-Utiel
  "кальпе", "calpe", "calp",                       // Calpe
  "хавеа", "xàbia", "javea", "jávea",              // Xàbia / Jávea
  "дения", "denia", "dénia",                       // Dénia
  "saler", "салер",                                // El Saler (Valencia)
  "bobal", "бобаль",                               // Tierra Bobal Fest (Valencia prov.)
];

// Cities/regions OUTSIDE the Comunitat Valenciana that lacotorra prints. A title that
// names one of these (and NOT a CV place) is non-Valencia — keep only if a headliner.
// Used to make isValenciaRegion robust against a CV default-city false positive: even
// if city='Valencia' (the default), a title saying "в Мадриде" is NOT Valencia.
const NON_CV_STEMS: string[] = [
  "мадрид", "madrid",
  "барселон", "barcelona", "barcelon", "catalunya", "cataluña",
  "гранад", "granada",
  "бильбао", "bilbao", "bbk",
  "ла-корун", "корунь", "coruña", "coruna",
  "мерид", "mérida", "merida",
  "лас-пальмас", "пальмас", "palmas", "canaria",
  "севиль", "sevilla", "seville",
  "малаг", "málaga", "malaga",
  "сарагос", "zaragoza", "пуэрто",
];

function hasStem(haystack: string, stems: string[]): boolean {
  return stems.some((s) => haystack.includes(s));
}

// PURE: is this event inside the Comunitat Valenciana? Reads the RU/Latin title plus
// the (unreliable) city and the geocoded location_notes when present. Logic:
//   • a CV stem present AND no competing non-CV stem  → Valencia region (true)
//   • a CV stem AND a non-CV stem (rare cross-region title) → fall to the non-CV side
//   • no city signal at all (default city, generic title) → treat as Valencia (the
//     source's home region; lacotorra's location-less posts are local notices)
// This deliberately favours the explicit "в <Городе>" in the TITLE over the stored
// city, because lacotorra defaults the city column to "Valencia".
export function isValenciaRegion(
  city?: string | null,
  locationNotes?: string | null,
  title?: string | null,
): boolean {
  const hay = `${title ?? ""} ${city ?? ""} ${locationNotes ?? ""}`.toLowerCase();
  const cv = hasStem(hay, CV_STEMS);
  const nonCv = hasStem(hay, NON_CV_STEMS);
  if (cv && !nonCv) return true;
  if (nonCv) return false; // names another region (with or without a stray CV word)
  // No location signal anywhere: default to the source's home region (Valencia).
  return true;
}

// Curated allowlist of MAJOR international headliners (lowercased substrings). When a
// non-Valencia event names one of these acts we KEEP it (the user wants the big tours
// even when they play Madrid/Barcelona). Conservative by design — when unsure, DROP.
// Includes the user-named examples + clearly-international touring acts seen in the
// live lacotorra data (Cirque du Soleil show, BTS, Linkin Park, Sting, Bruno Mars,
// Garbage). Matched as substrings against the RU/Latin title.
const HEADLINER_ALLOWLIST: string[] = [
  "linkin park",
  "линкин парк",
  "bts",                 // RU title prints the latin "BTS"
  "sting",
  "стинг",
  "bruno mars",
  "бруно марс",
  "garbage",
  "cirque du soleil",
  "сирк дю солей",
  "cirque",
  "цирк дю солей",
];

// PURE: does the title name a curated international headliner?
export function isHeadliner(title?: string | null): boolean {
  const t = (title ?? "").toLowerCase();
  if (!t) return false;
  return HEADLINER_ALLOWLIST.some((name) => t.includes(name));
}

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

  let end: string | null = null;
  if (m[5] && m[6] && m[7]) {
    const endMon = EN_MONTHS[m[6].toLowerCase()] ?? 0;
    const endDay = Number(m[5]);
    if (endMon && endDay >= 1 && endDay <= 31) {
      end = `${m[7]}-${pad(endMon)}-${pad(endDay)}`;
    }
  }

  // Bug 3: lacotorra renders a generic OPENING-HOURS time (e.g. "12:00") for a
  // multi-day exhibition/show block — NOT the real start time (the Harry Potter drone
  // show is a 22:30 night show, yet the agenda line reads "26 Jun 2026, 12:00 - 27 Jun
  // 2026, 20:00"). A wrong time is worse than none (user rule). So we only TRUST the
  // start time for a SINGLE-day block (no end date, or end === start); for a multi-day
  // range we drop it (null). Single-day events keep their parsed time.
  const isMultiDay = end != null && end !== start;
  const startTime = isMultiDay ? null : (m[4] ?? null);

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

      // T170 HYBRID city filter (deterministic, T140). lacotorra is all-Spain; this is
      // a Valencia afisha. KEEP everything in the Comunitat Valenciana; from OTHER
      // Spanish cities keep ONLY curated international headliners; DROP the rest.
      // EXCLUSION APPROACH: we simply do NOT emit (don't push) the dropped events.
      // `upsertPlainEvent` hard-codes status='upcoming' and can't carry a 'filtered'
      // status, so skipping the upsert is the cleanest way to keep the feed clean —
      // and it's idempotent: a re-run never creates the dropped rows. The raw
      // source_item is STILL marked processed (the markRawItem loop in
      // normalizeLacotorra walks `rows`, not the emitted drafts), so the append-only
      // raw layer is untouched (constitution I). Existing dropped rows already in the
      // DB from an earlier (pre-filter) normalize are reconciled out-of-band to
      // status='filtered' once (live-DB cleanup), then never re-created here.
      if (!isValenciaRegion(city, null, title) && !isHeadliner(title)) {
        continue;
      }

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
// rows (constitution I: raw layer is append-only; never deletes). Delegates the
// canonical orchestration to `runPlainNormalizer` (T183 F2). `exec` injectable.
export async function normalizeLacotorra(
  { exec = sql }: { exec?: typeof sql } = {},
): Promise<{ created: number; updated: number; processed: number }> {
  return runPlainNormalizer({
    sourceKey: LACOTORRA_SOURCE_KEY,
    build: buildLacotorraEvents,
    exec,
  });
}
