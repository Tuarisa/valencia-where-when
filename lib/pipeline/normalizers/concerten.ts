import { sql } from "../../db";
import { compact, nowIso } from "../util";
import { parseEventDate, upsertPlainEvent, type EventInsert } from "./shared";
import { parsePrice, parseVenue, parseAddress } from "./valenciarusa";
import { isSpainEvent, hasNonSpainSignal, hasSpainSignal } from "./spain-filter";
import { postTitle } from "./vidacultural";
import type { RawItem } from "./types";

// T112 — concerten (telegram source, key `tg:concerten`, id 2, "Зарубежная афиша
// русскоязычных артистов"). This is the telegram twin of web:worldafisha (T136): the
// SAME catalogue of RU-artist tours, but announced across ALL of Europe. So — exactly
// like worldafisha (T131) — we MUST pre-filter to Spain or the feed overloads with
// Berlin/Paris/Lisbon dates a Valencia family can't attend. Raw rows arrive from the
// generic telegram parser (`raw_json.kind === "telegram_post"`, carrying `media_urls` +
// `post_ref`); the post body is in `raw_text`, first line is the title. We Spain-gate
// each post, then parse date / venue / address / price from the body and emit ONE
// concert per kept post. Fail-soft: an unparseable / non-Spain / location-less row is
// dropped, never throws (constitution: pipeline is fail-soft + append-only).

export const CONCERTEN_SOURCE_KEY = "tg:concerten";
const SOURCE_URL = "https://t.me/s/concerten";

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

// PURE: which Spanish city does this post signal? Returns the canonical city name for
// the matched signal (defaults to "Valencia" only when Valencia itself is the signal).
// Used to set the event city accurately instead of always pinning Valencia (worldafisha
// pins Valencia because it scrapes the /ispaniya index; here each post names its city).
const CITY_SIGNALS: Array<[RegExp, string]> = [
  [/valencia|valència|валенси/i, "Valencia"],
  [/madrid|мадрид/i, "Madrid"],
  [/barcelona|барселон/i, "Barcelona"],
  [/sevilla|севиль/i, "Sevilla"],
  [/m[áa]laga|малаг/i, "Málaga"],
  [/bilbao|бильбао/i, "Bilbao"],
  [/zaragoza|сарагос/i, "Zaragoza"],
  [/alicante|alacant|аликанте/i, "Alicante"],
  [/murcia|мурси/i, "Murcia"],
  [/granada|гранад/i, "Granada"],
  [/gand[íi]a|гандия/i, "Gandia"],
  [/castell[óo]n|кастельон/i, "Castellón"],
  [/torrevieja|торревьех/i, "Torrevieja"],
  [/marbella|марбель/i, "Marbella"],
  [/palma|пальма|mallorca|майорк/i, "Palma"],
  [/tenerife|тенериф/i, "Tenerife"],
];

export function spainCity(text?: string | null): string | null {
  const t = compact(text);
  if (!t) return null;
  for (const [re, city] of CITY_SIGNALS) {
    if (re.test(t)) return city;
  }
  return null;
}

// PURE: turn pending concerten raw rows into Spain-filtered concert drafts. DB-free so
// it unit-tests without a connection. Mirrors buildWorldafishaEvents' Spain gate and
// buildVidaculturalEvents' telegram field access.
export function buildConcertenEvents(
  rows: RawItem[],
  today: Date = new Date(),
): Array<{ draft: EventInsert; sourceItemId: number }> {
  const out: Array<{ draft: EventInsert; sourceItemId: number }> = [];
  for (const item of rows) {
    const raw = parseRaw(item);
    const body = item.raw_text || "";

    // Spain gate (T131/T136): the channel spans all of Europe. Keep ONLY items that
    // carry an explicit Spain signal; drop non-Spain hubs and location-less posts (a
    // tour line like "Madrid · Berlin" stays via its Spain signal; a pure "Berlin"
    // line or an undated/no-location chat post is dropped). Conservative — same as
    // worldafisha — to avoid overloading the feed.
    const haystack = `${item.title || ""} ${body} ${item.url || ""}`;
    if (!isSpainEvent(haystack)) continue;
    if (hasNonSpainSignal(haystack) && !hasSpainSignal(item.title)) {
      // a non-Spain hub is present and the Spain signal lives only in the body → too
      // ambiguous to keep without the Spain signal in the headline itself.
      continue;
    }

    const title = postTitle(body, item.title);
    if (!title) continue;

    const start = parseEventDate(haystack, today);
    const { price, isFree } = parsePrice(body);
    const venue = parseVenue(body);
    const address = parseAddress(body);
    const city = spainCity(haystack) ?? "Valencia";
    const image = Array.isArray(raw.media_urls) && raw.media_urls.length ? raw.media_urls[0] : null;

    out.push({
      sourceItemId: item.id,
      draft: {
        title: title.slice(0, 300),
        description: compact(body)?.slice(0, 2000) ?? null,
        category: "concert",
        language: "ru",
        audience: "adult",
        start_date: start,
        venue_name: venue,
        address,
        city,
        country: "Spain",
        price,
        is_free: isFree,
        url: item.url ?? SOURCE_URL,
        image_url: image,
        source: CONCERTEN_SOURCE_KEY,
        source_url: item.url ?? SOURCE_URL,
        raw_excerpt: compact(body)?.slice(0, 1000) ?? null,
      },
    });
  }
  return out;
}

// Normalizer for concerten. Reads pending raw rows, builds Spain-filtered concert
// drafts, upserts each idempotently (shared `upsertPlainEvent`), then marks EVERY
// processed raw row normalized — kept OR Spain-dropped — because the raw layer is
// append-only (constitution I) and a dropped post must not stay pending forever.
// `exec` is injectable for tests. Mirrors normalizeVidacultural's DB/marking mechanics.
export async function normalizeConcerten(
  { exec = sql }: { exec?: typeof sql } = {},
): Promise<{ created: number; updated: number; processed: number }> {
  const rows = (await exec`
    SELECT * FROM source_items
    WHERE source_key = ${CONCERTEN_SOURCE_KEY}
      AND (normalized_status IS NULL OR normalized_status = 'pending'
           OR normalized_at IS NULL OR normalized_at < last_seen)
  `) as unknown as RawItem[];

  const drafts = buildConcertenEvents(rows);
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
