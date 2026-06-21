import { sql } from "../../db";
import { compact, nowIso } from "../util";
import { parseEventDate, upsertPlainEvent, type EventInsert } from "./worldafisha";
import { isJunkCard } from "./valenciarusa";
import { markRawItem } from "./types";
import type { RawItem } from "./types";

// T112-family — visitvalencia.com (official tourist board, web source, key
// `web:visitvalencia`, id 13, EN). The generic web parser stores each agenda listing
// as a `link_card` row whose `title` (== `raw_text`) is JUST the listing headline —
// there is NO body, NO meta/og:image, and crucially **NO date** anywhere (verified on
// the 81 live rows: 0 cards carry a month name or a numeric date in text, and the URL
// slug is descriptive — "anselm-kiefers-exhibition-comes-valencia" — not a
// "…-YYYY-MM-DD" date slug like worldafisha). A handful of slugs/titles carry a bare
// YEAR ("Playmobil 2026", "…-2025-…"), but that is part of the event NAME, not a
// usable start_date — so we DO NOT fabricate one. These are evergreen exhibitions /
// ongoing experiences / recurring tours, so `start_date` is legitimately MOSTLY NULL
// (a wrong pin is worse than none — same convention as worldafisha/fever). On the rare
// row that DOES carry a real "16 December"-style date in text, parseEventDate still
// catches it.
//
// Real row shape (live):
//   title    = "Immersive Exhibition “The Legend of the Titanic” in Valencia"
//   raw_text = <same as title>
//   url      = "https://www.visitvalencia.com/en/events-valencia/immersive-exhibition-legend-titanic-valencia"
//   raw_json = {"kind":"link_card","source_page":"…/en/events-valencia"}
//
// The listing page also spills NON-event chrome into link_cards: site nav
// ("Skip to main content", "How to get to Valencia"), `/shop/...` product/ticket
// cards ("Hop-on hop-off bus", "VTC 24, 48 or 72 hours"), `/plan-your-trip/…`,
// `/what-to-see/…`, `/what-to-do/…` guides, and the two category indices
// `/events-valencia/music` + `/events-valencia/festivities`. We keep ONLY a real
// per-event detail URL: exactly `/en/events-valencia/<slug>` with a single slug
// segment that is not a bare category. Everything else is dropped. Every raw row is
// marked normalized append-only; an unparseable draft is skipped, never thrown
// (constitution: pipeline is fail-soft + append-only). Deterministic, no LLM (T140).

export const VISITVALENCIA_SOURCE_KEY = "web:visitvalencia";
const SOURCE_URL = "https://www.visitvalencia.com/en/events-valencia";
// Display name — used by isJunkCard to recognise bare header/chrome cards.
const VISITVALENCIA_NAME = "Visit Valencia";

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

// Bare category indices that live UNDER /events-valencia/ but are listing pages, not
// single events. Matched against the single slug segment, lowercased.
const CATEGORY_SLUGS = new Set(["music", "festivities", "festivals"]);

// PURE: is this URL a real visitvalencia EVENT detail page? True only for
// `…/en/events-valencia/<slug>` where `<slug>` is a single non-empty path segment
// (no further "/") that is not a bare category index. Anchors ("#main-content"),
// `/shop/…`, `/plan-your-trip/…`, `/what-to-see/…`, `/what-to-do/…` and the bare
// `/events-valencia` index all return false. Query/hash are stripped before matching.
export function isVisitvalenciaEventUrl(url?: string | null): boolean {
  if (!url) return false;
  const path = url.split(/[?#]/)[0];
  const m = /\/events-valencia\/([^/]+)\/?$/.exec(path);
  if (!m) return false;
  const slug = decodeURIComponent(m[1]).toLowerCase();
  if (!slug) return false;
  return !CATEGORY_SLUGS.has(slug);
}

// PURE (T140): a best-effort category from the EN title/slug keywords. Deterministic
// keyword match — no LLM. Falls back to the generic "culture" (this is a culture/
// tourism agenda), which downstream tagging can refine. Order matters: more specific
// cues win first.
export function classifyVisitvalencia(text: string): string {
  const t = text.toLowerCase();
  if (/\bconcert|music festival|jazz|guitar|band contest|symphon|opera\b/.test(t)) return "concert";
  if (/\bexhibition|museum|art center|gallery|expo\b/.test(t)) return "exhibition";
  if (/\bfestival|masclet|fallas|fireworks|gunpowder|circus\b/.test(t)) return "festival";
  if (/\bguided tour|tour\b|workshop|tasting|paella|wine|gastronom|cook/.test(t)) return "experience";
  if (/\bmatch|stadium|soccer|football|basket|racing|circuit|pilota|trophy|sailing\b/.test(t)) return "sports";
  if (/\bflamenco|show|dinner show|cirque\b/.test(t)) return "show";
  return "culture";
}

// PURE: turn pending visitvalencia raw rows into event drafts. Keeps ONLY real
// `/events-valencia/<slug>` detail cards; the page snapshot, site nav, `/shop/…`
// products, guides and the category indices are dropped (isVisitvalenciaEventUrl +
// isJunkCard). `start_date` is best-effort from text and is usually null (the source
// carries no date — see the file header). DB-free so it unit-tests without a
// connection.
export function buildVisitvalenciaEvents(
  rows: RawItem[],
  today: Date = new Date(),
): Array<{ draft: EventInsert; sourceItemId: number }> {
  const out: Array<{ draft: EventInsert; sourceItemId: number }> = [];
  for (const item of rows) {
    const raw = parseRaw(item);
    // The full-page snapshot is the index, not an event — skip it.
    if (raw.kind === "page_snapshot") continue;
    // Keep ONLY real per-event detail URLs; nav / shop / guide / category cards drop.
    if (!isVisitvalenciaEventUrl(item.url)) continue;

    const title = compact(item.title);
    if (!title) continue;

    // T146: drop any residual chrome / bare header line (defensive — the URL gate
    // already removes nav, but a header card that slipped through with an event-ish
    // URL is still caught here). A real listing headline is never matched.
    if (isJunkCard(title, item.raw_text, VISITVALENCIA_NAME)) continue;

    const haystack = `${title} ${item.raw_text || ""}`;
    // Best-effort only: the source almost never carries a parseable day/month, so this
    // is null on nearly every row (header explains why we don't fabricate a date).
    const start = parseEventDate(haystack, today);
    const category = classifyVisitvalencia(`${title} ${item.url || ""}`);

    out.push({
      sourceItemId: item.id,
      draft: {
        title: title.slice(0, 300),
        description: compact(item.raw_text)?.slice(0, 2000) ?? null,
        category,
        language: "en",
        audience: "all",
        start_date: start,
        city: "Valencia",
        country: "Spain",
        url: item.url ?? SOURCE_URL,
        image_url: raw.meta?.["og:image"] || null,
        source: VISITVALENCIA_SOURCE_KEY,
        source_url: item.url ?? SOURCE_URL,
        raw_excerpt: compact(item.raw_text)?.slice(0, 1000) ?? null,
      },
    });
  }
  return out;
}

// Normalizer for visitvalencia. Reads pending raw rows, builds event drafts, upserts
// each idempotently (shared `upsertPlainEvent` → ON CONFLICT(dedup_hash) preserves
// downstream enrichment/scoring/notify state), then marks EVERY processed raw row
// normalized append-only — including dropped nav/chrome rows (never deletes raw rows,
// constitution I). `exec` is injectable for tests.
export async function normalizeVisitvalencia(
  { exec = sql }: { exec?: typeof sql } = {},
): Promise<{ created: number; updated: number; processed: number }> {
  const rows = (await exec`
    SELECT * FROM source_items
    WHERE source_key = ${VISITVALENCIA_SOURCE_KEY}
      AND (normalized_status IS NULL OR normalized_status = 'pending'
           OR normalized_at IS NULL OR normalized_at < last_seen)
  `) as unknown as RawItem[];

  const drafts = buildVisitvalenciaEvents(rows);
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

  // Append-only: mark every raw row we saw normalized (incl. dropped nav/chrome).
  for (const item of rows) {
    await markRawItem(item.id, "normalized", null, exec);
  }

  return { created, updated, processed: rows.length };
}
