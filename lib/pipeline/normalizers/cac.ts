import { sql } from "../../db";
import { compact } from "../util";
import {
  parseEventDate,
  runPlainNormalizer,
  readEventLinks,
  matchEventLink,
  latestSnapshotRows,
  type EventInsert,
  type EventLink,
} from "./shared";
import { parsePrice } from "./valenciarusa";
import type { RawItem } from "./types";

// T177 — Ciutat de les Arts i les Ciències (cac.es), a FLAGSHIP Valencia venue
// crawled across four listing pages, each its own source key:
//   web:cac_exposiciones  → standing/long-running EXHIBITIONS (multi-day span)
//   web:cac_museu         → mixed: museum exhibitions + conferences/activities
//   web:cac_agenda        → upcoming events (concerts/conferences/activities)
//   web:cac_actividades   → activities/conferences (mostly single-day)
//
// SHAPE (the lacotorra pattern). The generic web parser stores, per source, ONE
// `page_snapshot` row carrying the WHOLE flattened listing plus N `link_card` rows
// that hold only a bare title (the date lives on the un-crawled detail page). So we
// PARSE the snapshot and DROP every link_card. The snapshot's `raw_text` renders each
// card as a fixed-shape block of consecutive lines:
//
//   <TITLE>                       e.g. "PARK EUN SUN. GENOMA Y ESTRUCTURA ESCULTÓRICA"
//   [Temporal | Permanente]       exhibition status keyword (exposiciones/museu only)
//   [: DD/MM/YYYY]                exhibition START date (note the leading colon)
//   [– DD/MM/YYYY]                exhibition END date (an en/em dash + date)
//   [DD/MM/YYYY] | [DD Mon YYYY]  single-date events (agenda/actividades/conferences)
//   [– DD Mon YYYY]               an explicit end for the "DD Mon YYYY" form
//   Recinto:                      venue marker
//   <VENUE>                       e.g. "Museu de les Ciències"
//   <DESCRIPTION …>               a short teaser
//   Ver más | Más información | … card footer
//
// We anchor on the TITLE line, then scan FORWARD (until the "Recinto:" / footer / next
// title) collecting date lines and the venue. Dates are parsed by DETERMINISTIC ES/CA
// rules (T140 — JS before LLM): numeric DD/MM/YYYY, ES abbreviated months ("28 Abr
// 2026"), the leading-colon exhibition span, and the title-embedded "A PARTIR DEL N DE
// <MES>" form. A block with NO usable date is marked processed but NOT emitted (we
// never invent a date — constitution / T140). City = Valencia (cac.es is in Valencia).
//
// ROUTING: web:cac_exposiciones + web:cac_museu default to the EXHIBITION shape — we set
// an exhibition category and ALWAYS keep `end_date` when the text gives one, so the T175
// exposition feature (multi-day [start,end] span + exhibition category → spanning bar)
// picks them up. web:cac_agenda + web:cac_actividades default to plain dated events.
// Per-block signals (a "Temporal" keyword or an "exposición"/"exhibition" title) can
// still upgrade a row to the exhibition shape regardless of source.
//
// Fail-soft + append-only (constitution): never throws; every processed raw row is
// marked normalized; the raw layer is never deleted.

export const CAC_SOURCE_KEYS = [
  "web:cac_actividades",
  "web:cac_agenda",
  "web:cac_exposiciones",
  "web:cac_museu",
] as const;

// Only the dedicated Exposiciones listing is a PURE exhibitions page → blanket
// exhibition default. web:cac_museu is MIXED (exhibitions + conferences + activities),
// so a museu block is an exhibition ONLY via a per-block signal (a Temporal/Permanente
// status keyword, an "exposición" title, or a real multi-day span) — otherwise a
// single-day museu conference would be mislabelled an exhibition.
const EXPO_SOURCES = new Set<string>(["web:cac_exposiciones"]);

const SOURCE_URL_BY_KEY: Record<string, string> = {
  "web:cac_actividades": "https://cac.es/actividades/",
  "web:cac_agenda": "https://cac.es/agenda/",
  "web:cac_exposiciones": "https://cac.es/exposiciones/",
  "web:cac_museu": "https://cac.es/museu-de-les-ciencies/",
};

// Category we tag exhibitions with. Matches `lib/queries.ts` EXPO_TEXT_RE
// (выстав|экспоз|exposici[oó]n|exhibition) so isExposition() detects it, and is the
// RU label the rest of the feed uses for exhibitions.
const EXPO_CATEGORY = "выставка";

interface RawWeb {
  kind?: string;
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

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// PURE: whole days between two YYYY-MM-DD dates (end − start). Returns 0 when either is
// missing/unparseable. Used to detect a genuine multi-day exhibition span.
function spanDays(start?: string | null, end?: string | null): number {
  if (!start || !end) return 0;
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

// ES (Spanish) + CA (Valencian) month names → number, for the "DD Mon YYYY" abbreviated
// form and the title-embedded "A PARTIR DEL N DE <MES>" form. 3-letter stems match the
// abbreviations cac renders ("Abr", "Dic"); full names match the title phrases.
const ES_MONTHS: Array<[RegExp, number]> = [
  [/^(ene|enero|gener)/i, 1],
  [/^(feb|febrero|febrer)/i, 2],
  [/^(mar|marzo|març)/i, 3],
  [/^(abr|abril)/i, 4],
  [/^(may|mayo|maig)/i, 5],
  [/^(jun|junio|juny)/i, 6],
  [/^(jul|julio|juliol)/i, 7],
  [/^(ago|agosto|agost)/i, 8],
  [/^(sep|set|septiembre|setembre)/i, 9],
  [/^(oct|octubre)/i, 10],
  [/^(nov|noviembre|novembre)/i, 11],
  [/^(dic|diciembre|desembre)/i, 12],
];

function esMonth(word: string): number {
  const w = word.trim();
  for (const [re, m] of ES_MONTHS) {
    if (re.test(w)) return m;
  }
  return 0;
}

// PURE: parse ONE cac date line into an ISO YYYY-MM-DD (or null). A line is a date line
// when it is, after a possible leading ":" or en/em dash, ONE of:
//   • numeric  "02/07/2026"  (DD/MM/YYYY)
//   • ES month "28 Abr 2026" (DD Mon YYYY)
// The leading ":" / "–" decoration (exhibition start/end markers) is stripped first.
// Anchored so a date embedded inside a description sentence isn't picked up here (that's
// handled separately for the title via parseEventDate). Returns null for non-date lines.
export function parseCacDateLine(line?: string | null): string | null {
  let t = compact(line);
  if (!t) return null;
  // strip a leading exhibition decoration ":" or en/em/hyphen dash
  t = t.replace(/^\s*[:–—-]\s*/u, "").trim();

  // numeric DD/MM/YYYY (also DD/MM/YY)
  const num = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s*$/.exec(t);
  if (num) {
    const day = Number(num[1]);
    const month = Number(num[2]);
    let year = Number(num[3]);
    if (year < 100) year += 2000;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${pad(month)}-${pad(day)}`;
    }
    return null;
  }

  // ES abbreviated "DD Mon YYYY"
  const es = /^(\d{1,2})\s+([A-Za-zÀ-ÿ]{3,})\.?\s+(\d{4})\s*$/.exec(t);
  if (es) {
    const day = Number(es[1]);
    const month = esMonth(es[2]);
    const year = Number(es[3]);
    if (month >= 1 && month <= 31 && day >= 1 && day <= 31) {
      return `${year}-${pad(month)}-${pad(day)}`;
    }
  }
  return null;
}

// PURE: a date EMBEDDED in a title, e.g. "…¡BAILAR! … A PARTIR DEL 2 DE JULIO". cac
// titles sometimes carry only a start hint with no year — we infer the next occurrence
// via the shared parseEventDate (which understands ES "N de <mes>"). Returns null when
// the title carries no date phrase.
export function dateFromTitle(title?: string | null, today: Date = new Date()): string | null {
  const t = compact(title);
  if (!t) return null;
  // "a partir del 2 de julio" / "del 2 de julio" / "2 de julio"
  const m = /(\d{1,2})\s+de\s+([A-Za-zÀ-ÿ]{3,})/i.exec(t);
  if (!m) return null;
  return parseEventDate(`${m[1]} de ${m[2]}`, today);
}

// Card-footer markers that close a block (the line after the description).
const FOOTER_RE = /^(ver m[áa]s|m[áa]s informaci[óo]n|ver conferencia|reservar ya|comprar entradas|ver todas?(\s|$)|ver todos)/i;
// The venue marker line.
const RECINTO_RE = /^recinto\s*:?\s*$/i;
// Exhibition status keywords (their presence flags an exhibition block).
const STATUS_RE = /^(temporal|permanente)\s*$/i;
// Section headers cac prints between groups of cards (NOT titles).
const SECTION_RE =
  /^(exposiciones|conferencias|talleres|actividades|proyecciones|hist[óo]rico|agenda|inicio|programaci[óo]n|edificios|descubre|categor[íi]a|recinto|ubicaci[óo]n|fecha|ordenar por|ultimas|antiguas|buscar|men[úu]|cerrar|espa[ñn]ol|ingl[ée]s|valenciano|planea tu visita|ver todas?|ver todos)\b/i;

// Lines that can never be a title (chrome / structural).
function isStructuralLine(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (RECINTO_RE.test(t)) return true;
  if (STATUS_RE.test(t)) return true;
  if (FOOTER_RE.test(t)) return true;
  if (parseCacDateLine(t) != null) return true;
  if (/^[:–—-]/.test(t)) return true; // a bare end-date dash line
  if (SECTION_RE.test(t)) return true;
  if (t.length < 5) return true;
  return false;
}

// PURE: does a line look like a card TITLE? cac renders titles in UPPER CASE (often with
// a leading 📢 emoji). We require a meaningful run of uppercase letters and that it isn't
// a structural/chrome line. Conservative — a description sentence (mostly lowercase) is
// rejected, so it stays attached to its block rather than starting a phantom one.
export function looksLikeCacTitle(line?: string | null): boolean {
  const t = compact(line);
  if (!t) return false;
  if (isStructuralLine(t)) return false;
  const letters = t.replace(/[^A-Za-zÀ-ÿА-Яа-яЁё]/g, "");
  if (letters.length < 4) return false;
  const upper = (t.match(/[A-ZÀ-ÝА-ЯЁ]/g) || []).length;
  // Titles are mostly upper-case; descriptions are mostly lower-case. Require ≥60% of the
  // cased letters to be upper-case (cac titles like "EXPOSICIÓN MEMORIA" are ~100%).
  return upper / letters.length >= 0.6;
}

interface CacBlock {
  title: string;
  start: string | null;
  end: string | null;
  venue: string | null;
  description: string | null;
  isExhibition: boolean;
}

// PURE: split a cac snapshot's flattened raw_text into card blocks. We anchor each block
// on a TITLE line, then scan forward — collecting status/date/venue/description — until
// the next title or a hard section break. The first title in the page is preceded by the
// page chrome (nav/menus); those structural lines are skipped by looksLikeCacTitle.
export function splitCacBlocks(rawText?: string | null): CacBlock[] {
  const text = rawText || "";
  const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
  const blocks: CacBlock[] = [];

  let i = 0;
  while (i < lines.length) {
    if (!looksLikeCacTitle(lines[i])) {
      i++;
      continue;
    }
    const title = compact(lines[i])!;
    let start: string | null = null;
    let end: string | null = null;
    let venue: string | null = null;
    let description: string | null = null;
    let isExhibition = false;

    // Scan forward until the next title or a section break.
    let j = i + 1;
    let sawRecinto = false;
    for (; j < lines.length; j++) {
      const ln = lines[j];
      if (looksLikeCacTitle(ln)) break; // next card begins

      if (STATUS_RE.test(ln)) {
        isExhibition = true;
        continue;
      }
      const d = parseCacDateLine(ln);
      if (d != null) {
        // First date = start; a later date (the "– DD/MM/YYYY" line) = end.
        if (start == null) start = d;
        else if (end == null) end = d;
        continue;
      }
      if (RECINTO_RE.test(ln)) {
        sawRecinto = true;
        continue;
      }
      // The line right after "Recinto:" is the venue name.
      if (sawRecinto && !venue && !FOOTER_RE.test(ln) && !SECTION_RE.test(ln)) {
        venue = compact(ln);
        sawRecinto = false;
        continue;
      }
      if (FOOTER_RE.test(ln)) {
        // Card footer — block ends here (the next line begins the following card's
        // title or a section header).
        j++;
        break;
      }
      // Otherwise it's (part of) the description: keep the first/longest paragraph.
      if (!description && ln.length > 20 && !SECTION_RE.test(ln)) {
        description = compact(ln);
      }
    }

    blocks.push({ title, start, end, venue, description, isExhibition });
    i = j;
  }
  return blocks;
}

// PURE: cac lists SHOP PROMOS (gift vouchers, anniversary "golden ticket" campaigns) in
// the same grid as real exhibitions/events — e.g. "REGALA UNA EXPERIENCIA ÚNICA ESTAS
// NAVIDADES", "GOLDEN TICKETS – 25º ANIVERSARIO". These are not cultural programming, so we
// drop them (T179 #2) rather than mislabel them as exhibitions.
const PROMO_RE =
  /\bregala\b|tarjeta\s+regalo|vale\s+regalo|cheque\s+regalo|\bgift\b|golden\s+ticket|\bvoucher\b/i;
export function isCacPromo(title?: string | null): boolean {
  return PROMO_RE.test(title ?? "");
}

// PURE: turn the cac snapshot rows into event/exhibition drafts. DB-free; offline-testable.
export function buildCacEvents(
  rows: RawItem[],
  today: Date = new Date(),
): Array<{ draft: EventInsert; sourceItemId: number }> {
  const out: Array<{ draft: EventInsert; sourceItemId: number }> = [];
  const seen = new Set<string>(); // de-dupe identical title+date across the page

  // T190: only the freshest snapshot per source key (a stale older capture would clobber
  // the fresh one's per-event links via the cross-row de-dupe).
  for (const item of latestSnapshotRows(rows)) {
    const raw = parseRaw(item);
    // ONLY the page_snapshot carries the dated blocks; every link_card is a bare title.
    if (raw.kind !== "page_snapshot") continue;

    const sourceKey = item.source_key;
    const sourceUrl = SOURCE_URL_BY_KEY[sourceKey] ?? item.url ?? "https://cac.es/";
    const img = raw.meta?.["og:image"] || null;
    const exhibitionDefault = EXPO_SOURCES.has(sourceKey);
    // T190: per-event detail links (title→/exposiciones|conferencias/<slug>) captured at
    // ingest; used to point each block at its own cac.es page instead of the listing.
    const eventLinks: EventLink[] = readEventLinks(raw);

    for (const block of splitCacBlocks(item.raw_text)) {
      let { title } = block;
      title = compact(title) ?? "";
      if (title.length < 4) continue;
      if (isCacPromo(title)) continue; // shop promo (gift voucher / golden ticket), not real programming

      // Determine start date: a block date wins; else a date embedded in the title.
      const start = block.start ?? dateFromTitle(title, today);
      if (!start) continue; // never invent a date (T140 / constitution)

      // Is this an exhibition? The pure Exposiciones source defaults yes; otherwise a
      // per-block signal: a Temporal/Permanente status keyword, an "exposición"/
      // "exhibition" title, or a genuine multi-day span (≥4 days — matches lib/queries
      // MIN_EXPO_SPAN_DAYS, so a single-day conference on the mixed museu page is NOT
      // mislabelled an exhibition).
      const titleSaysExpo = /exposici[oó]n|exhibition|выстав|экспоз/i.test(title);
      const longSpan =
        block.end != null &&
        block.end !== start &&
        spanDays(start, block.end) >= 4;
      const isExhibition =
        exhibitionDefault || block.isExhibition || titleSaysExpo || longSpan;

      const dedupeKey = `${title.toLowerCase()}|${start}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const haystack = `${title} ${block.description ?? ""}`;
      const { price, isFree } = parsePrice(haystack);

      // T190: resolve this block's OWN cac.es detail page from the captured card links;
      // fall back to the listing URL only when no card matches confidently.
      const detailUrl = matchEventLink(title, eventLinks) ?? sourceUrl;

      out.push({
        sourceItemId: item.id,
        draft: {
          title: title.slice(0, 300),
          description: compact(block.description)?.slice(0, 2000) ?? null,
          category: isExhibition ? EXPO_CATEGORY : "culture",
          language: "es",
          start_date: start,
          // Exhibitions ALWAYS keep their end_date span (T175 spanning-bar). For a plain
          // single-day event the parsed end (== start) is harmless but we only carry a
          // real, distinct end.
          end_date: block.end && block.end !== start ? block.end : null,
          venue_name: block.venue ?? "Ciutat de les Arts i les Ciències",
          address: "Av. del Professor López Piñero, 7",
          district: null,
          city: "Valencia",
          country: "Spain",
          price,
          is_free: isFree,
          url: detailUrl,
          image_url: img,
          source: sourceKey,
          source_url: detailUrl,
          raw_excerpt: compact(block.description)?.slice(0, 1000) ?? null,
        },
      });
    }
  }
  return out;
}

// Normalizer for ONE cac.es source key. Reads its pending raw rows, parses the snapshot
// into drafts, upserts each idempotently (shared `upsertPlainEvent`), then marks EVERY
// processed raw row normalized append-only — including the dropped link_card rows
// (constitution I: never deletes). The four cac source keys each register a bound
// normalizer (see `cacNormalizerFor`). `exec` injectable for tests.
export async function normalizeCacSource(
  sourceKey: string,
  { exec = sql }: { exec?: typeof sql } = {},
): Promise<{ created: number; updated: number; processed: number }> {
  return runPlainNormalizer({ sourceKey, build: buildCacEvents, exec });
}

// A registry-shaped normalizer (no-arg) bound to a single cac source key.
export function cacNormalizerFor(
  sourceKey: string,
): () => Promise<{ created: number; updated: number; processed: number }> {
  return () => normalizeCacSource(sourceKey);
}
