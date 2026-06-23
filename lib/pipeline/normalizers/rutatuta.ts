import { sql } from "../../db";
import { compact, nowIso } from "../util";
import { parseEventDate, upsertPlainEvent, type EventInsert } from "./shared";
import { parsePrice, parseVenue, parseAddress, isJunkCard } from "./valenciarusa";
import { postTitle, looksLikeEvent } from "./vidacultural";
import type { RawItem } from "./types";

// T142 — rutatuta_vlc (telegram source, key `tg:rutatuta_vlc`, id 4, "Валенсия с
// пристрастием"). A local RU guide who runs DATED GUIDED EXCURSIONS / day-tours (e.g.
// «групповая экскурсия "Валенсия с пристрастием" ✨ 17 июня, 10:30 📍 Plaza de
// Ayuntamiento 🕔 2,5 часа 💶 25 евро»). The user wants these visually DISTINCT from
// the "soulless generic events" feed, so every emitted event is tagged
// `category='excursion'` — the render layer (featureKind, T133) then paints them with a
// dedicated accent. Raw rows arrive from the generic telegram parser
// (`raw_json.kind === "telegram_post"`, carrying `media_urls` + `post_ref`); the post
// body is in `raw_text`, the first line is the title. We keep ONLY posts that read like
// a real dated excursion/tour (a parsed date + an event shape) and drop channel
// chatter, header cards and undated announcements. Fail-soft + append-only: never throws
// (constitution I/IV).

export const RUTATUTA_SOURCE_KEY = "tg:rutatuta_vlc";
const SOURCE_URL = "https://t.me/s/rutatuta_vlc";
// Channel display name — fed to isJunkCard so a bare header / "pinned a photo" /
// "<channel> … VIEW IN TELEGRAM" media card carrying no event content is dropped.
const RUTATUTA_NAME = "Валенсия с пристрастием";

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

// PURE: turn pending rutatuta raw rows into excursion drafts. DB-free so it unit-tests
// without a connection. Every kept post is a DATED excursion: we require a parsed start
// date (an excursion without its own date is an announcement / "save the schedule" teaser
// that would mis-pin the calendar) AND an event shape (looksLikeEvent), and we drop
// channel chrome / header / media-meta cards up front (isJunkCard). Mirrors
// buildVidaculturalEvents' telegram field access; sets category 'excursion' + language
// 'ru' + Valencia/Spain defaults.
export function buildRutatutaEvents(
  rows: RawItem[],
  today: Date = new Date(),
): Array<{ draft: EventInsert; sourceItemId: number }> {
  const out: Array<{ draft: EventInsert; sourceItemId: number }> = [];
  for (const item of rows) {
    const raw = parseRaw(item);
    const body = item.raw_text || "";

    // Drop channel-header / "pinned a photo" / media-only meta cards (deterministic — a
    // real excursion post is never matched), then require a date + an event shape.
    if (isJunkCard(item.title, body, RUTATUTA_NAME)) continue;
    const start = parseEventDate(body, today);
    // An excursion is only useful when it has its OWN date; an undated announcement /
    // "save the upcoming schedule" teaser is chatter → drop it.
    if (!start) continue;
    if (!looksLikeEvent(body, true)) continue;

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
        category: "excursion",
        language: "ru",
        audience: "family",
        start_date: start,
        venue_name: venue,
        address,
        city: "Valencia",
        country: "Spain",
        price,
        is_free: isFree,
        url: item.url ?? SOURCE_URL,
        image_url: image,
        source: RUTATUTA_SOURCE_KEY,
        source_url: item.url ?? SOURCE_URL,
        raw_excerpt: compact(body)?.slice(0, 1000) ?? null,
      },
    });
  }
  return out;
}

// Normalizer for rutatuta. Reads pending raw rows, builds excursion drafts, upserts each
// idempotently (shared `upsertPlainEvent`), then marks EVERY processed raw row normalized
// — kept OR dropped — because the raw layer is append-only (constitution I) and a dropped
// post must not stay pending forever. `exec` is injectable for tests. Mirrors
// normalizeVidacultural's DB/marking mechanics.
export async function normalizeRutatuta(
  { exec = sql }: { exec?: typeof sql } = {},
): Promise<{ created: number; updated: number; processed: number }> {
  const rows = (await exec`
    SELECT * FROM source_items
    WHERE source_key = ${RUTATUTA_SOURCE_KEY}
      AND (normalized_status IS NULL OR normalized_status = 'pending'
           OR normalized_at IS NULL OR normalized_at < last_seen)
  `) as unknown as RawItem[];

  const drafts = buildRutatutaEvents(rows);
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
