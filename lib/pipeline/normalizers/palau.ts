import { sql } from "../../db";
import { compact } from "../util";
import { parseEventDate, runPlainNormalizer, type EventInsert } from "./shared";
import { isJunkCard } from "./valenciarusa";
import type { RawItem } from "./types";

// T1xx — palauvalencia.com (web source, key `web:palau`, id 17). The official Palau
// de la Música programme. The generic web parser stores each card as a `link_card`
// row. Most rows are category-nav chrome / institutional pages (history, directors,
// legal, season tickets) — their `url` is a category landing (ends with `#` or is a
// `/about`-style page) and the text is just a label, no date. The REAL events are the
// `/event?id=NNNN&mod=<unixts>` deep links, whose `raw_text` (== `title`) is a
// flattened TRILINGUAL card of the exact shape (observed live, 10/10 rows):
//
//   "Data: Fecha: Date: DD/MM/YYYY Hora: Time: HH:MM <title_ca> <title_es> <title_en>"
//
//   e.g. "Data: Fecha: Date: 04/07/2026 Hora: Time: 19:00 29 Festival de Jazz de
//         València LIZZ WRIGHT 29 Festival de Jazz de València LIZZ WRIGHT 29
//         Festival de Jazz de València LIZZ WRIGHT"
//
// The date is DD/MM/YYYY (NOT in the URL — the `mod=` query param is a unix epoch,
// not a calendar date), the time is HH:MM, and the show name is REPEATED three times
// (Catalan / Spanish / English; usually identical, occasionally differing by a
// connective like "y" / "i" / "and"). We deterministically (T140 — JS before LLM)
// pull the DD/MM/YYYY date and HH:MM time, strip the "Data:/Fecha:/Date:/Hora:/Time:"
// labels, and de-triplicate the trailing show name to a single clean title (taking
// the FIRST third = the Catalan/Valencian rendering, the site's primary language).
// venue defaults to the Palau (these rows carry no venue/price/image). Non-event
// rows (nav/chrome/category/institutional pages + isJunkCard) are dropped. Every raw
// row is marked normalized append-only; an unparseable draft is skipped, never
// thrown (constitution: pipeline is fail-soft + append-only).

export const PALAU_SOURCE_KEY = "web:palau";
const SOURCE_URL = "https://palauvalencia.com/programacio-i-vendes/";
const PALAU_VENUE = "Palau de la Música";
const PALAU_NAME = "Palau de la Música";

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

// PURE: a palau row is a real event ONLY when its URL is an `/event?id=` deep link.
// Everything else (the programme index, category anchors ending in `#`, and the
// institutional pages — history, directors, halls, legal, cookies, job postings) is
// nav/chrome, not a single dated event → dropped.
export function isPalauEventUrl(url?: string | null): boolean {
  return !!url && /palauvalencia\.com\/event\?id=\d+/i.test(url);
}

// The label header every event card carries before the date/time. Matched so we can
// pull the date + time and isolate the trailing (trilingual) show name.
// Captures: [1]=DD/MM/YYYY, [2]=HH:MM (time optional). Tolerant of the exact spacing
// the flattener produces ("Data: Fecha: Date: 25/06/2026 Hora: Time: 18:00 …").
const HEADER =
  /Data:\s*Fecha:\s*Date:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})(?:\s*Hora:\s*Time:\s*(\d{1,2}:\d{2}))?/i;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// PURE: parse the palau "DD/MM/YYYY" date token into ISO (YYYY-MM-DD). The site uses
// day-first European formatting. Validates day 1–31 / month 1–12; returns null when
// absent or implausible (a wrong pin is worse than none — mirrors siblings).
export function parsePalauDate(token?: string | null): string | null {
  if (!token) return null;
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(token);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

// PURE: the show name is rendered three times back-to-back (CA / ES / EN). De-triplicate
// by splitting the words into three equal chunks and taking the FIRST (Catalan/Valencian,
// the site's primary language). When the three chunks are identical we still return one.
// When the word count is not divisible by 3 (or the chunks clearly diverge) we fall back
// to the whole string — better a slightly-long title than a truncated one.
export function deTriplicate(name: string): string {
  const words = compact(name)?.split(/\s+/) ?? [];
  if (words.length < 3 || words.length % 3 !== 0) return compact(name) ?? "";
  const third = words.length / 3;
  const a = words.slice(0, third).join(" ");
  const b = words.slice(third, third * 2).join(" ");
  const c = words.slice(third * 2).join(" ");
  // The three thirds must be near-identical (CA/ES/EN of the SAME title) for us to
  // trust the split; the only legitimate divergence is a connective like y/i/and.
  // Compare alphanumerics only so "Camerata y" vs "Camerata i" still matches.
  const key = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  if (key(a) === key(b) && key(b) === key(c)) return a;
  // length-similar thirds (same word count) are still very likely the tri-language
  // repeat — take the first (CA). If they look unrelated, keep the whole string.
  if (Math.abs(a.length - b.length) <= 4 && Math.abs(b.length - c.length) <= 4) return a;
  return compact(name) ?? "";
}

// PURE: from a flattened palau event card, isolate the show TITLE by stripping the
// "Data:/Fecha:/Date: <date> Hora:/Time: <time>" header, then de-triplicating the
// trilingual remainder. Returns "" when nothing usable remains.
export function palauTitle(rawText: string): string {
  const t = compact(rawText) ?? "";
  const m = HEADER.exec(t);
  const tail = m ? t.slice(m.index + m[0].length).trim() : t;
  return deTriplicate(tail);
}

// PURE: turn pending palau raw rows into event drafts. Keeps ONLY `/event?id=` deep
// links; the programme snapshot, category anchors, and institutional/legal pages are
// dropped, as are isJunkCard chrome rows. DB-free so it unit-tests offline. `today`
// is accepted for parity with siblings (palau always carries an explicit 4-digit year,
// so it is unused by the date parser, but kept for a uniform signature).
export function buildPalauEvents(
  rows: RawItem[],
  _today: Date = new Date(),
): Array<{ draft: EventInsert; sourceItemId: number }> {
  const out: Array<{ draft: EventInsert; sourceItemId: number }> = [];
  for (const item of rows) {
    const raw = parseRaw(item);
    // The full-page snapshot is the index, not an event — skip it.
    if (raw.kind === "page_snapshot") continue;
    // Keep ONLY real `/event?id=` listings. Category anchors and institutional pages
    // are nav/chrome, not single dated events → drop them.
    if (!isPalauEventUrl(item.url)) continue;

    const rawText = compact(item.raw_text) ?? compact(item.title) ?? "";
    if (!rawText) continue;
    // Deterministic chrome guard (shared) — a real dated card is never matched.
    if (isJunkCard(item.title, item.raw_text, PALAU_NAME)) continue;

    const m = HEADER.exec(rawText);
    const start = parsePalauDate(m?.[1]) ?? parseEventDate(rawText, _today);
    const startTime = m?.[2] ?? null;
    const title = palauTitle(rawText);
    if (!title) continue;

    out.push({
      sourceItemId: item.id,
      draft: {
        title: title.slice(0, 300),
        description: rawText.slice(0, 2000),
        category: "concert",
        language: "es",
        audience: "all",
        start_date: start,
        start_time: startTime,
        venue_name: PALAU_VENUE,
        city: "Valencia",
        country: "Spain",
        url: item.url ?? SOURCE_URL,
        image_url: raw.meta?.["og:image"] || null,
        source: PALAU_SOURCE_KEY,
        source_url: item.url ?? SOURCE_URL,
        raw_excerpt: rawText.slice(0, 1000),
      },
    });
  }
  return out;
}

// Normalizer for palau. Reads pending raw rows, builds event drafts, upserts each
// idempotently (shared `upsertPlainEvent`), then marks EVERY processed raw row
// normalized append-only — including dropped nav/chrome rows (never deletes raw rows
// — constitution I). Delegates the canonical orchestration to `runPlainNormalizer`
// (T183 F2). `exec` is injectable for tests.
export async function normalizePalau(
  { exec = sql }: { exec?: typeof sql } = {},
): Promise<{ created: number; updated: number; processed: number }> {
  return runPlainNormalizer({
    sourceKey: PALAU_SOURCE_KEY,
    build: buildPalauEvents,
    exec,
  });
}
