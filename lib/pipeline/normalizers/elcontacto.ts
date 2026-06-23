import { sql } from "../../db";
import { compact } from "../util";
import {
  parseEventDate,
  dateFromUrl,
  runPlainNormalizer,
  type EventInsert,
} from "./shared";
import { parsePrice, parseVenue, parseAddress, isJunkCard } from "./valenciarusa";
import type { RawItem } from "./types";

// elcontacto.ru/valencia/events (web source, key `web:elcontacto`, id 24, FR-001).
// "El Contacto" is a long-running RU-in-Spain community / classifieds portal; the
// Valencia events board is a RU-language agenda. Raw rows arrive from the generic web
// parser as `link_card` (per-listing anchor) or `page_snapshot` (the board page
// itself). We pull date / venue / address / price out of the title+text and emit ONE
// event per real listing, reusing the shared RU/ES extractors (worldafisha date
// parsing + valenciarusa price/venue/address/junk guard). Already a Valencia-local RU
// board, so NO Spain pre-filter is needed (unlike worldafisha).
//
// REALITY (live local DB, 2026-06): the board URL `/valencia/events` currently 404s — the
// three ingested rows are ALL CHROME and contain NO real, dated event:
//   id 244  page_snapshot — title+body literally "404 ошибка. Страница не найдена"
//   id 245  link_card     — mailto:info@elcontacto.ru (an email link)
//   id 246  link_card     — https://elcontacto.ru/ispaniya/  "Объявления о продаже"
//                           (for-sale classifieds nav, country-level /ispaniya/ path)
// 0 events is therefore the CORRECT output — there is genuinely nothing to extract, and
// we do NOT fabricate a date. We (a) drop the page_snapshot, (b) drop any row whose URL is
// not a real listing under the board (mailto:, non-/valencia/ nav links), (c) drop the 404
// page by title/text, (d) drop generic nav/legal/email chrome via isJunkCard, and (e) drop
// elcontacto-specific classifieds-board labels via isElcontactoChrome (defense-in-depth, so
// the drop never depends on the URL path alone). When the board returns real dated listings,
// the SAME code extracts them. Deterministic (T140 — JS before LLM); fail-soft + append-only.

export const ELCONTACTO_SOURCE_KEY = "web:elcontacto";
const SOURCE_URL = "https://elcontacto.ru/valencia/events";
// Display name of the site — used by isJunkCard to recognise bare header/chrome cards.
const ELCONTACTO_NAME = "Elcontacto.ru";

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

// PURE: a board listing is a real event only when its URL is an on-site Valencia
// listing under elcontacto.ru. The board itself ("/valencia/events"), the classifieds
// nav ("/ispaniya/", "/objyavleniya", catalogs), off-site / mailto links and the like
// are NOT single events → dropped. We require the host to be elcontacto.ru AND the path
// to live under "/valencia" but NOT be the board index page itself.
export function isEventUrl(url?: string | null): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false; // drop mailto:/tel:
  if (!/(?:^|\.)elcontacto\.ru$/i.test(u.hostname)) return false;
  const path = u.pathname.replace(/\/+$/, "");
  // Must be under the Valencia events board, and must not be the bare board index.
  if (!/^\/valencia(?:\/|$)/i.test(path)) return false;
  if (/^\/valencia\/events$/i.test(path)) return false;
  return true;
}

// PURE: the 404 / error page the board currently serves. Recognised by the RU "404
// ошибка" / "страница не найдена" markers (or the EN/ES equivalents) so the error
// snapshot is dropped even if it somehow arrives as a non-snapshot row.
function isErrorPage(title?: string | null, body?: string | null): boolean {
  const hay = `${compact(title) ?? ""} ${compact(body) ?? ""}`.toLowerCase();
  return (
    /\b404\b/.test(hay) ||
    /страница не найдена/.test(hay) ||
    /сторінку не знайдено/.test(hay) ||
    /page not found/.test(hay) ||
    /página no encontrada/.test(hay)
  );
}

// PURE: elcontacto-specific classifieds-portal chrome that the shared NAV_LABELS list
// (valenciarusa.isJunkCard) does NOT cover. This is a russophone-in-Spain classifieds
// site, so its nav links are board labels like "Объявления о продаже" (for-sale ads),
// "Каталог фирм" (firm catalog), "Подать объявление" (post an ad). The live `/ispaniya/`
// nav row ("Объявления о продаже") is already dropped by isEventUrl (off-/valencia/ path),
// but this guard is defense-in-depth: if the SAME label ever arrives with an on-site
// `/valencia/` URL it is still dropped — so the drop never depends on the URL path alone.
// Whole-card exact match (after compaction); a real listing carries far more text.
const ELCONTACTO_NAV_LABELS = [
  "объявления", "объявления о продаже", "подать объявление",
  "каталог фирм", "топовые запросы", "карта сайта", "разделы",
  "недвижимость", "работа", "блог", "помощь",
];
function isElcontactoChrome(title?: string | null, body?: string | null): boolean {
  const t = compact(title) ?? "";
  const b = compact(body) ?? "";
  const text = (b.length >= t.length ? b : t).trim().toLowerCase();
  if (!text) return true;
  return ELCONTACTO_NAV_LABELS.includes(text);
}

// PURE: turn pending elcontacto raw rows into event drafts (date/venue/address/price
// extracted where derivable). The full-page snapshot is dropped (no single event
// identity); non-listing URLs (mailto:, classifieds nav, off-site) are dropped; the
// 404/error page and nav/legal/email chrome are dropped. The slug rarely carries a
// date, so the date comes primarily from the RU/ES text via parseEventDate; a trailing
// "YYYY-MM-DD" slug (if the board ever uses one) is preferred. DB-free so it
// unit-tests without a connection.
export function buildElcontactoEvents(
  rows: RawItem[],
  today: Date = new Date(),
): Array<{ draft: EventInsert; sourceItemId: number }> {
  const out: Array<{ draft: EventInsert; sourceItemId: number }> = [];
  for (const item of rows) {
    const raw = parseRaw(item);
    // The full-page snapshot is the board/404 index, not an event — skip it.
    if (raw.kind === "page_snapshot") continue;
    // The 404/error page (however it arrived) carries no event — skip it.
    if (isErrorPage(item.title, item.raw_text)) continue;
    // Keep ONLY real on-site Valencia listing URLs (drops mailto:, /ispaniya/ nav, the
    // board index, and off-site links).
    if (!isEventUrl(item.url)) continue;

    const title = compact(item.title);
    if (!title) continue;

    // Drop nav / contact / legal / email / bare-header chrome. Deterministic; a real
    // dated listing is never matched. Shared guard first, then the elcontacto-specific
    // classifieds-board labels (defense-in-depth: drop never relies on the URL alone).
    if (isJunkCard(title, item.raw_text, ELCONTACTO_NAME)) continue;
    if (isElcontactoChrome(title, item.raw_text)) continue;

    const haystack = `${title} ${item.raw_text || ""}`;
    // The board text carries the date in RU/ES; prefer a trailing slug date if present.
    const start = dateFromUrl(item.url) ?? parseEventDate(haystack, today);
    const { price, isFree } = parsePrice(haystack);
    const venue = parseVenue(haystack);
    const address = parseAddress(haystack);

    out.push({
      sourceItemId: item.id,
      draft: {
        title: title.slice(0, 300),
        description: compact(item.raw_text)?.slice(0, 2000) ?? null,
        category: "culture",
        language: "ru",
        start_date: start,
        venue_name: venue,
        address,
        city: "Valencia",
        country: "Spain",
        price,
        is_free: isFree,
        url: item.url ?? SOURCE_URL,
        image_url: raw.meta?.["og:image"] || null,
        source: ELCONTACTO_SOURCE_KEY,
        source_url: item.url ?? SOURCE_URL,
        raw_excerpt: compact(item.raw_text)?.slice(0, 1000) ?? null,
      },
    });
  }
  return out;
}

// Normalizer for elcontacto. Reads pending raw rows, builds event drafts, upserts each
// idempotently (shared `upsertPlainEvent`), then marks EVERY processed raw row
// normalized — including dropped chrome rows (append-only: never deletes a raw row —
// constitution I). Delegates the canonical orchestration to `runPlainNormalizer`
// (T183 F2). `exec` is injectable for tests.
export async function normalizeElcontacto(
  { exec = sql }: { exec?: typeof sql } = {},
): Promise<{ created: number; updated: number; processed: number }> {
  return runPlainNormalizer({
    sourceKey: ELCONTACTO_SOURCE_KEY,
    build: buildElcontactoEvents,
    exec,
  });
}
