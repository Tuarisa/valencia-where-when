import { sql } from "../../db";
import { compact, nowIso } from "../util";
import { parseEventDate, upsertPlainEvent, type EventInsert } from "./shared";
import { parsePrice, parseVenue, parseAddress, isJunkCard } from "./valenciarusa";
import type { RawItem } from "./types";

// T112 — Vida Cultural de Valencia (telegram source, key `tg:vidacultural_Valencia`,
// id 1). Family-friendly local events posted with date / place / price. Raw rows
// arrive from the generic telegram parser (`raw_json.kind === "telegram_post"`,
// carrying `media_urls` + `post_ref`); the post body is in `raw_text`, first line is
// the title. We parse date / venue / address / price from the body and emit ONE event
// per post. Already Valencia-local + curated family content, so NO Spain pre-filter.
// Fail-soft: a post with no usable date is still emitted (undated), but obvious
// non-event chatter (too short, no date AND no venue) is skipped. Never throws
// (constitution: pipeline is fail-soft + append-only).

export const VIDACULTURAL_SOURCE_KEY = "tg:vidacultural_Valencia";
const SOURCE_URL = "https://t.me/s/vidacultural_Valencia";
// Channel display name — used by isJunkCard (T146) to drop bare channel-header / "pinned
// a photo" / "<channel> 499 views 15:28" meta posts that carry no event content.
const VIDACULTURAL_NAME = "Культурне життя Валенсії/Vida Cultural de Valencia";

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

// PURE (T196): strip a leading PROMO-INTRO clause that some posts open with — a city tag
// + flag + generic ad copy before the real event, e.g.
//   "Валенсія 🚩 У нас для Вас просто космічні новини 🪐 26 червня … спецпоказ фільму …"
// The ad-copy hook ("У нас для Вас …" / "просто космічні новини" / "маємо для вас")
// followed by an emoji decoration is the recognisable boundary; we cut everything up to
// and including that emoji, leaving the substantive remainder ("26 червня … спецпоказ …",
// whose date prefix postTitle then strips). DETERMINISTIC (T140) + conservative: only the
// recognised promo hook is removed, and only when something substantial (≥12 chars)
// remains — otherwise the original text is kept (never blank out a real title).
const PROMO_INTRO =
  /^.{0,40}?(?:у нас для вас|маємо для вас|у нас є для вас|просто космічні новини).*?[\u{1FA90}\u{2728}\u{1F680}\u{1F389}\u{1F38A}\u{1F386}\u{1F31F}\u{1F4AB}\u{1F525}]\s+/iu;
export function stripPromoIntro(text?: string | null): string | null {
  const t = compact(text);
  if (!t) return t ?? null;
  if (!PROMO_INTRO.test(t)) return t;
  const stripped = compact(t.replace(PROMO_INTRO, ""));
  return stripped && stripped.length >= 12 ? stripped : t;
}

// PURE: a clean title from a telegram post — the first non-empty line, stripped of a
// leading promo-intro clause (T196), a leading date prefix ("21 июня — Concierto" →
// "Concierto") and surrounding emoji.
export function postTitle(rawText?: string | null, fallback?: string | null): string | null {
  const t = compact(rawText);
  const first = t ? t.split("\n", 1)[0] : null;
  let line = compact(first) || compact(fallback);
  if (!line) return null;
  // T196: peel a leading promo-intro ad clause before anything else.
  line = stripPromoIntro(line) ?? line;
  // drop a leading "DD <month> [—|-|:]" / "DD.MM —" date prefix from the headline
  line = line.replace(
    /^\s*\d{1,2}[.\/-]?\s*(?:de\s+)?[A-Za-zА-Яа-яёЁ]*\.?\s*(?:\d{4})?\s*[—\-:|·]\s*/u,
    "",
  );
  // strip leading non-letter/non-digit decoration (emoji, bullets)
  line = line.replace(/^[^\p{L}\p{N}]+/u, "");
  return compact(line)?.slice(0, 300) ?? null;
}

// PURE: is this post plausibly an event (vs. a plain announcement/chat)? Keep when it
// has a date OR a venue cue; require some minimal body length. Conservative — drops
// obvious noise without over-filtering curated family posts.
export function looksLikeEvent(rawText?: string | null, hasDate = false): boolean {
  const t = compact(rawText);
  if (!t || t.length < 12) return false;
  if (hasDate) return true;
  // no date — keep only if a venue/place cue is present
  return parseVenue(t) != null || /📍|@|teatro|sala|museo|palau|centro|jard[íi]n|parque/i.test(t);
}

// PURE: turn pending vidacultural raw rows into family-oriented event drafts. DB-free
// so it unit-tests without a connection.
export function buildVidaculturalEvents(
  rows: RawItem[],
  today: Date = new Date(),
): Array<{ draft: EventInsert; sourceItemId: number }> {
  const out: Array<{ draft: EventInsert; sourceItemId: number }> = [];
  for (const item of rows) {
    const raw = parseRaw(item);
    const body = item.raw_text || "";
    // T146: drop channel-header / "pinned a photo" / bare-@handle meta posts up front
    // (deterministic — a real event post is never matched), then apply the event gate.
    if (isJunkCard(item.title, body, VIDACULTURAL_NAME)) continue;
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
        title,
        description: compact(body)?.slice(0, 2000) ?? null,
        category: "culture",
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
        source: VIDACULTURAL_SOURCE_KEY,
        source_url: item.url ?? SOURCE_URL,
        raw_excerpt: compact(body)?.slice(0, 1000) ?? null,
      },
    });
  }
  return out;
}

// Normalizer for vidacultural. Reads pending raw rows, builds event drafts, upserts
// each idempotently (shared `upsertPlainEvent`), then marks every raw row normalized
// (append-only — constitution I). `exec` is injectable for tests.
export async function normalizeVidacultural(
  { exec = sql }: { exec?: typeof sql } = {},
): Promise<{ created: number; updated: number; processed: number }> {
  const rows = (await exec`
    SELECT * FROM source_items
    WHERE source_key = ${VIDACULTURAL_SOURCE_KEY}
      AND (normalized_status IS NULL OR normalized_status = 'pending'
           OR normalized_at IS NULL OR normalized_at < last_seen)
  `) as unknown as RawItem[];

  const drafts = buildVidaculturalEvents(rows);
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
