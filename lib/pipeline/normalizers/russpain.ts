import { sql } from "../../db";
import { compact, nowIso } from "../util";
import {
  parseEventDate,
  postDateOf,
  dateFromUrl,
  upsertPlainEvent,
  type EventInsert,
} from "./shared";
import { parsePrice, parseVenue, parseAddress, isJunkCard } from "./valenciarusa";
import type { RawItem } from "./types";

// T-FR001 — russpain.com (web source, key `web:russpain`, id 25). A RU-in-Spain
// news/community agenda; the Valencia afisha lives at `/afisha/valencia/`. Raw rows
// arrive from the GENERIC web parser as `link_card` (per-listing anchor) or
// `page_snapshot` (the listing page itself). We pull date / venue / address / price
// out of the title+text (and prefer a date encoded in the URL slug when present),
// emitting ONE event per real listing. Already Valencia-scoped (the afisha URL is
// /afisha/valencia/), so NO Spain pre-filter is needed (unlike worldafisha).
//
// REALITY (live local DB, 2026-06 → re-checked 2026-08, T154): russpain.com has been
// REORGANISED into separate language editions; `/afisha/valencia/` first 404'd and now
// serves the ENGLISH NEWS homepage ("RUSSPAIN.COM Spain News in English"). The 2026-08
// crawl therefore yields `/news/<article>/` and `/cat/<category>/` link_cards — NEWS
// ARTICLES ("Málaga Murder Case…", "Solar Eclipse on August 12…"), not events. The
// original fall-through ("any other russpain.com path → judge by card text") emitted 30
// bogus "events" from those (with headline-parsed dates and prices — "Messi Donates
// €80,000" → price 80 €). FIX: the URL guard is now DEFAULT-DENY — only a listing
// DEEPER than `/afisha/valencia/` is an event candidate; `/news/`, `/cat/` and every
// other path are dropped. Plus the T140/T154 rule: NO parseable date → do NOT emit
// (never fabricate). So today this normalizer correctly yields ZERO events; it emits
// again only if the real afisha (dated `/afisha/valencia/<slug>` listings) returns.
// Deterministic, no LLM (T140). Fail-soft + append-only (constitution I/IV): an
// unparseable row is skipped, never throws, and EVERY processed raw row is marked
// normalized.

export const RUSSPAIN_SOURCE_KEY = "web:russpain";
const SOURCE_URL = "https://russpain.com/afisha/valencia/";
// Display name of the site — used by isJunkCard to recognise bare header/chrome cards.
const RUSSPAIN_NAME = "RUSSPAIN";

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

// PURE: russpain-specific non-event URL guard (in addition to the shared isJunkCard
// keyword/shape test). DEFAULT-DENY (T154): the ONLY event-candidate shape is a listing
// DEEPER than the afisha index — `/afisha/valencia/<slug>`. Everything else is dropped:
//   • the afisha INDEX page itself (`/afisha/valencia/` with nothing after it),
//   • news articles (`/news/<article>/`) and category hubs (`/cat/<category>/`) — the
//     REAL 2026-08 crawl shape after the site became an English news edition; these are
//     headlines ("Málaga Murder Case…"), not events, however parseable they look,
//   • site chrome / legal pages (`/publishing-principles/`, `/corrections-policy/`, …),
//   • the language-edition redirect homepages (bare `https://russpain.com/`,
//     russpain.ru, español.news) and any cross-domain URL.
// Returns true when the URL is NOT a single-event listing.
function isNonEventUrl(url?: string | null): boolean {
  if (!url) return true;
  let path: string;
  let host: string;
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    path = u.pathname.toLowerCase();
  } catch {
    // relative or malformed — fall back to raw string checks
    host = "";
    path = url.toLowerCase();
  }

  // Language-edition redirect homepages / cross-domain (russpain.ru, español.news, …)
  // are not Valencia listings.
  if (host && !host.includes("russpain.com")) return true;

  // Normalise trailing slash for segment math.
  const clean = path.replace(/\/+$/, "");

  // A real listing has a slug segment AFTER /afisha/valencia/ — that is the ONLY
  // accepted shape. The index itself (`/afisha/valencia`) and every other path
  // (`/news/…`, `/cat/…`, chrome/legal, bare homepage) are non-events.
  return !/^\/afisha\/valencia\/.+/.test(clean);
}

// PURE: turn pending russpain raw rows into event drafts (date/venue/address/price
// extracted where derivable). Drops the page_snapshot (no single event identity),
// every non-`/afisha/valencia/<slug>` URL (news articles, category hubs, chrome —
// isNonEventUrl default-deny), junk cards by text/shape (shared isJunkCard), and any
// card WITHOUT a parseable date (T140: never fabricate). Prefers a date in the URL
// slug (defensive — worldafisha-style), else free-text RU/ES parsing. DB-free so it
// unit-tests without a connection.
export function buildRusspainEvents(
  rows: RawItem[],
  today: Date = new Date(),
): Array<{ draft: EventInsert; sourceItemId: number }> {
  const out: Array<{ draft: EventInsert; sourceItemId: number }> = [];
  for (const item of rows) {
    const raw = parseRaw(item);
    // The full-page snapshot is the index/404 page, not an event — skip it.
    if (raw.kind === "page_snapshot") continue;

    const title = compact(item.title);
    if (!title) continue;

    // Drop chrome / index / cross-edition redirect URLs.
    if (isNonEventUrl(item.url)) continue;

    // T146 shared guard: drop nav / contact / legal / chrome cards by text/shape
    // (email, "Publishing Principles", bare site-name header, "Continue to RUSSPAIN.COM").
    if (isJunkCard(title, item.raw_text, RUSSPAIN_NAME)) continue;

    const haystack = `${title} ${item.raw_text || ""}`;
    // Prefer a date encoded in the URL slug (worldafisha-style), else free RU/ES text.
    // T209: year inference anchored to the row's scrape date (postDateOf → first_seen),
    // not normalize-time "now" (the T207 mechanics) — dormant while the default-deny
    // URL guard emits zero events, correct if the real afisha ever returns.
    const start = dateFromUrl(item.url) ?? parseEventDate(haystack, postDateOf(item) ?? today);
    // T140/T154: no parseable date → do NOT emit (never fabricate; an undated card on
    // a news-reorganised site is noise, and null-dated rows can't ship in the seed).
    if (!start) continue;
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
        source: RUSSPAIN_SOURCE_KEY,
        source_url: item.url ?? SOURCE_URL,
        raw_excerpt: compact(item.raw_text)?.slice(0, 1000) ?? null,
      },
    });
  }
  return out;
}

// Normalizer for russpain. Reads pending raw rows, builds event drafts, upserts each
// idempotently (shared `upsertPlainEvent`, ON CONFLICT(dedup_hash)), then marks EVERY
// raw row normalized — including dropped ones (append-only — constitution I). `exec`
// is injectable for tests.
export async function normalizeRusspain(
  { exec = sql }: { exec?: typeof sql } = {},
): Promise<{ created: number; updated: number; processed: number }> {
  const rows = (await exec`
    SELECT * FROM source_items
    WHERE source_key = ${RUSSPAIN_SOURCE_KEY}
      AND (normalized_status IS NULL OR normalized_status = 'pending'
           OR normalized_at IS NULL OR normalized_at < last_seen)
  `) as unknown as RawItem[];

  const drafts = buildRusspainEvents(rows);
  const ts = nowIso();
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

  // Mark every processed raw row normalized (append-only): dropped rows included.
  for (const item of rows) {
    await exec`UPDATE source_items
      SET normalized_at = ${ts}, normalized_status = 'normalized'
      WHERE id = ${item.id}`;
  }

  return { created, updated, processed: rows.length };
}
