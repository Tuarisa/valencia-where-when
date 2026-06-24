import { sql } from "../../db";
import { compact } from "../util";
import { normTitle, runPlainNormalizer, type EventInsert } from "./shared";
import { isJunkCard } from "./valenciarusa";
import type { RawItem } from "./types";

// T112-style — hoyvalencia.app (web source, key `web:hoyvalencia`, id 11). The
// "Qué hacer este fin de semana en Valencia" weekend culture roundup. The generic
// web parser stores each listing as a `link_card` row whose `title` (== `raw_text`)
// is the FLATTENED card text and whose `url` is the deep `/planes/<slug>/` link.
// There is NO ISO datetime; the real structure, per live rows, is a fixed token
// order with NO delimiters:
//
//   "[<price-phrase>] <category> <date-phrase> <TITLE …> <VENUE …> <CITY>"
//
//   e.g. "Gratis Exposiciones Hasta el 27 jun 2026 Exposición 'La Naturaleza de
//         las Cosas' Las Atarazanas Valencia"
//        "¡Oferta con descuento! Desde 5.6 € Teatro y espectáculos 19 jun 2026
//         Sueños En Escena + Burlesque Teatre Talia València"
//
// We deterministically (T140 — JS before LLM) strip the leading price-phrase,
// category badge and date-phrase off the FRONT and the trailing city/town token off
// the BACK, leaving the head (`<title> <venue>`) — which we keep AS the title. The
// site provides NO delimiter between title and venue, so (like Fever's
// `splitFeverVenue`) we do NOT guess a venue from an arbitrary phrase: a wrong venue
// is worse than none, so `venue_name` stays null. The trailing town becomes `city`
// (València/Valencia → "Valencia"; surrounding towns kept as-is). Date semantics:
//   • "DD mmm YYYY"        → start_date (a single dated session)
//   • "Hasta el DD mmm YYYY" → end_date only (an ongoing run "until …"; no start)
//   • "✱ ¡Solo hoy!" / "¡Termina hoy!"      → start_date = today
//   • "✱ ¡Solo mañana!" / "¡Termina mañana!" → start_date = today + 1
//   • "Fechas disponibles"  → no date (TBD; null — render undated rather than guess)
//
// Rows that are NOT events — the page snapshot, category-nav anchors (`#planes` /
// the custom-date picker, whose URL is NOT a `/planes/<slug>/` listing), and chrome
// caught by the shared `isJunkCard` — are dropped. Every raw row is marked
// normalized append-only; an unparseable draft is skipped, never thrown
// (constitution: pipeline is fail-soft + append-only).

export const HOYVALENCIA_SOURCE_KEY = "web:hoyvalencia";
const SOURCE_URL = "https://www.hoyvalencia.app/que-hacer-este-fin-de-semana-en-valencia/";

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

// Spanish month abbreviations as hoyvalencia renders them ("27 jun 2026"). Keyed by
// the exact lowercase 3-letter form (the site never uses the 4-letter "sept").
const ES_MONTHS: Record<string, number> = {
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6,
  jul: 7, ago: 8, sep: 9, oct: 10, nov: 11, dic: 12,
};

// Leading price-phrases, longest/most-specific first so a compound prefix is removed
// whole. "¡Oferta con descuento!" can lead before either a "Desde NN €" or a
// "Consultar precio". "Gratis" / "Consultar precio" / "Desde NN €" also stand alone.
const PRICE_PHRASES = [
  /^¡Oferta con descuento!\s*/i,
  /^Desde\s+\d+(?:[.,]\d+)?\s*€\s*/i,
  /^Consultar precio\s*/i,
  /^Gratis\s*/i,
];

// Category badges that follow the price-phrase. Longest-first so "Actividades
// deportivas" is matched before "Deportes" etc. Anchored to the FRONT of the
// remaining head after price-stripping.
const CATEGORIES = [
  "Teatro y espectáculos",
  "Charlas y talleres",
  "Actividades deportivas",
  "Exposiciones",
  "Conciertos",
  "Monólogos",
  "Musicales",
  "Para niños",
  "Deportes",
  "Otros",
].sort((a, b) => b.length - a.length);

// Map a hoyvalencia category badge → our internal category bucket.
const CATEGORY_MAP: Record<string, string> = {
  "Teatro y espectáculos": "theatre",
  "Musicales": "theatre",
  "Monólogos": "comedy",
  "Conciertos": "concert",
  "Exposiciones": "exhibition",
  "Charlas y talleres": "workshop",
  "Para niños": "kids",
  "Deportes": "sport",
  "Actividades deportivas": "sport",
  "Otros": "culture",
};

// The trailing city/town token. València / Valencia normalise to "Valencia"; the
// surrounding municipalities are kept verbatim. Order is irrelevant (exact last-word
// match), but listing them lets us recognise the boundary token deterministically.
const CITY_TOKENS: Record<string, string> = {
  "valència": "Valencia",
  "valencia": "Valencia",
  "cullera": "Cullera",
  "mislata": "Mislata",
  "burjassot": "Burjassot",
  "alzira": "Alzira",
  "gandia": "Gandia",
  "sagunto": "Sagunto",
};

// A single "DD mmm YYYY" date cell anywhere in the date-phrase region.
const DATE_CELL = /\b(\d{1,2})\s+(ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)\s+(\d{4})\b/i;
// "Hasta el DD mmm YYYY" — an ongoing run that ends on that date (no explicit start).
const HASTA = /Hasta el\s+(\d{1,2})\s+(ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)\s+(\d{4})/i;
// "Del [DD mmm YYYY] al DD mmm YYYY" — a date RANGE (start "Del …", end "al …"). The
// hoyvalencia weekend roundup prefixes multi-day listings with this. The START cell can
// be ABSENT in the flattened card ("Del al 28 jun 2026"), so the first "DD mmm YYYY" is
// optional; when present it is the start, the cell after "al" is always the end.
const DEL_AL =
  /Del\s+(?:(\d{1,2})\s+(ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)\s+(\d{4})\s+)?al\s+(\d{1,2})\s+(ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)\s+(\d{4})/i;
// Relative urgency badges hoyvalencia renders with a "✱" decoration.
const SOLO_HOY = /✱?\s*¡Solo hoy!|✱?\s*¡Termina hoy!/i;
const SOLO_MANANA = /✱?\s*¡Solo mañana!|✱?\s*¡Termina mañana!/i;
const FECHAS = /Fechas disponibles/i;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isoFromCell(day: number, monAbbr: string, year: number): string | null {
  const month = ES_MONTHS[monAbbr.toLowerCase()] ?? 0;
  if (!month || day < 1 || day > 31) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

function isoFromDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// PURE: parse the hoyvalencia date-phrase out of a card title into { start, end }.
//   • "Del DD mmm YYYY al DD mmm YYYY" → { start:ISO, end:ISO } (a multi-day range; the
//     start cell may be ABSENT in the flattened card → { start:null, end:ISO })
//   • "Hasta el DD mmm YYYY" → { start:null, end:ISO } (ongoing run "until …")
//   • "DD mmm YYYY"          → { start:ISO,  end:null }
//   • "✱ ¡Solo/Termina hoy!"   → start = today
//   • "✱ ¡Solo/Termina mañana!" → start = today + 1
//   • else ("Fechas disponibles" / nothing) → { null, null }
// `today` is injectable so tests are deterministic.
export function parseHoyvalenciaDates(
  text?: string | null,
  today: Date = new Date(),
): { start: string | null; end: string | null } {
  const t = compact(text);
  if (!t) return { start: null, end: null };

  // "Del [DD mmm YYYY] al DD mmm YYYY" → range (start "Del …", end "al …"). Tested
  // FIRST: it contains two bare DATE_CELLs, so the single-cell branch below would
  // otherwise read the "al" end cell as a lone start. The start cell may be missing in
  // the flattened card ("Del al 28 jun 2026") → start stays null, end is kept.
  const r = DEL_AL.exec(t);
  if (r) {
    const start = r[1] ? isoFromCell(Number(r[1]), r[2], Number(r[3])) : null;
    const end = isoFromCell(Number(r[4]), r[5], Number(r[6]));
    return { start, end };
  }

  // "Hasta el …" → end-only (must be tested before the bare DATE_CELL, which it
  // contains). A run that ends today/in the future is still "ongoing now".
  const h = HASTA.exec(t);
  if (h) {
    const end = isoFromCell(Number(h[1]), h[2], Number(h[3]));
    return { start: null, end };
  }

  // A single concrete "DD mmm YYYY" cell → start date.
  const d = DATE_CELL.exec(t);
  if (d) {
    const start = isoFromCell(Number(d[1]), d[2], Number(d[3]));
    return { start, end: null };
  }

  // Relative urgency badges → today / tomorrow.
  if (SOLO_HOY.test(t)) return { start: isoFromDate(today), end: null };
  if (SOLO_MANANA.test(t)) {
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return { start: isoFromDate(tomorrow), end: null };
  }

  // "Fechas disponibles" (or no signal) → undated; render rather than guess.
  return { start: null, end: null };
}

// PURE: price from the leading price-phrase. "Gratis" → Free (is_free=1); "Desde
// NN €" / "¡Oferta con descuento! Desde NN €" → "€ NN"; "Consultar precio" → null
// (price on request — never invent one).
export function parseHoyvalenciaPrice(
  text?: string | null,
): { price: string | null; isFree: number | null } {
  const t = compact(text);
  if (!t) return { price: null, isFree: null };
  if (/\bGratis\b/i.test(t)) return { price: "Free", isFree: 1 };
  const m = /Desde\s+(\d+(?:[.,]\d+)?)\s*€/i.exec(t);
  if (m) return { price: `€ ${m[1].replace(",", ".")}`, isFree: 0 };
  return { price: null, isFree: null };
}

// PURE: strip the leading price-phrase(s) + the category badge off the front of a
// card title, returning { head, category } where `head` is the remaining
// "<date-phrase> <title> <venue> <city>" text and `category` is the matched badge
// (raw Spanish label, or null if none led the head).
export function stripHoyvalenciaPrefix(title: string): { head: string; category: string | null } {
  let t = compact(title) ?? "";
  // Price phrases can stack ("¡Oferta con descuento! Desde 10 €"); peel each that
  // currently leads, until none do.
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of PRICE_PHRASES) {
      if (re.test(t)) {
        t = t.replace(re, "");
        changed = true;
      }
    }
  }
  let category: string | null = null;
  for (const c of CATEGORIES) {
    if (t === c || t.startsWith(c + " ")) {
      category = c;
      t = t.slice(c.length).trim();
      break;
    }
  }
  return { head: t.trim(), category };
}

// PURE: cut the date-phrase off the FRONT of the post-prefix head, leaving
// "<title> <venue> <city>". Handles "Hasta el DD mmm YYYY", a bare "DD mmm YYYY", a
// relative "✱ ¡Solo/Termina hoy/mañana!" badge, or "Fechas disponibles". When the
// date-phrase isn't at the very front we still cut at its position so the title is
// never polluted with a date.
export function stripHoyvalenciaDatePhrase(head: string): string {
  let t = compact(head) ?? "";
  // Try each known date-phrase; remove from its start to its end (anchored where it
  // actually sits, which for these rows is the front of the head). The "Del … al …"
  // RANGE is tried FIRST — it spans two date cells (and the literal "Del"/"al" words),
  // so the single-cell pattern below would otherwise leave a "Del al <cell>" remnant
  // glued onto the title. The optional start cell covers the flattened "Del al 28 …".
  const patterns: RegExp[] = [
    /Del\s+(?:\d{1,2}\s+(?:ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)\s+\d{4}\s+)?al\s+\d{1,2}\s+(?:ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)\s+\d{4}/i,
    /Hasta el\s+\d{1,2}\s+(?:ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)\s+\d{4}/i,
    /\b\d{1,2}\s+(?:ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)\s+\d{4}\b/i,
    /✱?\s*¡Solo hoy!/i,
    /✱?\s*¡Termina hoy!/i,
    /✱?\s*¡Solo mañana!/i,
    /✱?\s*¡Termina mañana!/i,
    /Fechas disponibles/i,
  ];
  for (const re of patterns) {
    const m = re.exec(t);
    if (m) {
      t = (t.slice(0, m.index) + " " + t.slice(m.index + m[0].length)).trim();
      // a lone leftover "✱" decoration can survive; drop it.
      t = t.replace(/\s*✱\s*/g, " ").replace(/\s+/g, " ").trim();
      return t;
    }
  }
  return t.replace(/\s*✱\s*/g, " ").replace(/\s+/g, " ").trim();
}

// PURE: split the trailing city/town token off the head, returning { title, city }.
// The flattened card always ends with a known municipality (Valencia/València/…);
// it becomes `city` (València/Valencia → "Valencia") and everything before it is the
// title (`<title> <venue>` kept together — no reliable delimiter, see file header).
// When the last token isn't a known town, city defaults to "Valencia" and the whole
// head is the title.
export function splitHoyvalenciaCity(head: string): { title: string; city: string } {
  const t = compact(head) ?? "";
  const parts = t.split(/\s+/);
  const last = (parts[parts.length - 1] || "").toLowerCase().replace(/[.,;]+$/, "");
  if (parts.length > 1 && CITY_TOKENS[last]) {
    return { title: parts.slice(0, -1).join(" ").trim(), city: CITY_TOKENS[last] };
  }
  return { title: t, city: "Valencia" };
}

// PURE: a hoyvalencia row is a real event listing only when its URL is a
// `/planes/<slug>/` deep link. The `#planes` category-nav anchors and the
// custom-date picker (`/que-hacer-fecha-personalizada-…`) are listing/nav pages,
// not single events → dropped.
export function isHoyvalenciaEventUrl(url?: string | null): boolean {
  return !!url && /\/planes\/[^/]+\/?$/.test(url.split(/[?#]/)[0]);
}

// PURE: turn pending hoyvalencia raw rows into event drafts. Keeps ONLY
// `/planes/<slug>/` listing cards; the page snapshot, category-nav anchors and
// chrome (isJunkCard) are dropped. DB-free so it unit-tests offline.
export function buildHoyvalenciaEvents(
  rows: RawItem[],
  today: Date = new Date(),
): Array<{ draft: EventInsert; sourceItemId: number }> {
  const out: Array<{ draft: EventInsert; sourceItemId: number }> = [];
  // Same-source de-dupe within this hoyvalencia batch (mirrors cac's `seen` set). The
  // weekend roundup lists the same show twice (e.g. a "Desde NN €" offer card AND a
  // "Consultar precio" card for the same "Carmina Burana", venue spelled inconsistently)
  // — the cross-source fuzzy dedup pass needs ≥2 DISTINCT sources, so it never collapses
  // a SAME-source dup. We key on the accent/case-folded cleaned title + start_date and
  // keep the first occurrence; later identical rows are dropped (still marked normalized
  // upstream). normTitle folds "Sofia"/"Sofía" + "Les"/"les" so the variant pair merges.
  const seen = new Set<string>();
  for (const item of rows) {
    const raw = parseRaw(item);
    // The full-page snapshot is the index, not an event.
    if (raw.kind === "page_snapshot") continue;
    // Keep only real `/planes/<slug>/` listings; drop `#planes` nav + date picker.
    if (!isHoyvalenciaEventUrl(item.url)) continue;

    const rawTitle = compact(item.title);
    if (!rawTitle) continue;
    // Shared chrome guard (bare nav label / email / header). Deterministic; a real
    // dated listing is never matched.
    if (isJunkCard(rawTitle, item.raw_text)) continue;

    const { price, isFree } = parseHoyvalenciaPrice(rawTitle);
    const { head, category } = stripHoyvalenciaPrefix(rawTitle);
    const afterDate = stripHoyvalenciaDatePhrase(head);
    const { title, city } = splitHoyvalenciaCity(afterDate);
    if (!title) continue;

    const { start, end } = parseHoyvalenciaDates(rawTitle, today);

    const dedupeKey = `${normTitle(title)}|${start ?? ""}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    out.push({
      sourceItemId: item.id,
      draft: {
        title: title.slice(0, 300),
        description: rawTitle.slice(0, 2000),
        category: category ? (CATEGORY_MAP[category] ?? "culture") : "culture",
        language: "es",
        start_date: start,
        end_date: end,
        city,
        country: "Spain",
        price,
        is_free: isFree,
        url: item.url ?? SOURCE_URL,
        image_url: raw.meta?.["og:image"] || null,
        source: HOYVALENCIA_SOURCE_KEY,
        source_url: item.url ?? SOURCE_URL,
        raw_excerpt: rawTitle.slice(0, 1000),
      },
    });
  }
  return out;
}

// Normalizer for hoyvalencia. Reads pending raw rows, builds event drafts, upserts
// each idempotently (shared `upsertPlainEvent`), then marks EVERY processed raw row
// normalized — including the dropped ones — append-only (never deletes raw rows —
// constitution I). Delegates the canonical orchestration to `runPlainNormalizer`
// (T183 F2). `exec` is injectable for tests.
export async function normalizeHoyvalencia(
  { exec = sql }: { exec?: typeof sql } = {},
): Promise<{ created: number; updated: number; processed: number }> {
  return runPlainNormalizer({
    sourceKey: HOYVALENCIA_SOURCE_KEY,
    build: buildHoyvalenciaEvents,
    exec,
  });
}
