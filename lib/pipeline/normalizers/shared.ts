import { sql } from "../../db";
import { compact, eventHash, nowIso } from "../util";
import { deriveSpanishCity } from "./spain-filter";
import { markRawItem, type RawItem } from "./types";

// T183 (code-review F1) — neutral shared helpers for the plain-event normalizers.
// This is NOT a source normalizer: it holds the genuinely source-agnostic building
// blocks (the multi-language date parser, the URL-slug helpers, the city derivation,
// the `EventInsert` shape, and the idempotent `upsertPlainEvent`) that ≥2 sibling
// normalizers consume. Extracted out of `worldafisha.ts` so that worldafisha is just
// another consumer rather than the god-module every sibling imported from.

// ---------------------------------------------------------------------------
// Date parsing (RU / UK / ES / EN free-text → ISO)
// ---------------------------------------------------------------------------

// Month names → 1-based month. Substring-keyed so a stem matches all inflections.
// Covers RU (nominative + genitive), RU 3-letter abbreviations (any case),
// UK/Ukrainian (nominative + genitive), plus ES + EN stems. ORDER MATTERS: more
// specific stems must precede shorter ones that could prefix-match the wrong month.
// `словарь`: e.g. genitive RU "декабря" → `декаб`; UK "грудня" (Dec) → `груд`;
// UK "липня" (July!) → `лип`; UK "березня" (March) → `берез`. The RU 3-letter
// abbreviations ("МАР", "ДЕК", "ЯНВ") are handled by anchored `^abbr$`-style stems
// in `MONTH_ABBR` below (used for the MONTH-first "МАР 18" form) and also caught
// here for the day-first form because the stems start at the abbreviation.
const MONTHS: Array<[RegExp, number]> = [
  // январь/января, янв, січня/січень, enero, january/jan
  [/янв|січ|enero|january|jan/i, 1],
  // февраль/февраля, фев, лютий/лютого, febrero, february/feb
  [/фев|лют|febrero|february|feb/i, 2],
  // март/марта, мар, березень/березня, marzo, march/mar
  [/март|мар(?![тз])|берез|marzo|march|mar/i, 3],
  // апрель/апреля, апр, квітень/квітня, abril, april/apr
  [/апр|квіт|abril|april|apr/i, 4],
  // май/мая, травень/травня, mayo, may
  [/ма[йя]|трав|mayo|may/i, 5],
  // июнь/июня, июн, червень/червня, junio, june/jun
  [/июн|черв|junio|june|jun/i, 6],
  // июль/июля, июл, липень/липня (UK July!), julio, july/jul
  [/июл|лип|julio|july|jul/i, 7],
  // август/августа, авг, серпень/серпня, agosto, august/aug
  [/авг|серп|agosto|august|aug/i, 8],
  // сентябрь/сентября, сен, вересень/вересня, septiembre, september/sep
  [/сен|верес|septiembre|september|sep/i, 9],
  // октябрь/октября, окт, жовтень/жовтня, octubre, october/oct
  [/окт|жовт|octubre|october|oct/i, 10],
  // ноябрь/ноября, ноя, листопад/листопада, noviembre, november/nov
  [/ноя|листопад|noviembre|november|nov/i, 11],
  // декабрь/декабря, дек, грудень/грудня, diciembre, december/dec
  [/дек|груд|diciembre|december|dec/i, 12],
];

// Anchored RU/UK/ES/EN month stems for the MONTH-first numeric form ("МАР 18",
// "ДЕК 11"). Whole-word matched (case-insensitive) so a bare "МАР"/"мар"/"march"
// resolves but a longer word that merely starts the same isn't a false positive.
function monthFromWord(word: string): number {
  const w = word.trim();
  for (const [re, m] of MONTHS) {
    if (re.test(w)) return m;
  }
  return 0;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// Resolve a (month, day) with no explicit year to the NEXT occurrence on/after the
// reference date `today` (local-date semantics): Dec seen in June → this year;
// Jan seen in Dec → next year; same month but the day already passed → next year.
function inferYear(month: number, day: number, today: Date): number {
  const y = today.getFullYear();
  const todayMonth = today.getMonth() + 1;
  const todayDay = today.getDate();
  if (month < todayMonth || (month === todayMonth && day < todayDay)) {
    return y + 1;
  }
  return y;
}

// PURE: best-effort ISO date (YYYY-MM-DD) from free RU/UK/ES/EN text. Returns the
// FIRST plausible date found. Handles, in priority order:
//   • ISO "2026-06-21"
//   • numeric "21.06.2026" / "21/06/26" / "21-06" (DD.MM[.YYYY])
//   • MONTH-first abbreviations "МАР 18", "ДЕК 11" (RU uppercase posts)
//   • day-first named "16 декабря", "18 марта 2027", "23 липня", "10 de junio"
// YEAR INFERENCE: a 4-digit year in the text wins; otherwise the next occurrence
// on/after `today` (injectable for deterministic tests; defaults to the real now).
// Relative/fuzzy phrases ("на початку липня" = "early July") have no day → they
// fall through to null (DECISION: we do NOT guess first-of-month; an undated event
// still renders, and a wrong pin is worse than none). Returns null when nothing
// usable is present.
export function parseEventDate(text?: string | null, today: Date = new Date()): string | null {
  const t = compact(text);
  if (!t) return null;

  // ISO already present (highest confidence)
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // T171: a single explicit 4-digit year (2000–2099) anywhere in the post. When a
  // matched date phrase carries NO adjacent year (e.g. "14 червня" in a post titled
  // "ALBORAJAZZ 2026"), prefer this over the next-occurrence roll — otherwise a date a
  // few days in the past rolls a full year forward. Only used when the text contains
  // exactly ONE distinct year (ambiguous multi-year posts fall back to inference).
  const standaloneYear = (() => {
    const ys = [...t.matchAll(/(?<!\d)(20\d{2})(?!\d)/g)].map((m) => m[1]);
    const uniq = [...new Set(ys)];
    return uniq.length === 1 ? Number(uniq[0]) : 0;
  })();

  // Collect every candidate (numeric + day-first + month-first), then return whichever
  // appears FIRST in the text (so "первый plausible date" holds across forms). The
  // numeric branch participates in the SAME lowest-index competition rather than
  // short-circuiting — otherwise a stray "D-D" range mid-body (e.g. a duration like
  // "1,5-2 часа") would beat a real named-month date at the very start of the post.
  let best: { index: number; iso: string } | null = null;
  const consider = (index: number, month: number, day: number, year4?: string | number) => {
    if (!month || day < 1 || day > 31) return;
    const year = year4 ? Number(year4) : standaloneYear || inferYear(month, day, today);
    const candidate = { index, iso: `${year}-${pad(month)}-${pad(day)}` };
    if (!best || candidate.index < best.index) best = candidate;
  };

  // numeric DD.MM.YYYY / DD/MM/YYYY / DD-MM-YYYY (also DD/MM / DD-MM with no year).
  // Not preceded by a "<digit>," decimal so a duration like "1,5-2 часа" isn't read as
  // a "5-2" date. T171: the DOT separator with NO year (e.g. a rating "7.8") is too
  // easily confused with a decimal, so the dotted form REQUIRES an explicit year; the
  // slash/dash forms still parse year-less.
  const num = /(?<![\d.,])\b(\d{1,2})([.\/-])(\d{1,2})(?:[.\/-](\d{2,4}))?\b/.exec(t);
  if (num) {
    const day = Number(num[1]);
    const sep = num[2];
    const month = Number(num[3]);
    let year = num[4] ? Number(num[4]) : 0;
    if (year && year < 100) year += 2000;
    const dottedNoYear = sep === "." && !year;
    if (month >= 1 && month <= 12 && !dottedNoYear) {
      consider(num.index, month, day, year || undefined);
    }
  }

  // day-first: "<day> <monthName> [<year>]" (RU/UK/ES, optional "de")
  const dayFirst =
    /\b(\d{1,2})\s+(?:de\s+)?([A-Za-zА-Яа-яёЁЇїІіЄєҐґ]{3,})\.?(?:\s+(?:de\s+)?(\d{4}))?/u;
  const dm = dayFirst.exec(t);
  if (dm) consider(dm.index, monthFromWord(dm[2]), Number(dm[1]), dm[3]);

  // month-first: "<monthName> <day> [<year>]" — real RU posts use uppercase
  // abbreviations ("МАР 18", "ДЕК 11"). The month word leads, the day follows.
  // NOTE: no leading `\b` — in a `u`-flagged regex `\b` is ASCII-only and never
  // matches before a Cyrillic letter, so a leading "ДЕК"/"ЯНВ" would be skipped.
  // `(?<![\p{L}\d])` is a Unicode-aware left boundary instead. T171: the day group
  // is followed by `(?!\d)` so "<month> <year>" (e.g. "Julio 2026") is NOT misread as
  // day=20 by swallowing the first two digits of the 4-digit year.
  const monthFirst =
    /(?<![\p{L}\d])([A-Za-zА-Яа-яёЁЇїІіЄєҐґ]{3,})\.?\s+(\d{1,2})(?!\d)(?:[^\d]{0,12}?(\d{4}))?/u;
  const mf = monthFirst.exec(t);
  if (mf) {
    const month = monthFromWord(mf[1]);
    // guard: don't let the month-first branch swallow a "<day> <month>" hit — only
    // accept when the leading word actually resolves to a month.
    if (month) consider(mf.index, month, Number(mf[2]), mf[3]);
  }

  if (best) return (best as { index: number; iso: string }).iso;
  return null;
}

// PURE (T150): pull a trailing calendar date out of an event URL slug. Some sites
// encode the exact date at the END of the slug, e.g.
//   https://worldafisha.com/event/slava-komissarenko-valensiya-2026-06-21
//                                                            └─ 2026-06-21
// Accepts "YYYY-MM-DD" or "YYYY/MM/DD", anchored to the END of the path so an
// unrelated number mid-slug can't false-match. Validates month 1–12 / day 1–31;
// returns null when absent or implausible.
export function dateFromUrl(url?: string | null): string | null {
  if (!url) return null;
  // strip any query/hash, then match a trailing date at the end of the path.
  const path = url.split(/[?#]/)[0];
  const m = /(\d{4})[-/](\d{2})[-/](\d{2})\/?$/.exec(path);
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// ---------------------------------------------------------------------------
// City derivation
// ---------------------------------------------------------------------------

// PURE (T172): the URL PATH (host stripped) as a space-separated slug, for city
// derivation. We must drop the host because some source domains literally contain a
// city stem — e.g. `www.valenciarusa.es` carries "valenci", which would otherwise make
// EVERY listing resolve to Valencia even when the slug says `-alikante-`. Returns "" on
// a missing/invalid URL.
export function urlSlug(url?: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).pathname.replace(/[\/_-]+/g, " ");
  } catch {
    return url.replace(/^https?:\/\/[^/]+/i, "").replace(/[\/_-]+/g, " ");
  }
}

// PURE (T172): canonical city for a listing whose city lives in the title/text/URL slug
// rather than a structured field. Builds a city-haystack from title + body + URL slug
// (host stripped), then resolves the first Spanish city stem; falls back to "Valencia"
// when no other Spanish city is recognised (these feeds are Valencia-default).
export function deriveCityFor(
  title?: string | null,
  body?: string | null,
  url?: string | null,
): string {
  const hay = `${title || ""} ${body || ""} ${urlSlug(url)}`;
  return deriveSpanishCity(hay) ?? "Valencia";
}

// ---------------------------------------------------------------------------
// Event upsert
// ---------------------------------------------------------------------------

// Minimal shape a plain-event normalizer writes into `events` (subset of the table
// columns).
export interface EventInsert {
  title: string;
  description?: string | null;
  category?: string | null;
  language?: string | null;
  audience?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  start_time?: string | null;
  venue_name?: string | null;
  district?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  price?: string | null;
  is_free?: number | null;
  url?: string | null;
  venue_url?: string | null;
  image_url?: string | null;
  source?: string | null;
  source_url?: string | null;
  raw_excerpt?: string | null;
}

// Idempotent upsert of one plain event. Mirrors `upsertSeries`: ON CONFLICT(dedup_hash)
// updates only normalizer-owned fields + last_seen, never touching score / enriched_at /
// enrichment_json / title_ru / description_ru / notified (so a re-ingest preserves all
// downstream enrichment/scoring/notify state — constitution IV idempotency). Returns
// whether the row was freshly inserted.
export async function upsertPlainEvent(
  draft: EventInsert,
  sourceItemId: number,
  exec: typeof sql = sql,
): Promise<{ inserted: boolean }> {
  const ts = nowIso();
  const hash = eventHash({
    title: draft.title,
    start_date: draft.start_date,
    end_date: draft.end_date,
    venue_name: draft.venue_name,
    address: draft.address,
  });
  const rows = (await exec`
    INSERT INTO events (
      dedup_hash, title, description, category, language, audience,
      start_date, end_date, start_time, venue_name, district, address,
      city, country, price, is_free, url, venue_url, image_url,
      source, source_url, raw_excerpt, source_item_id,
      status, first_seen, last_seen
    ) VALUES (
      ${hash}, ${draft.title}, ${draft.description ?? null}, ${draft.category ?? null},
      ${draft.language ?? null}, ${draft.audience ?? null},
      ${draft.start_date ?? null}, ${draft.end_date ?? null}, ${draft.start_time ?? null},
      ${draft.venue_name ?? null}, ${draft.district ?? null}, ${draft.address ?? null},
      ${draft.city ?? "Valencia"}, ${draft.country ?? "Spain"},
      ${draft.price ?? null}, ${draft.is_free ?? null}, ${draft.url ?? null},
      ${draft.venue_url ?? null}, ${draft.image_url ?? null},
      ${draft.source ?? null}, ${draft.source_url ?? null}, ${draft.raw_excerpt ?? null},
      ${sourceItemId}, 'upcoming', ${ts}, ${ts}
    )
    ON CONFLICT (dedup_hash) DO UPDATE SET
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      category = EXCLUDED.category,
      start_date = EXCLUDED.start_date,
      end_date = EXCLUDED.end_date,
      start_time = EXCLUDED.start_time,
      venue_name = EXCLUDED.venue_name,
      district = EXCLUDED.district,
      address = EXCLUDED.address,
      price = EXCLUDED.price,
      is_free = EXCLUDED.is_free,
      url = EXCLUDED.url,
      image_url = EXCLUDED.image_url,
      source_item_id = EXCLUDED.source_item_id,
      last_seen = ${ts}
    RETURNING (xmax = 0) AS inserted
  `) as unknown as Array<{ inserted: boolean }>;
  return { inserted: rows[0]?.inserted === true };
}

// ---------------------------------------------------------------------------
// Plain-event normalizer orchestrator (T183 F2)
// ---------------------------------------------------------------------------

// PURE-shape build function: a source's normalizer turns its pending raw rows into
// `{ draft, sourceItemId }` pairs. DB-free so it unit-tests offline.
export type PlainEventBuild = (
  rows: RawItem[],
  today?: Date,
) => Array<{ draft: EventInsert; sourceItemId: number }>;

// Higher-order orchestrator shared by the plain-event normalizers whose body is the
// canonical shape: load this source's pending rows → run the source's pure `build`
// → idempotently `upsertPlainEvent` each draft (fail-soft per draft) → mark EVERY
// processed raw row normalized append-only via `markRawItem` (incl. dropped chrome,
// so the dispatcher doesn't re-offer them). Returns `{created, updated, processed}`.
// `exec` is injectable for tests. Normalizers with a bespoke orchestration detail
// (e.g. a different finalize) keep their own body rather than adopting this.
export async function runPlainNormalizer(opts: {
  sourceKey: string;
  build: PlainEventBuild;
  exec?: typeof sql;
}): Promise<{ created: number; updated: number; processed: number }> {
  const exec = opts.exec ?? sql;
  const rows = (await exec`
    SELECT * FROM source_items
    WHERE source_key = ${opts.sourceKey}
      AND (normalized_status IS NULL OR normalized_status = 'pending'
           OR normalized_at IS NULL OR normalized_at < last_seen)
  `) as unknown as RawItem[];

  const drafts = opts.build(rows);
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

  // Append-only: mark EVERY processed raw row normalized (incl. dropped chrome).
  for (const item of rows) {
    await markRawItem(item.id, "normalized", null, exec);
  }

  return { created, updated, processed: rows.length };
}
