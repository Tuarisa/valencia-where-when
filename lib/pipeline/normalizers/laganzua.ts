import { sql } from "../../db";
import { compact } from "../util";
import {
  parseEventDate,
  runPlainNormalizer,
  type EventInsert,
} from "./shared";
import { isJunkCard } from "./valenciarusa";
import type { RawItem } from "./types";

// laganzua.net (web source, key `web:laganzua`, id 15). "La Ganzúa" is an
// independent-music concerts agenda. The seeded page is the Valencia weekend
// filter (…/conciertos/valencia/este-fin-de-semana-2026), but the generic web
// parser flattens the WHOLE page into per-anchor `link_card` rows, so the feed
// also pulls in the site's nation-wide "GRANDES CONCIERTOS" / "LOS 10 MÁS
// BUSCADOS" highlight blocks (Madrid/Barcelona/Vigo…), plus nav chrome, news and
// footer links. Per live rows (47 of them):
//
//   • the DATE lives in the TITLE text, in Spanish day-first form, e.g.
//       "Zaz en Madrid lunes 22 de junio de 2026"
//       "Bigsound Festival 2026 Valencia en Torrent, Valencia viernes 26 de junio de 2026"
//     i.e. "<title> en <city> <weekday> <DD> de <month> de <YYYY>". The URL slug
//     carries ONLY a numeric id (…-1014366), never a date — so the title is the
//     single reliable date source (UNLIKE worldafisha, whose slug ends in the date).
//   • the undated "MÁS BUSCADOS" rows ("Quevedo - Madrid") have no parseable date;
//     they fall through to start_date=null.
//   • venue/price are NOT present in these flattened cards (raw_text == title).
//
// We deterministically (T140 — JS before LLM): drop nav/chrome/news/junk rows,
// CITY-FILTER to Valencia (the page is Valencia-scoped but the highlight blocks are
// national — a Madrid concert must not pollute a Valencia feed), parse the Spanish
// date out of the title, and STRIP the trailing "en <city> … <YYYY>" tail so the
// event title is just the artist/festival name. Every raw row is marked normalized
// append-only; an unparseable draft is skipped, never thrown (constitution:
// pipeline is fail-soft + append-only).

export const LAGANZUA_SOURCE_KEY = "web:laganzua";
const SOURCE_URL = "https://www.laganzua.net/conciertos/valencia/este-fin-de-semana-2026";
// Display name of the site — lets isJunkCard recognise bare header/chrome cards.
const LAGANZUA_NAME = "La Ganzúa";

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

// Spanish weekday words La Ganzúa prefixes onto the date ("… lunes 22 de junio …").
// Used only as part of the date-tail strip; never surfaced.
const WEEKDAYS = "lunes|martes|mi[ée]rcoles|jueves|viernes|s[áa]bado|domingo";

// The trailing "en <city> [<weekday>] <DD> de <month> de <YYYY>" tail on a dated
// La Ganzúa title. We cut the title at the LAST " en " that introduces this tail so
// the head is just the show name. Spanish month names (any inflection) are required
// after "de" so an artist whose name contains " en " (rare) isn't truncated early.
const DATE_TAIL = new RegExp(
  `\\s+en\\s+.+?(?:${WEEKDAYS})?\\s*\\d{1,2}\\s+de\\s+[a-zá-ú]+\\s+de\\s+\\d{4}\\s*$`,
  "iu",
);

// "This is a Valencia-region listing" detection. The page is the Valencia weekend
// filter, but the flattened highlight blocks are NATIONAL ("GRANDES CONCIERTOS":
// Madrid/Barcelona/Vigo…), so we must keep only Valencia-region rows. Two signals,
// both deterministic (T140) and both observed in the live title grammar
// ("<show> en <Town>[, <Province>] <weekday> <DD> de <month> de <YYYY>"):
//
//   1. PROVINCE TAIL — a "…, Valencia"/"…, València" suffix names the PROVINCE, so the
//      town is anywhere in the Valencia province. Live row 506 (Bigsound) reads
//      "… en Torrent, Valencia …". This is the robust, future-proof signal: it keeps
//      ANY Valencia-province town (Torrent, Cullera, Xàtiva, Cheste, Gandia…) without
//      a hand-maintained whitelist — the original 9-town list silently DROPPED every
//      Valencia-province town it didn't enumerate.
//   2. CITY NAME — the provincial capital prints WITHOUT a province tail
//      ("… en València …"), plus a few common comarca capitals, so we still match a
//      bare city name. Word-boundary matched so "Valencia" inside another word isn't a
//      false positive.
//
// A national row (Madrid, Barcelona, Vigo, Pontevedra, …) matches neither and is dropped.
const VALENCIA_PROVINCE_TAIL = /,\s*val[èe]ncia\b/i;
const VALENCIA_CITY = /\b(valencia|val[èe]ncia|torrent|paterna|gandia|sagunto|burjassot|mislata|alboraya|cullera|x[àa]tiva|alzira|ontinyent|requena|cheste|llír[ií]a)\b/i;

// PURE: does a (possibly dated) La Ganzúa title belong to the Valencia region?
// True when the title carries a ", València/Valencia" PROVINCE tail OR names a
// Valencia-area city. Deterministic keyword test; never fabricates.
export function isValenciaTitle(title?: string | null): boolean {
  const t = compact(title);
  if (!t) return false;
  return VALENCIA_PROVINCE_TAIL.test(t) || VALENCIA_CITY.test(t);
}

// PURE: strip the trailing "en <city> … <DD> de <month> de <YYYY>" date tail off a
// La Ganzúa title, leaving just the show/festival name. When no tail is present the
// title is returned unchanged (compacted). Never returns empty for a non-empty input.
export function cleanLaganzuaTitle(title?: string | null): string {
  const t = compact(title) ?? "";
  const stripped = t.replace(DATE_TAIL, "").trim();
  return stripped || t;
}

// URL shapes that are NOT a single concert: the conciertos/festivales/discos/news
// index + nav anchors, the "add a concert" form, the agenda/category landing pages,
// the weekend page itself, and footer/legal links. A real concert listing is
// `…/conciertos/<artist-slug>-<numeric-id>`; a category nav anchor is a short
// `…/conciertos/<word>` with no trailing numeric id. We require the trailing numeric
// id to accept a row as an event candidate.
function isConcertUrl(url?: string | null): boolean {
  if (!url) return false;
  // must be a /conciertos/<slug>-<digits> listing (the id is the last path segment tail)
  return /\/conciertos\/[^/]+-\d{4,}\/?$/i.test(url.split(/[?#]/)[0]);
}

// PURE: turn pending La Ganzúa raw rows into Valencia event drafts. Drops the page
// snapshot, nav/chrome/news/junk rows, non-concert URLs, and non-Valencia listings;
// parses the Spanish date out of the title and cleans the title tail. DB-free so it
// unit-tests without a connection.
export function buildLaganzuaEvents(
  rows: RawItem[],
  today: Date = new Date(),
): Array<{ draft: EventInsert; sourceItemId: number }> {
  const out: Array<{ draft: EventInsert; sourceItemId: number }> = [];
  for (const item of rows) {
    const raw = parseRaw(item);
    // The full-page snapshot is the index, not an event — skip it.
    if (raw.kind === "page_snapshot") continue;

    const rawTitle = compact(item.title);
    if (!rawTitle) continue;

    // Drop nav / legal / chrome / bare-header cards (deterministic; a real dated
    // listing is never matched).
    if (isJunkCard(rawTitle, item.raw_text, LAGANZUA_NAME)) continue;

    // Keep ONLY real concert listing URLs (…/conciertos/<slug>-<id>). Category nav
    // anchors (/conciertos/agenda-conciertos, /conciertos/conciertos-gratis), the
    // weekend page itself, news (/noticias/…) and footer links are dropped.
    if (!isConcertUrl(item.url)) continue;

    // CITY filter: the page is Valencia-scoped but the flattened highlight blocks are
    // national. Keep only rows whose title names a Valencia-area city.
    if (!isValenciaTitle(rawTitle)) continue;

    const start = parseEventDate(rawTitle, today);
    const title = cleanLaganzuaTitle(rawTitle);
    if (!title) continue;

    out.push({
      sourceItemId: item.id,
      draft: {
        title: title.slice(0, 300),
        description: rawTitle.slice(0, 2000),
        category: "concert",
        language: "es",
        audience: "all",
        start_date: start,
        city: "Valencia",
        country: "Spain",
        url: item.url ?? SOURCE_URL,
        image_url: raw.meta?.["og:image"] || null,
        source: LAGANZUA_SOURCE_KEY,
        source_url: item.url ?? SOURCE_URL,
        raw_excerpt: rawTitle.slice(0, 1000),
      },
    });
  }
  return out;
}

// Normalizer for La Ganzúa. Reads pending raw rows, builds Valencia event drafts,
// upserts each idempotently (shared `upsertPlainEvent`), then marks EVERY processed
// raw row normalized append-only — including dropped rows (never deletes raw rows —
// constitution I). Delegates the canonical orchestration to `runPlainNormalizer`
// (T183 F2). `exec` is injectable for tests.
export async function normalizeLaganzua(
  { exec = sql }: { exec?: typeof sql } = {},
): Promise<{ created: number; updated: number; processed: number }> {
  return runPlainNormalizer({
    sourceKey: LAGANZUA_SOURCE_KEY,
    build: buildLaganzuaEvents,
    exec,
  });
}
