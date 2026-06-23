import { sql } from "../../db";
import { compact } from "../util";
import { markRawItem } from "./types";
import type { RawItem } from "./types";
import { upsertPlainEvent, type EventInsert } from "./shared";

// T151 — feverup.com Valencia (web/ticketing source, key `web:fever`, id 12). The
// generic web parser stores each Fever listing card as a `link_card` row whose
// `title` (== `raw_text`) is the FLATTENED card text and whose `url` is the deep
// link. There is NO ISO datetime anywhere; the real structure is, per live rows:
//
//   "<venue> <show title> [<rating> (<count>)] <day mon>[ - <day mon>] [Edición
//    Limitada] [Desde] <NN,NN> €"
//
//   e.g. "Ateneo Mercantil de Valencia Candlelight: Tributo a Ludovico Einaudi 4.7
//         (469) 4 jul - 27 mar Desde 17,50 €"
//
// We deterministically (T140 — JS before LLM) strip the trailing
// rating/date/price tail to isolate the head (`<venue> <title>`), split a known
// Valencia venue off the front, parse the Spanish "4 jul" → ISO start_date (and an
// optional range end), and pull the "Desde 17,50 €" price. Rows that are not events
// (category-nav anchors, gift cards / "Tarjeta Regalo" / "Special Edition" gift
// cards, "Lista de Espera" waitlists) are skipped. Undated real events still emit
// (start_date null) — a wrong date is worse than none (mirrors worldafisha). Every
// raw row is marked normalized append-only; an unparseable draft is skipped, never
// thrown (constitution: pipeline is fail-soft + append-only).

export const FEVER_SOURCE_KEY = "web:fever";
const SOURCE_URL = "https://feverup.com/es/valencia";

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

// Spanish month abbreviations as Fever renders them in card text. Note the listing
// uses the 4-letter "sept" for September alongside the 3-letter forms; both are
// covered. Keyed by exact lowercase abbreviation (stripped of a trailing dot).
const ES_MONTHS: Record<string, number> = {
  ene: 1,
  feb: 2,
  mar: 3,
  abr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  ago: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dic: 12,
};

// One day-month token, e.g. "4 jul" / "19 sept". Spanish abbreviations only.
const DAY_MONTH = "(\\d{1,2})\\s+(ene|feb|mar|abr|may|jun|jul|ago|sept?|oct|nov|dic)\\b";
// A full Fever date cell: a single day-month or a "<from> - <to>" range.
const DATE_CELL = new RegExp(`${DAY_MONTH}(?:\\s*-\\s*${DAY_MONTH})?`, "i");
// Trailing price: optional "Desde", then NN,NN (or NN.NN) €. A row may carry a
// struck/discounted second price ("25,00 € 22,00 €"); the first match (the leading,
// usually higher "from" price) is taken as the headline price.
const PRICE = /(?:Desde\s*)?(\d+[.,]\d{2})\s*€/i;
// Rating badge Fever appends after the title: "4.7 (469)". Used only as a left
// boundary to find where the head ends; never surfaced.
const RATING = /\s\d\.\d\s*\(\d+\)/;
// Top-10 ranking prefix Fever renders as a duplicated number, e.g. "1 1 ".
const TOP10 = /^(\d{1,2})\s+\1\s+/;

// Known Valencia venues Fever prefixes onto the card title (no delimiter separates
// venue from show, so we must match a known prefix to split them). Longest-first so
// a more specific venue wins over a shorter prefix of it.
const KNOWN_VENUES = [
  "Auditorio Mar Rojo - Oceanogràfic València",
  "Jardines del Real or Viveros",
  "Ateneo Mercantil de Valencia",
  "Casino Cirsa Valencia",
  "Radio City Valencia",
  "Sala Moon Valencia",
  "Teatre La Plazeta",
  "Teatro Carolina",
  "Peter Rock Club",
  "Nuevo Cuenca",
  "ZEVRA FESTIVAL",
].sort((a, b) => b.length - a.length);

// Non-event card markers: gift cards, waitlists, plain category badges. A Fever row
// matching any of these is a product/nav card, not a dated experience → dropped.
const NON_EVENT = /tarjeta\s+regalo|gift\s+card|special\s+edition|lista\s+de\s+espera/i;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function monthFromAbbr(abbr?: string | null): number {
  if (!abbr) return 0;
  return ES_MONTHS[abbr.toLowerCase().replace(/\.$/, "")] ?? 0;
}

// Resolve a (month, day) with no explicit year to the NEXT occurrence on/after the
// reference date `today` (local-date semantics): a month/day already passed this
// year rolls to next year. Fever cards never carry a year in the date cell.
function inferYear(month: number, day: number, today: Date): number {
  const y = today.getFullYear();
  const tm = today.getMonth() + 1;
  const td = today.getDate();
  if (month < tm || (month === tm && day < td)) return y + 1;
  return y;
}

// PURE: parse the Fever Spanish date cell out of a card head/tail into ISO
// start/end. Handles a single "4 jul" and a "5 dic - 6 feb" range. Year is inferred
// to the next occurrence (cells are year-less). For a cross-year range (e.g. Dec →
// Feb) the end year rolls forward so end >= start. Returns nulls when no date cell.
export function parseFeverDates(
  text?: string | null,
  today: Date = new Date(),
): { start: string | null; end: string | null } {
  const t = compact(text);
  if (!t) return { start: null, end: null };
  const m = DATE_CELL.exec(t);
  if (!m) return { start: null, end: null };
  const startDay = Number(m[1]);
  const startMon = monthFromAbbr(m[2]);
  if (!startMon || startDay < 1 || startDay > 31) return { start: null, end: null };
  const startYear = inferYear(startMon, startDay, today);
  const start = `${startYear}-${pad(startMon)}-${pad(startDay)}`;

  let end: string | null = null;
  if (m[3] && m[4]) {
    const endDay = Number(m[3]);
    const endMon = monthFromAbbr(m[4]);
    if (endMon && endDay >= 1 && endDay <= 31) {
      // End belongs to the same start year unless it falls before the start month
      // (a wrap into the next calendar year, e.g. Dec → Feb).
      const endYear = endMon < startMon ? startYear + 1 : startYear;
      end = `${endYear}-${pad(endMon)}-${pad(endDay)}`;
    }
  }
  return { start, end };
}

// PURE: pull the headline price out of a card title. Normalizes the comma decimal
// to a dot and returns a "€ NN.NN" string (or null). Never invents a price.
export function parseFeverPrice(text?: string | null): string | null {
  const t = compact(text);
  if (!t) return null;
  const m = PRICE.exec(t);
  if (!m) return null;
  return `€ ${m[1].replace(",", ".")}`;
}

// PURE: split a known venue prefix off the head, returning { venue, title }. When no
// known venue leads the head, the whole head is the title and venue is null (we do
// NOT guess a venue from an arbitrary leading phrase — a wrong venue is worse).
export function splitFeverVenue(head: string): { venue: string | null; title: string } {
  for (const v of KNOWN_VENUES) {
    if (head.startsWith(v + " ")) {
      return { venue: v, title: head.slice(v.length).trim() };
    }
    if (head === v) return { venue: v, title: v };
  }
  return { venue: null, title: head };
}

// PURE: from a flattened Fever card title, isolate the head (`<venue> <title>`) by
// cutting at the FIRST of rating / date / price (whichever appears earliest), after
// stripping any top-10 ranking prefix. Returns "" when nothing precedes the tail.
export function feverHead(title: string): string {
  let t = title.replace(TOP10, "");
  const cuts: number[] = [];
  const r = RATING.exec(t);
  if (r) cuts.push(r.index);
  const d = DATE_CELL.exec(t);
  if (d) cuts.push(d.index);
  const p = PRICE.exec(t);
  if (p) cuts.push(p.index);
  const cut = cuts.length ? Math.min(...cuts) : t.length;
  return t.slice(0, cut).trim();
}

// PURE: turn pending Fever raw rows into event drafts. Keeps ONLY `/m/<id>` listing
// cards (the deep-link experiences); category-nav anchors, the page snapshot, and
// gift-card / waitlist products are dropped. DB-free so it unit-tests offline.
export function buildFeverEvents(
  rows: RawItem[],
  today: Date = new Date(),
): Array<{ draft: EventInsert; sourceItemId: number }> {
  const out: Array<{ draft: EventInsert; sourceItemId: number }> = [];
  for (const item of rows) {
    const raw = parseRaw(item);
    // The full-page snapshot is the index, not an event — skip it.
    if (raw.kind === "page_snapshot") continue;
    // Keep only real experience deep links; category-nav anchors (e.g. /candlelight,
    // /festivales) have no `/m/` id and are listing pages, not single events.
    if (!item.url || !/feverup\.com\/m\//.test(item.url)) continue;

    const rawTitle = compact(item.title);
    if (!rawTitle) continue;
    // Gift cards / waitlists are products, not dated experiences.
    if (NON_EVENT.test(rawTitle)) continue;

    const head = feverHead(rawTitle);
    if (!head) continue;
    const { venue, title } = splitFeverVenue(head);
    if (!title) continue;

    const { start, end } = parseFeverDates(rawTitle, today);
    const price = parseFeverPrice(rawTitle);

    out.push({
      sourceItemId: item.id,
      draft: {
        title: title.slice(0, 300),
        description: rawTitle.slice(0, 2000),
        category: "concert",
        language: "es",
        audience: "all",
        start_date: start,
        end_date: end,
        venue_name: venue,
        city: "Valencia",
        country: "Spain",
        price,
        url: item.url ?? SOURCE_URL,
        image_url: raw.meta?.["og:image"] || null,
        source: FEVER_SOURCE_KEY,
        source_url: item.url ?? SOURCE_URL,
        raw_excerpt: rawTitle.slice(0, 1000),
      },
    });
  }
  return out;
}

// Normalizer for Fever. Reads pending raw rows, builds event drafts, upserts each
// idempotently, then marks every raw row normalized append-only (never deletes raw
// rows — constitution I). `exec` is injectable for tests.
export async function normalizeFever(
  { exec = sql }: { exec?: typeof sql } = {},
): Promise<{ created: number; updated: number; processed: number }> {
  const rows = (await exec`
    SELECT * FROM source_items
    WHERE source_key = ${FEVER_SOURCE_KEY}
      AND (normalized_status IS NULL OR normalized_status = 'pending'
           OR normalized_at IS NULL OR normalized_at < last_seen)
  `) as unknown as RawItem[];

  const drafts = buildFeverEvents(rows);
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
    await markRawItem(item.id, "normalized", null, exec);
  }

  return { created, updated, processed: rows.length };
}
