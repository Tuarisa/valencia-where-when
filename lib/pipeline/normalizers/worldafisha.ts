import { sql } from "../../db";
import { compact, eventHash, nowIso } from "../util";
import { isSpainEvent, hasNonSpainSignal } from "./spain-filter";
import type { RawItem } from "./types";

// T110 — worldafisha.com (web source, key `web:worldafisha`, id 9). This is the
// "Зарубежная афиша" RU artist-tours feed — the SAME catalogue as tg:concerten
// (T136), but worldafisha lists tours across ALL of Europe, so we MUST pre-filter to
// Spain (T131 spain-filter) or the feed overloads with Berlin/Paris/Lisbon dates a
// Valencia family can't attend. Raw rows arrive from the generic web parser as
// `link_card` (per-listing anchor) or `page_snapshot` (the listing page itself); we
// parse artist / show / date / city out of the title+text and emit ONE event per
// item. Fail-soft: an unparseable row is skipped, never throws (constitution:
// pipeline is fail-soft + append-only).

export const WORLDAFISHA_SOURCE_KEY = "web:worldafisha";
const SOURCE_URL = "https://worldafisha.com/events/ispaniya";

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

  // numeric DD.MM.YYYY / DD/MM/YYYY / DD-MM-YYYY (also DD.MM / DD-MM with no year)
  const num = /\b(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?\b/.exec(t);
  if (num) {
    const day = Number(num[1]);
    const month = Number(num[2]);
    let year = num[3] ? Number(num[3]) : 0;
    if (year && year < 100) year += 2000;
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      if (!year) year = inferYear(month, day, today);
      return `${year}-${pad(month)}-${pad(day)}`;
    }
  }

  // Collect day-first and month-first named candidates, then return whichever
  // appears FIRST in the text (so "первый plausible date" holds across forms).
  let best: { index: number; iso: string } | null = null;
  const consider = (index: number, month: number, day: number, year4?: string) => {
    if (!month || day < 1 || day > 31) return;
    const year = year4 ? Number(year4) : inferYear(month, day, today);
    const candidate = { index, iso: `${year}-${pad(month)}-${pad(day)}` };
    if (!best || candidate.index < best.index) best = candidate;
  };

  // day-first: "<day> <monthName> [<year>]" (RU/UK/ES, optional "de")
  const dayFirst =
    /\b(\d{1,2})\s+(?:de\s+)?([A-Za-zА-Яа-яёЁЇїІіЄєҐґ]{3,})\.?(?:\s+(?:de\s+)?(\d{4}))?/u;
  const dm = dayFirst.exec(t);
  if (dm) consider(dm.index, monthFromWord(dm[2]), Number(dm[1]), dm[3]);

  // month-first: "<monthName> <day> [<year>]" — real RU posts use uppercase
  // abbreviations ("МАР 18", "ДЕК 11"). The month word leads, the day follows.
  // NOTE: no leading `\b` — in a `u`-flagged regex `\b` is ASCII-only and never
  // matches before a Cyrillic letter, so a leading "ДЕК"/"ЯНВ" would be skipped.
  // `(?<![\p{L}\d])` is a Unicode-aware left boundary instead.
  const monthFirst =
    /(?<![\p{L}\d])([A-Za-zА-Яа-яёЁЇїІіЄєҐґ]{3,})\.?\s+(\d{1,2})(?:[^\d]{0,12}?(\d{4}))?/u;
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

// PURE (T150): pull a trailing calendar date out of a worldafisha event URL slug.
// The site encodes the exact date at the END of the slug, e.g.
//   https://worldafisha.com/event/slava-komissarenko-valensiya-2026-06-21
//                                                            └─ 2026-06-21
// Live rows carry ONLY the title in raw_text (no date), so this slug is the single
// reliable date source for 23/23 of them. Accepts "YYYY-MM-DD" or "YYYY/MM/DD",
// anchored to the END of the path so an unrelated number mid-slug can't false-match.
// Validates month 1–12 / day 1–31; returns null when absent or implausible.
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

// PURE (T150): a worldafisha row is a real event only when its URL is an `/event/`
// listing. `/persons/<artist>` rows are artist profile pages (no single date/show);
// the `/events/ispaniya` index page is the catalogue itself. Both are dropped.
function isEventUrl(url?: string | null): boolean {
  return !!url && /\/event\//.test(url);
}

// PURE (T150): worldafisha marks a cancelled show by suffixing the title with
// "(отменен)" (RU "cancelled"). We surface it as a flag so downstream can demote
// rather than silently mislead — the event still carries its real date.
function isCancelledTitle(title?: string | null): boolean {
  return /\(отмен/iu.test(title || "");
}

// PURE: turn pending worldafisha raw rows into event drafts, Spain-filtered. The
// snapshot row (the whole listing page) is dropped — it has no single event identity;
// only the per-listing `link_card` rows (and any titled item carrying a Spain signal)
// become events. DB-free so it unit-tests without a connection.
export function buildWorldafishaEvents(
  rows: RawItem[],
  today: Date = new Date(),
): Array<{ draft: EventInsert; sourceItemId: number; cancelled: boolean }> {
  const out: Array<{ draft: EventInsert; sourceItemId: number; cancelled: boolean }> = [];
  for (const item of rows) {
    const raw = parseRaw(item);
    // The full-page snapshot is the index, not an event — skip it.
    if (raw.kind === "page_snapshot") continue;
    // T150: keep ONLY real `/event/` listings. `/persons/<artist>` profile pages
    // and the `/events/ispaniya` index are not single events → drop them.
    if (!isEventUrl(item.url)) continue;

    const title = compact(item.title);
    if (!title) continue;

    // Spain gate: the listing spans all of Europe. Keep ONLY explicit-Spain items,
    // and additionally drop anything that names a clearly non-Spain hub (a tour line
    // like "Madrid · Berlin" stays; a pure "Berlin" line is dropped).
    const haystack = `${title} ${item.raw_text || ""} ${item.url || ""}`;
    if (!isSpainEvent(haystack)) continue;
    if (hasNonSpainSignal(haystack) && !isSpainEvent(title)) {
      // signal lives only in the body and a non-Spain hub is present → too ambiguous
      // to keep without a Spain signal in the title itself.
      continue;
    }

    // T150: the slug carries the exact date (raw_text is title-only); prefer it,
    // fall back to free-text parsing only when the URL has no date.
    const start = dateFromUrl(item.url) ?? parseEventDate(haystack, today);
    const cancelled = isCancelledTitle(title);
    out.push({
      sourceItemId: item.id,
      cancelled,
      draft: {
        title: title.slice(0, 300),
        description: compact(item.raw_text)?.slice(0, 2000) ?? null,
        category: "concert",
        language: "ru",
        audience: "adult",
        start_date: start,
        city: "Valencia",
        country: "Spain",
        url: item.url ?? SOURCE_URL,
        image_url: raw.meta?.["og:image"] || null,
        source: WORLDAFISHA_SOURCE_KEY,
        source_url: item.url ?? SOURCE_URL,
        raw_excerpt: compact(item.raw_text)?.slice(0, 1000) ?? null,
      },
    });
  }
  return out;
}

// Minimal shape this normalizer writes into `events` (subset of the table columns).
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

// Normalizer for worldafisha. Reads pending raw rows, builds Spain-filtered event
// drafts, upserts each idempotently, then marks every raw row normalized (append-only:
// never deletes raw rows — constitution I). `exec` is injectable for tests.
export async function normalizeWorldafisha(
  { exec = sql }: { exec?: typeof sql } = {},
): Promise<{ created: number; updated: number; processed: number }> {
  const rows = (await exec`
    SELECT * FROM source_items
    WHERE source_key = ${WORLDAFISHA_SOURCE_KEY}
      AND (normalized_status IS NULL OR normalized_status = 'pending'
           OR normalized_at IS NULL OR normalized_at < last_seen)
  `) as unknown as RawItem[];

  const drafts = buildWorldafishaEvents(rows);
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

  for (const item of rows) {
    await exec`UPDATE source_items
      SET normalized_at = ${ts}, normalized_status = 'normalized'
      WHERE id = ${item.id}`;
  }

  return { created, updated, processed: rows.length };
}
