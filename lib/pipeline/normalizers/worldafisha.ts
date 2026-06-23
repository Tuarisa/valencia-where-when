import { sql } from "../../db";
import { compact, nowIso } from "../util";
import { isSpainEvent, hasNonSpainSignal } from "./spain-filter";
import {
  parseEventDate,
  dateFromUrl,
  deriveCityFor,
  upsertPlainEvent,
  type EventInsert,
} from "./shared";
import type { RawItem } from "./types";

// Re-export the shared helpers worldafisha used to own, so existing importers of
// `parseEventDate` / `dateFromUrl` / `deriveCityFor` / `urlSlug` / `EventInsert` /
// `upsertPlainEvent` "from ./worldafisha" keep resolving even though the canonical home
// is now `./shared` (T183 F1 — worldafisha is just another consumer now). Prefer
// importing these from `./shared` directly in new code.
export {
  parseEventDate,
  dateFromUrl,
  urlSlug,
  deriveCityFor,
  upsertPlainEvent,
  type EventInsert,
} from "./shared";

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
    // T172: derive the real city from title/text/URL slug instead of hard-coding
    // "Valencia" — many worldafisha listings are Alicante/Barcelona tours.
    const city = deriveCityFor(title, item.raw_text, item.url);
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
        city,
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
