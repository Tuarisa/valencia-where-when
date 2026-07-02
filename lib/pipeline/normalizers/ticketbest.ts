import { sql } from "../../db";
import { compact } from "../util";
import {
  runPlainNormalizer,
  latestSnapshotRows,
  matchEventLink,
  readEventLinks,
  type EventInsert,
  type EventLink,
} from "./shared";
import { isHeadliner } from "./lacotorra";
import type { RawItem } from "./types";

// web:ticketbest — ticketbest.eu, a Russian-diaspora ticketing platform selling
// RU-audience concerts/theatre across ALL of Europe (Riga, Tallinn, Helsinki, Vilnius,
// Narva … and occasionally Spain). Like worldafisha/concerten this MUST be
// Valencia-filtered (T170 hybrid) or the feed floods with Baltic dates a Valencia
// family can't attend.
//
// INGEST SHAPE (generic web parser): the homepage lists performances as CARDS —
// an image anchor to `/performances/<slug>?event_id=N` (slug ENDS with the city:
// `…-riga`, `…-valencia`), a `card_date` ("L • 14 november 2026" + "20:00"), a
// `card_title` anchor with the readable (often bilingual) title suffixed
// "| <City>", and a `card_adress` line "<Country>, <City>, <Venue…>". The parser
// yields ONE `page_snapshot` (whose stripped raw_text preserves the card lines:
// date / time / title / address) plus per-card `link_card` rows (title + URL but
// NO date). So this normalizer is SNAPSHOT-DRIVEN like lacotorra: events are
// parsed from the snapshot's line blocks (they carry the date), and each event's
// specific performance URL is resolved from the sibling link_card rows via the
// shared `matchEventLink` (T190 pattern). The link_card rows themselves are never
// emitted (dateless on their own) — they're marked processed, per the rule that a
// dateless row is processed but not emitted. All deterministic (T140 — no LLM);
// fail-soft; raw layer append-only (constitution I).
//
// KEEP RULE (T170 hybrid for an all-EUROPE site), strongest signal first:
//   1. the card's address COUNTRY must be Spain (et "Hispaania" — the site serves
//      Estonian chrome — plus en/es/ru/lv/lt spellings). This kills the trap card
//      "LOS VIVANCOS — LIVE — Hispaania | Geneva Narva": a Spain-THEMED show that
//      plays in Narva, Estonia (title says Spain, address says Eesti).
//      When the address is missing, fall back to an ES-city match on the slug
//      (the task's core signal: `…-valencia`).
//   2. within Spain: Comunitat Valenciana always (València/Alacant/Castelló — the
//      strict `isCvCity`, affirmative match only: live data showed Marbella slipping
//      through lacotorra's default-true `isValenciaRegion` fallback), other Spanish
//      cities only for curated international headliners (lacotorra's `isHeadliner`,
//      reused) — the T170 policy.

export const TICKETBEST_SOURCE_KEY = "web:ticketbest";
const SOURCE_URL = "https://www.ticketbest.eu";

interface RawWeb {
  kind?: string;
  source_page?: string;
  meta?: Record<string, string>;
  event_links?: Array<{ title: string; url: string }>;
}

function parseRaw(item: RawItem): RawWeb {
  try {
    const r = JSON.parse(item.raw_json || "{}");
    return r && typeof r === "object" ? r : {};
  } catch {
    return {};
  }
}

// Month words → 1-based month for the card_date line ("14 november 2026"). The site
// localises month names (Estonian chrome observed live; RU/EN/ES/LV/LT locales exist),
// so cover the full names per language. Array-based (not an object literal) because
// several months are spelled identically across languages (august, september,
// november) and duplicate object keys would be a TS error.
const TB_MONTH_WORDS: Array<[string[], number]> = [
  [["jaanuar", "january", "января", "январь", "enero", "janvāris", "sausis"], 1],
  [["veebruar", "february", "февраля", "февраль", "febrero", "februāris", "vasaris"], 2],
  [["märts", "marts", "march", "марта", "март", "marzo", "kovas"], 3],
  [["aprill", "april", "апреля", "апрель", "abril", "aprīlis", "balandis"], 4],
  [["mai", "may", "мая", "май", "mayo", "maijs", "gegužė"], 5],
  [["juuni", "june", "июня", "июнь", "junio", "jūnijs", "birželis"], 6],
  [["juuli", "july", "июля", "июль", "julio", "jūlijs", "liepa"], 7],
  [["august", "августа", "август", "agosto", "augusts", "rugpjūtis"], 8],
  [["september", "сентября", "сентябрь", "septiembre", "septembris", "rugsėjis"], 9],
  [["oktoober", "october", "октября", "октябрь", "octubre", "oktobris", "spalis"], 10],
  [["november", "ноября", "ноябрь", "noviembre", "novembris", "lapkritis"], 11],
  [["detsember", "december", "декабря", "декабрь", "diciembre", "decembris", "gruodis"], 12],
];

// PURE: month word (any covered locale, whole word) → 1-12, or 0 when unknown.
export function tbMonth(word?: string | null): number {
  const w = (word || "").toLowerCase().trim();
  if (!w) return 0;
  for (const [words, m] of TB_MONTH_WORDS) {
    if (words.includes(w)) return m;
  }
  return 0;
}

// A card_date line as it survives stripTags: "<D> <monthword> <YYYY>" and nothing else.
const DATE_LINE = /^(\d{1,2})\s+(\p{L}{3,})\.?\s+(\d{4})$/u;
// The card time line: bare "HH:MM".
const TIME_LINE = /^(\d{1,2}:\d{2})$/;

// PURE: parse a ticketbest card date line into an ISO date, or null.
export function parseTbDate(line?: string | null): string | null {
  const t = compact(line);
  if (!t) return null;
  const m = DATE_LINE.exec(t);
  if (!m) return null;
  const day = Number(m[1]);
  const month = tbMonth(m[2]);
  if (!month || day < 1 || day > 31) return null;
  return `${m[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Spain as a COUNTRY word, in the locales the site renders the card_adress country in.
const SPAIN_COUNTRY = new Set([
  "hispaania", // Estonian (observed live)
  "spain", "españa", "espana", "испания", "spānija", "spanija", "ispanija",
]);

// PURE: is the card_adress country token Spain?
export function isSpainCountry(token?: string | null): boolean {
  return SPAIN_COUNTRY.has((token || "").toLowerCase().trim());
}

// Comunitat Valenciana city stems, matched affirmatively against the card_adress CITY
// token. STRICT by design: unlike lacotorra (whose stored city is unreliable, so its
// `isValenciaRegion` defaults unrecognised input to the home region), the ticketbest
// card address ALWAYS names the real city — an unrecognised city (e.g. Marbella, which
// live data proved slips through lacotorra's default-true fallback) must NOT be kept.
// Stems are diacritic-FOLDED (matching is done on NFD-stripped input, so "València" →
// "valencia", "Castelló" → "castello", "Dénia" → "denia").
const CV_CITY_STEMS = [
  "valenc", "валенс", // València / Valencia
  "alicante", "alacant", "аликанте",
  "castell", "кастельон", // Castellón / Castelló
  "gandia", "benidorm", "elche", "elx", "sagunt", "torrevieja",
  "denia", "xabia", "javea", "calp", "cheste", "requena", "utiel", "xativa",
];

// PURE: is this card city inside the Comunitat Valenciana? Affirmative match only —
// no default-true fallback (see CV_CITY_STEMS). Diacritics folded before matching.
export function isCvCity(city?: string | null): boolean {
  const c = (city || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  if (!c) return false;
  return CV_CITY_STEMS.some((s) => c.includes(s));
}

// PURE: the task's core signal — does the performance slug end in a Valencia token?
// (slugs end with the city: `…-zvezda-po-imeni-solntse-valencia?event_id=1127`).
export function isValenciaSlug(url?: string | null): boolean {
  if (!url) return false;
  const path = url.split(/[?#]/)[0].toLowerCase();
  return /(?:^|-)val[eè]ncia\/?$|(?:^|-)valensiya\/?$/.test(path.split("/").pop() || "");
}

// A parsed card block from the snapshot text.
export interface TbCard {
  date: string;       // ISO start date
  time: string | null;
  title: string;      // raw card title, incl. the "| <City>" suffix
  country: string | null;
  city: string | null;
  venue: string | null;
  address: string | null; // full card_adress line
}

// PURE: walk the snapshot's stripped lines and reconstruct the card blocks. Card shape
// in raw_text (weekday letter and "•" are separate junk lines, already noise-tolerant):
//   <D month YYYY>  ← anchor
//   <HH:MM>
//   <Title … | City>
//   <Country, City, Venue…>
export function parseTbCards(text?: string | null): TbCard[] {
  const lines = (text || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const out: TbCard[] = [];
  for (let i = 0; i < lines.length; i++) {
    const date = parseTbDate(lines[i]);
    if (!date) continue;
    const tm = TIME_LINE.exec(lines[i + 1] || "");
    // title follows the time line when present, else the date line directly
    const titleIdx = tm ? i + 2 : i + 1;
    const title = compact(lines[titleIdx]);
    if (!title || title.length < 4) continue;
    if (DATE_LINE.test(title) || TIME_LINE.test(title)) continue;
    if (/^osta pilet$/i.test(title)) continue; // buy-button label, not a title

    // card_adress: "<Country>, <City>, <Venue…>" — requires ≥ 2 commas' worth of parts.
    const addrLine = compact(lines[titleIdx + 1]);
    let country: string | null = null;
    let city: string | null = null;
    let venue: string | null = null;
    let address: string | null = null;
    if (addrLine && addrLine.includes(",") && !DATE_LINE.test(addrLine)) {
      const parts = addrLine.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length >= 2) {
        country = parts[0];
        city = parts[1];
        venue = parts.length >= 3 ? parts[2] : null;
        address = parts.slice(2).join(", ") || null;
      }
    }
    out.push({ date, time: tm ? tm[1] : null, title, country, city, venue, address });
  }
  return out;
}

// PURE: strip the trailing "| <City>" chip off a card title, keeping the readable
// (often bilingual) show title from the page text.
export function cleanTbTitle(title: string): string {
  return compact(title.replace(/\s*\|[^|]*$/, "")) || title;
}

// PURE: turn pending ticketbest raw rows into Valencia-filtered event drafts.
// Snapshot-driven: only the freshest page_snapshot yields events; the link_card rows
// contribute the per-performance URL map (matchEventLink) and are never emitted.
// DB-free so it unit-tests offline.
export function buildTicketbestEvents(
  rows: RawItem[],
): Array<{ draft: EventInsert; sourceItemId: number }> {
  const out: Array<{ draft: EventInsert; sourceItemId: number }> = [];

  // URL map: every link_card row is a (card title → performance URL) pair.
  const links: EventLink[] = [];
  for (const item of rows) {
    const raw = parseRaw(item);
    if (raw.kind === "link_card" && item.title && item.url && /\/performances\//.test(item.url)) {
      links.push({ title: item.title, url: item.url });
    }
  }

  const seen = new Set<string>(); // the same card repeats across page sections
  for (const item of latestSnapshotRows(rows)) {
    const raw = parseRaw(item);
    if (raw.kind !== "page_snapshot") continue;
    // snapshot-captured event_links too (usually empty for this markup; harmless)
    links.push(...readEventLinks(raw));

    for (const card of parseTbCards(item.raw_text)) {
      // T190: this card's own performance page (exact title match incl. the "| City"
      // suffix, which the link_card titles carry verbatim).
      const url = matchEventLink(card.title, links);

      // ── Valencia filter (see header) ────────────────────────────────────────
      // 1) country gate: address country must be Spain; a missing address falls back
      //    to the slug's trailing ES-city token (the task's core `…-valencia` signal).
      const spainByAddress = isSpainCountry(card.country);
      if (!spainByAddress && !(card.country == null && isValenciaSlug(url))) continue;
      // 2) within Spain: Comunitat Valenciana always; elsewhere only headliners (T170).
      //    Strict CV check on the (reliable) address city — no default-true fallback.
      const city = card.city || "Valencia";
      if (!isCvCity(city) && !isHeadliner(card.title)) {
        continue;
      }

      const title = cleanTbTitle(card.title);
      const key = `${title.toLowerCase()}|${card.date}|${card.time ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        sourceItemId: item.id,
        draft: {
          title: title.slice(0, 300),
          description: null,
          category: "concert",
          language: "ru",
          start_date: card.date,
          start_time: card.time,
          venue_name: card.venue,
          address: card.address,
          city,
          country: "Spain",
          url: url ?? SOURCE_URL,
          source: TICKETBEST_SOURCE_KEY,
          source_url: url ?? SOURCE_URL,
          raw_excerpt: compact(
            `${card.date} ${card.time ?? ""} — ${title} (${card.venue ?? city}). Via TicketBest.`,
          ),
        },
      });
    }
  }
  return out;
}

// Normalizer for ticketbest. Canonical plain-event orchestration (T183 F2): load
// pending rows → pure build → idempotent upserts → mark EVERY raw row normalized
// append-only (incl. the dateless link_cards and dropped non-Spain cards — never
// deletes; constitution I). `exec` injectable for tests.
export async function normalizeTicketbest(
  { exec = sql }: { exec?: typeof sql } = {},
): Promise<{ created: number; updated: number; processed: number }> {
  return runPlainNormalizer({
    sourceKey: TICKETBEST_SOURCE_KEY,
    build: buildTicketbestEvents,
    exec,
  });
}
