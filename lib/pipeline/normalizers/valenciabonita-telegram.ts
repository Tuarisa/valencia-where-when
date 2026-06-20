import { sql } from "../../db";
import { compact, nowIso } from "../util";
import { parseEventDate, upsertPlainEvent, type EventInsert } from "./worldafisha";
import { parsePrice, parseVenue, parseAddress } from "./valenciarusa";
import { postTitle, looksLikeEvent } from "./vidacultural";
import type { RawItem } from "./types";

// FR-001 (multi-source ingestion) — Valencia Bonita (telegram source, key
// `tg:valenciabonitatelegram`, id 3). A Valencia-local culture/events channel posting
// city festivals, fiestas and weekend plans in Spanish (with some Russian). Raw rows
// arrive from the generic telegram parser (`raw_json.kind === "telegram_post"`, carrying
// `media_urls` + `post_ref`); the post body is in `raw_text`, the first line is the
// title. We parse date / venue / address / price from the body and emit ONE event per
// post. Already Valencia-local + curated, so — like vidacultural — NO Spain pre-filter
// (every post is about València). Channel-specific tweaks vs. vidacultural: it's
// ES-primary (so language is detected ru/es per post, defaulting to es) and the category
// is derived from content keywords (festival/fiesta/concert/…) defaulting to `event`.
// Fail-soft: obvious non-event chatter (no date AND no venue cue) is skipped; never
// throws (constitution: pipeline is fail-soft + append-only).

export const VALENCIABONITA_TG_SOURCE_KEY = "tg:valenciabonitatelegram";
const SOURCE_URL = "https://t.me/s/valenciabonitatelegram";

interface RawTelegram {
  kind?: string;
  post_ref?: string;
  media_urls?: string[];
}

function parseRaw(item: RawItem): RawTelegram {
  try {
    const r = JSON.parse(item.raw_json || "{}");
    return r && typeof r === "object" ? r : {};
  } catch {
    return {};
  }
}

// PURE: detect the post language. ES-primary channel, so default "es"; flip to "ru"
// only when the body is clearly Cyrillic-dominant (a handful of stray Cyrillic chars in
// an otherwise Spanish post should not retag it).
export function detectLang(text?: string | null): "ru" | "es" {
  const t = compact(text);
  if (!t) return "es";
  const cyr = (t.match(/[Ѐ-ӿ]/g) || []).length;
  const lat = (t.match(/[A-Za-zÀ-ÿ]/g) || []).length;
  return cyr > lat ? "ru" : "es";
}

// PURE: derive a category from content keywords (RU/ES). Best-effort keyword match,
// defaulting to the generic `event` when nothing specific is recognised. Ordered so the
// most specific cue wins.
const CATEGORY_CUES: Array<[RegExp, string]> = [
  [/fiesta|fallas|feria|verbena|festiv|праздник|фестивал|фиест|фалья/i, "festival"],
  [/concierto|concert|m[úu]sica|recital|концерт|музык/i, "concert"],
  [/exposici[óo]n|exhibici[óo]n|muestra|exhibit|выставк|экспозиц/i, "exhibition"],
  [/teatro|theatre|theater|danza|ballet|[óo]pera|театр|танец|балет|опер/i, "theatre"],
  [/cine|pel[íi]cula|film|кино|фильм/i, "film"],
  [/mercad|market|feria gastron|ярмарк|базар/i, "market"],
  [/taller|workshop|curso|infantil|ni[ñn]os|family|familia|мастер-класс|дет/i, "family"],
];

export function deriveCategory(text?: string | null): string {
  const t = compact(text);
  if (t) {
    for (const [re, cat] of CATEGORY_CUES) {
      if (re.test(t)) return cat;
    }
  }
  return "event";
}

// PURE: turn pending Valencia Bonita raw rows into event drafts. DB-free so it
// unit-tests without a connection. Mirrors buildVidaculturalEvents' telegram field
// access; channel tweaks = ES-primary language detection + derived category.
export function buildValenciabonitaTgEvents(
  rows: RawItem[],
  today: Date = new Date(),
): Array<{ draft: EventInsert; sourceItemId: number }> {
  const out: Array<{ draft: EventInsert; sourceItemId: number }> = [];
  for (const item of rows) {
    const raw = parseRaw(item);
    const body = item.raw_text || "";
    const start = parseEventDate(body, today);
    if (!looksLikeEvent(body, start != null)) continue;

    const title = postTitle(body, item.title);
    if (!title) continue;

    const { price, isFree } = parsePrice(body);
    const venue = parseVenue(body);
    const address = parseAddress(body);
    const image = Array.isArray(raw.media_urls) && raw.media_urls.length ? raw.media_urls[0] : null;

    out.push({
      sourceItemId: item.id,
      draft: {
        title: title.slice(0, 300),
        description: compact(body)?.slice(0, 2000) ?? null,
        category: deriveCategory(`${title} ${body}`),
        language: detectLang(body),
        start_date: start,
        venue_name: venue,
        address,
        city: "Valencia",
        country: "Spain",
        price,
        is_free: isFree,
        url: item.url ?? SOURCE_URL,
        image_url: image,
        source: VALENCIABONITA_TG_SOURCE_KEY,
        source_url: item.url ?? SOURCE_URL,
        raw_excerpt: compact(body)?.slice(0, 1000) ?? null,
      },
    });
  }
  return out;
}

// Normalizer for Valencia Bonita (telegram). Reads pending raw rows, builds event
// drafts, upserts each idempotently (shared `upsertPlainEvent`), then marks EVERY
// processed raw row normalized — kept OR chatter-dropped — because the raw layer is
// append-only (constitution I) and a dropped post must not stay pending forever.
// `exec` is injectable for tests. Mirrors normalizeVidacultural's DB/marking mechanics.
export async function normalizeValenciabonitaTg(
  { exec = sql }: { exec?: typeof sql } = {},
): Promise<{ created: number; updated: number; processed: number }> {
  const rows = (await exec`
    SELECT * FROM source_items
    WHERE source_key = ${VALENCIABONITA_TG_SOURCE_KEY}
      AND (normalized_status IS NULL OR normalized_status = 'pending'
           OR normalized_at IS NULL OR normalized_at < last_seen)
  `) as unknown as RawItem[];

  const drafts = buildValenciabonitaTgEvents(rows);
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
