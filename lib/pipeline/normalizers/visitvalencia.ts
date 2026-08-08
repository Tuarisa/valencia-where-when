import { sql } from "../../db";
import { compact } from "../util";
import { normTitle, parseEventDate, runPlainNormalizer, type EventInsert } from "./shared";
import { isJunkCard } from "./valenciarusa";
import type { RawItem } from "./types";

// T112-family — visitvalencia.com (official tourist board, web source, key
// `web:visitvalencia`, id 13, EN). The generic web parser stores each agenda listing
// as a `link_card` row whose `title` (== `raw_text`) is the listing headline, plus a
// full `page_snapshot` row per ingest run.
//
// T154 REAL-DATA FINDING — the dates DO exist, in TWO places the first cut missed:
//
// 1. The page_snapshot `raw_text` carries a `DD/MM/YYYY` range right under almost
//    every listing title, in three real markups (all seen live):
//      a. inline  (pre-Aug-2026 main listing):   "Title\n From 02/07/2026 to 05/07/2026"
//      b. split   (pre-Aug-2026 highlights):     "Title\n From \n 08/07/2026\n to 08/07/2026"
//      c. compact (Aug-2026 redesign highlights):"Title\n 23/06/2026 - 08/08/2026"
//    plus the occasional bare "02/07/2026" single-date line under a title.
//    We line-scan the snapshot, pair each range with the nearest preceding title line,
//    and key the map by normalized title — link_card titles match the snapshot titles.
//
// 2. Since the Aug-2026 redesign the highlight link_cards GLUE the range into the
//    anchor text itself: title == raw_text == "Summer Amusement Park in Valencia 2026
//    23/06/2026 - 08/08/2026". That both dirtied the stored title AND misled
//    parseEventDate ("…you can see in August 27/07/2026 - 31/08/2026" parsed as
//    month-first "August 27" instead of the real 27/07). We strip the trailing range
//    off the title and use it as the highest-confidence date.
//
// CAUTION (verified live): the snapshot's `raw_json.event_links` pairs are OFF-BY-ONE
// for this source (each title carries the NEXT card's URL), so event_links must NOT be
// used to key dates by URL — title-text matching only.
//
// Cards with no range anywhere legitimately stay start_date=null (evergreen
// exhibitions / ongoing experiences; a wrong pin is worse than none — we never
// fabricate). parseEventDate on the card text remains the last-resort fallback for
// the rare "16 December"-style headline date.
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
//
// T206 REAL-DATA FINDING — two more lies hid INSIDE `/events-valencia/<slug>`:
//
// 1. GUIDE/LISTICLE ARTICLES live on the events listing with event-shaped URLs
//    ("Best places to enjoy flamenco in Valencia", "The Best Spas in Valencia to
//    Disconnect and Recharge", "Must-see immersive exhibitions this spring in
//    Valencia", "Where to Watch the FIFA World Cup in Valencia", "Three ways to
//    enjoy live jazz in Valencia", "Exhibitions in València: everything you can see
//    in August" — all live rows). They are roundup ARTICLES, not events (two of the
//    T202 residual false contain-merges bridged through them). We classify them by
//    deterministic title/slug shapes and DROP them (not routed to places — kept a
//    small diff on purpose). An article stays an article even when the site dates it
//    (the monthly "everything you can see in …" roundups carry real ranges).
//
// 2. Evergreen experiences carry the site's FULL-YEAR placeholder "From 01/01/YYYY
//    to 31/12/YYYY" (12 live drafts: guided tours, permanent exhibitions, tourist
//    buses…). That is the CMS way of saying "open all year", not a start date.
//    Claiming start=Jan-1 lies everywhere downstream: score.ts reads a long-past
//    start (−40) plus ≥120-day duration (−26, and −12 more for this source), the
//    calendar draws a year-long exposition bar (isExposition), and rebake-seed would
//    bake the lie into prod. The feed keeps null-dated rows (unknown ≠ past) and the
//    seed bake excludes them — exactly how this normalizer's other evergreen cards
//    already behave. So the least-lying representation is NO date: a same-year
//    01/01→31/12 range is treated as "no published date" (нет даты → не эмитим её);
//    the event itself is still emitted. start=today would fabricate — forbidden.

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

// ---------------------------------------------------------------------------
// T206: guide/listicle classification (deterministic — title + slug shapes)
// ---------------------------------------------------------------------------

// Title shapes of the guide/listicle ARTICLES observed live (matched against the
// normTitle-folded headline, so punctuation/accents/hyphens are already spaces):
//   ^best / ^the best        "Best places to enjoy flamenco…", "The Best Spas…"
//   ^must see                "Must-see immersive exhibitions this spring…"
//   ^where to                "Where to Watch the FIFA World Cup…"
//   ^top N                   future-proof listicle shape (none live yet)
//   places to / ways to      "…places to enjoy…", "Three ways to enjoy live jazz…"
//   everything you can see   "Exhibitions in València: everything you can see in August"
//   guide(s) as its own word "…guide" per T206 (never matches "guided tours" — real
//                            experiences like "Guided tours of San Juan del Hospital")
// Deliberately NOT matched (real rows kept as events): mid-title "best" ("The
// Champions Burger: Taste the best burgers…" is a real food festival, "Discover the
// San José Caves, the best-kept underground secret…" a real excursion, "Enjoy the
// best live flamenco!" plausibly a real show), and dated fair programmes ("Stand-up
// comedy and comedy nights at the July Fair…" — venue+date pair, not a listicle).
const GUIDE_TITLE_RE =
  /^(?:the )?best\b|^must see\b|^where to\b|^top \d+\b|\bplaces to\b|\bways to\b|\beverything you can (?:see|do)\b|\bguides?\b/;

// The slug mirrors the title but ELIDES stopwords ("where-watch-fifa-world-cup…",
// "three-ways-enjoy-live-jazz…"), so its anchors are looser. Belt-and-braces: catches
// a retitled card whose slug stays guide-shaped.
const GUIDE_SLUG_RE =
  /^(?:the )?best\b|^must see\b|^where\b|^top \d+\b|\bways\b|\beverything you can (?:see|do)\b|\bguides?\b/;

// PURE (T206): is this card a guide/listicle ARTICLE rather than an event? Checked on
// the CLEAN title (glued range already peeled) and on the `/events-valencia/<slug>`
// slug. Conservative on purpose: a false drop loses a real event, a false keep only
// re-admits an article — so only the shapes proven on live rows match.
export function isVisitvalenciaGuideCard(title: string, url?: string | null): boolean {
  if (GUIDE_TITLE_RE.test(normTitle(title))) return true;
  if (!url) return false;
  const m = /\/events-valencia\/([^/?#]+)/.exec(url.split(/[?#]/)[0]);
  if (!m) return false;
  const slug = normTitle(decodeURIComponent(m[1]));
  return slug ? GUIDE_SLUG_RE.test(slug) : false;
}

// ---------------------------------------------------------------------------
// T154: date extraction (deterministic — the source publishes DD/MM/YYYY ranges)
// ---------------------------------------------------------------------------

export interface VvDateRange {
  start: string; // ISO YYYY-MM-DD
  end: string | null; // null when single-day / absent
}

// One strictly-numeric visitvalencia date: DD/MM/YYYY (zero-padded on the live site).
const DMY = String.raw`(\d{2})/(\d{2})/(\d{4})`;

// PURE: "23/06/2026" → "2026-06-23"; null on an implausible day/month (fail-soft —
// better no date than a wrong one).
export function dmyToIso(d: string, m: string, y: string): string | null {
  const day = Number(d);
  const month = Number(m);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  return `${y}-${m}-${d}`;
}

// PURE (T206): the site's evergreen placeholder — 01/01 → 31/12 of the SAME year
// ("From 01/01/2026 to 31/12/2026", verbatim in live snapshots for guided tours /
// permanent exhibitions / tourist buses). It means "open all year", not a start date.
export function isFullYearPlaceholder(start: string, end: string): boolean {
  return (
    start.slice(4) === "-01-01" &&
    end.slice(4) === "-12-31" &&
    start.slice(0, 4) === end.slice(0, 4)
  );
}

// PURE: normalize a (start, end) pair; end collapses to null when it equals start
// (single-day) or precedes it (the aggregator lied — keep only the start). A same-year
// full-year placeholder yields NO range at all (T206 — see the file header: null dates
// are the least-lying representation for "open all year"; we never claim start=Jan-1).
function makeRange(start: string | null, end: string | null): VvDateRange | null {
  if (!start) return null;
  if (end && isFullYearPlaceholder(start, end)) return null;
  if (!end || end <= start) return { start, end: null };
  return { start, end };
}

// Aug-2026 redesign: highlight cards glue the range into the anchor text —
// "Summer Amusement Park in Valencia 2026 23/06/2026 - 08/08/2026". Trailing-anchored.
const TRAILING_RANGE = new RegExp(String.raw`\s*${DMY}\s*[-–]\s*${DMY}\s*$`);

// PURE: split a card headline into the clean title + the glued trailing range (if
// any). The range, when present, is the event's own published dates — highest
// confidence. Real rows: source_items 2311–2316 (live, 2026-08-07 ingest).
export function stripTrailingCardRange(title: string): { title: string; range: VvDateRange | null } {
  const m = TRAILING_RANGE.exec(title);
  if (!m) return { title, range: null };
  const start = dmyToIso(m[1], m[2], m[3]);
  // Implausible start → the tail is garbage numbers: leave the title untouched.
  if (!start) return { title, range: null };
  const end = dmyToIso(m[4], m[5], m[6]);
  // A plausible tail is ALWAYS peeled off the title — it is display noise either way;
  // makeRange decides whether it is also a usable date (a full-year placeholder tail
  // cleans the title but yields NO range, T206).
  return { title: title.slice(0, m.index).trim() || title, range: makeRange(start, end) };
}

// Snapshot line forms (anchored to the WHOLE trimmed line so stray numbers in prose
// never match). See the file header for the three real markups.
const LINE_INLINE = new RegExp(String.raw`^From\s+${DMY}\s+to\s+${DMY}$`); // a
const LINE_FROM = /^From$/; // b (split across 3 lines)
const LINE_BARE = new RegExp(String.raw`^${DMY}$`); // b's middle line; also the rare bare single date
const LINE_TO = new RegExp(String.raw`^to\s+${DMY}$`); // b's last line
const LINE_COMPACT = new RegExp(String.raw`^${DMY}\s*[-–]\s*${DMY}$`); // c

// Lines that are page chrome / filter-widget labels / per-block category tags — never
// an event title. Lowercased, compared against the trimmed line. All observed live.
const SNAPSHOT_CHROME = new Set([
  "music", "exhibitions", "gastronomy", "show", "sport", "nature", "with children",
  "shopping", "parties and traditions", "urban festival", "health & wellness",
  "christmas", "fallas", "- any -", "monthly highlights", "date", "search",
  "start date", "end date", "category", "system messages", "close popup",
  "the best events", "plans in valencia", "back", "activities",
]);

// PURE: can this trimmed snapshot line be an event title? (non-empty, has a letter,
// not chrome, not itself a date/From/to line)
function isTitleLine(line: string): boolean {
  if (!line || !/[a-zA-Zà-ÿÀ-Ÿ]/.test(line)) return false;
  if (SNAPSHOT_CHROME.has(line.toLowerCase())) return false;
  if (LINE_FROM.test(line) || LINE_BARE.test(line) || LINE_TO.test(line)) return false;
  if (LINE_INLINE.test(line) || LINE_COMPACT.test(line)) return false;
  return true;
}

// How far back (in non-empty lines) a range may look for its title. Real markups put
// the title 1 line above the range (2 with an interleaved category tag).
const TITLE_LOOKBACK = 4;

// PURE: line-scan ONE snapshot's raw_text into normalized-title → date-range entries,
// merged into `out` (later calls override — pass snapshots oldest→newest so the
// freshest capture wins per title). Handles all three real markups + the bare
// single-date line. A range with no plausible title within reach is dropped
// (fail-soft: no date is better than somebody else's date).
export function scanSnapshotDates(rawText: string, out: Map<string, VvDateRange>): void {
  const lines = rawText.split("\n").map((l) => l.trim());
  const consumed = new Set<number>(); // lines eaten by the split "From/date/to date" form

  const titleBefore = (i: number): string | null => {
    let seen = 0;
    for (let j = i - 1; j >= 0 && seen < TITLE_LOOKBACK; j--) {
      const l = lines[j];
      if (!l) continue;
      seen++;
      if (isTitleLine(l)) return l;
    }
    return null;
  };

  const record = (anchor: number, range: VvDateRange | null) => {
    if (!range) return;
    const title = titleBefore(anchor);
    if (!title) return;
    const key = normTitle(title);
    if (key) out.set(key, range);
  };

  for (let i = 0; i < lines.length; i++) {
    if (consumed.has(i)) continue;
    const line = lines[i];
    if (!line) continue;

    let m = LINE_INLINE.exec(line) || LINE_COMPACT.exec(line);
    if (m) {
      record(i, makeRange(dmyToIso(m[1], m[2], m[3]), dmyToIso(m[4], m[5], m[6])));
      continue;
    }

    if (LINE_FROM.test(line)) {
      // split form: "From" / "DD/MM/YYYY" / "to DD/MM/YYYY" on the next non-empty lines
      let j = i + 1;
      while (j < lines.length && !lines[j]) j++;
      const md = j < lines.length ? LINE_BARE.exec(lines[j]) : null;
      if (!md) continue;
      let k = j + 1;
      while (k < lines.length && !lines[k]) k++;
      const mt = k < lines.length ? LINE_TO.exec(lines[k]) : null;
      if (!mt) continue;
      consumed.add(j).add(k);
      record(i, makeRange(dmyToIso(md[1], md[2], md[3]), dmyToIso(mt[1], mt[2], mt[3])));
      continue;
    }

    m = LINE_BARE.exec(line);
    if (m) {
      // rare: a bare single date directly under a title (seen live, 2026-07-02 capture)
      record(i, makeRange(dmyToIso(m[1], m[2], m[3]), null));
    }
  }
}

// PURE: collect the title→range map from EVERY page_snapshot in the batch, oldest→
// newest so the freshest capture wins per title. We deliberately read ALL snapshots
// (not just the newest): the Aug-2026 redesign dates ONLY the six highlights, while
// the older captures date the whole listing — an event absent from the newest
// snapshot keeps its last published range (a real published date, never fabricated).
export function extractVisitvalenciaDates(rows: RawItem[]): Map<string, VvDateRange> {
  const out = new Map<string, VvDateRange>();
  const snaps = rows
    .filter((r) => parseRaw(r).kind === "page_snapshot" && r.raw_text)
    .sort((a, b) => a.id - b.id);
  for (const s of snaps) scanSnapshotDates(s.raw_text as string, out);
  return out;
}

// PURE: look a card title up in the snapshot map. Exact normalized equality first;
// then the conservative containment rule (one normalized title fully contains the
// other, shorter ≥ 8 chars and ≥ 60% of the longer — mirrors shared matchEventLink
// tier 2). No fuzzier tiers: a wrong date is worse than none.
export function lookupSnapshotRange(
  title: string,
  map: Map<string, VvDateRange>,
): VvDateRange | null {
  const want = normTitle(title);
  if (!want) return null;
  const exact = map.get(want);
  if (exact) return exact;
  let best: { range: VvDateRange; score: number } | null = null;
  for (const [cand, range] of map) {
    const [shortS, longS] = want.length <= cand.length ? [want, cand] : [cand, want];
    if (longS.includes(shortS) && shortS.length >= 8 && shortS.length / longS.length >= 0.6) {
      const score = shortS.length / longS.length;
      if (!best || score > best.score) best = { range, score };
    }
  }
  return best ? best.range : null;
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
// `/events-valencia/<slug>` detail cards; site nav, `/shop/…` products, guides and
// the category indices are dropped (isVisitvalenciaEventUrl + isJunkCard), and
// guide/listicle ARTICLES with event-shaped URLs drop too (isVisitvalenciaGuideCard,
// T206 — even when dated: an article is not an event). The page_snapshot rows are
// not emitted as events but ARE mined for the published DD/MM/YYYY ranges (T154 —
// see the file header); dates resolve in confidence order: (1) the range glued into
// the card's own text (Aug-2026 markup), (2) the snapshot listing's range for the
// same title, (3) parseEventDate on the clean text. No hit → null, never fabricated;
// the same-year 01/01→31/12 placeholder counts as no hit (T206). DB-free so it
// unit-tests without a connection.
export function buildVisitvalenciaEvents(
  rows: RawItem[],
  today: Date = new Date(),
): Array<{ draft: EventInsert; sourceItemId: number }> {
  const out: Array<{ draft: EventInsert; sourceItemId: number }> = [];
  // T154: mine every snapshot in the batch for title → published date-range.
  const snapshotDates = extractVisitvalenciaDates(rows);
  for (const item of rows) {
    const raw = parseRaw(item);
    // The full-page snapshot is the index, not an event — mined above, not emitted.
    if (raw.kind === "page_snapshot") continue;
    // Keep ONLY real per-event detail URLs; nav / shop / guide / category cards drop.
    if (!isVisitvalenciaEventUrl(item.url)) continue;

    const rawTitle = compact(item.title);
    if (!rawTitle) continue;

    // T154: peel the Aug-2026 glued "DD/MM/YYYY - DD/MM/YYYY" tail off the headline.
    const { title, range: cardRange } = stripTrailingCardRange(rawTitle);

    // T146: drop any residual chrome / bare header line (defensive — the URL gate
    // already removes nav, but a header card that slipped through with an event-ish
    // URL is still caught here). A real listing headline is never matched.
    if (isJunkCard(title, item.raw_text, VISITVALENCIA_NAME)) continue;

    // T206: guide/listicle ARTICLES wear event URLs on this listing — drop them
    // (checked on the CLEAN title so a glued date range can't disguise a roundup).
    if (isVisitvalenciaGuideCard(title, item.url)) continue;

    // Card text with the glued range peeled too (raw_text == title on live rows).
    const text = stripTrailingCardRange(compact(item.raw_text) ?? "").title || null;

    // Confidence order: own glued range → snapshot listing range → free-text parse.
    const range =
      cardRange ?? lookupSnapshotRange(title, snapshotDates) ?? null;
    const start = range?.start ?? parseEventDate(`${title} ${text || ""}`, today);
    const category = classifyVisitvalencia(`${title} ${item.url || ""}`);

    out.push({
      sourceItemId: item.id,
      draft: {
        title: title.slice(0, 300),
        description: text?.slice(0, 2000) ?? null,
        category,
        language: "en",
        audience: "all",
        start_date: start,
        end_date: range?.end ?? null,
        city: "Valencia",
        country: "Spain",
        url: item.url ?? SOURCE_URL,
        image_url: raw.meta?.["og:image"] || null,
        source: VISITVALENCIA_SOURCE_KEY,
        source_url: item.url ?? SOURCE_URL,
        raw_excerpt: text?.slice(0, 1000) ?? null,
      },
    });
  }
  return out;
}

// Normalizer for visitvalencia. Reads pending raw rows, builds event drafts, upserts
// each idempotently (shared `upsertPlainEvent` → ON CONFLICT(dedup_hash) preserves
// downstream enrichment/scoring/notify state), then marks EVERY processed raw row
// normalized append-only — including dropped nav/chrome rows (never deletes raw rows,
// constitution I). Delegates the canonical orchestration to `runPlainNormalizer`
// (T183 F2). `exec` is injectable for tests.
export async function normalizeVisitvalencia(
  { exec = sql }: { exec?: typeof sql } = {},
): Promise<{ created: number; updated: number; processed: number }> {
  return runPlainNormalizer({
    sourceKey: VISITVALENCIA_SOURCE_KEY,
    build: buildVisitvalenciaEvents,
    exec,
  });
}
