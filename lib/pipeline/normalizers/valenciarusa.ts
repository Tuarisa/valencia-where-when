import { sql } from "../../db";
import { compact, nowIso } from "../util";
import { parseEventDate, upsertPlainEvent, type EventInsert } from "./worldafisha";
import type { RawItem } from "./types";

// T111 — valenciarusa.es (web source, key `web:valenciarusa`, id 7). The most
// PRECISE local RU agenda: each listing carries a date, venue and often a price. Raw
// rows arrive from the generic web parser as `link_card` (per-listing anchor) or
// `page_snapshot` (the agenda page itself). We pull date / venue / address / price
// out of the title+text and emit ONE event per listing. Already Valencia-local, so
// NO Spain pre-filter is needed (unlike worldafisha). Fail-soft: an unparseable row
// is skipped, never throws (constitution: pipeline is fail-soft + append-only).

export const VALENCIARUSA_SOURCE_KEY = "web:valenciarusa";
const SOURCE_URL = "https://www.valenciarusa.es/sobytiya";
// Display name of the site — used by isJunkCard to recognise bare header/chrome cards.
const VALENCIARUSA_NAME = "Валенсия Русская";

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

// PURE: a price token from free RU/ES text. Recognises "10 €", "€10", "10 евро",
// "10 eur", "от 15€", and free admission ("бесплатно", "вход свободный", "gratis",
// "free", "entrada libre"). Returns { price, isFree } — either field may be null.
export function parsePrice(text?: string | null): { price: string | null; isFree: number | null } {
  const t = compact(text);
  if (!t) return { price: null, isFree: null };
  const lower = t.toLowerCase();
  if (/бесплатн|вход свободн|вход бесплатн|gratis|gratuit|entrada libre|free entry|free admission|\bfree\b/.test(lower)) {
    return { price: "Free", isFree: 1 };
  }
  // NOTE: the trailing word-boundary must guard ONLY the ASCII forms (eur/euros): a
  // `\b` after `€` or Cyrillic «евро» never matches (neither is an ASCII word char),
  // which silently dropped every "€10" / "10 евро" price. Anchor `\b` to `eurs?` alone.
  const m = /(?:от\s*)?(\d{1,4})(?:[.,]\d{1,2})?\s*(?:€|евро|euros?\b|eur\b)|(?:€|eur\b)\s*(\d{1,4})/i.exec(t);
  if (m) {
    const amount = m[1] ?? m[2];
    if (amount) return { price: `${amount} €`, isFree: 0 };
  }
  return { price: null, isFree: null };
}

// T146 — deterministic non-event / site-chrome guard (no LLM, per T140). The generic
// web + telegram parsers also emit nav links, contact/legal pages, channel headers and
// Telegram meta posts ("pinned a photo"). These are NOT events; dropping them keeps the
// feed clean. Everything here is a pure keyword/shape test — a REAL event (which always
// carries a date, venue cue or a substantial body) is never matched.

// Pure nav / legal / chrome labels that appear as a WHOLE card (RU/UK/ES/EN). Matched
// case-insensitively against the entire compacted card text, so a real event whose body
// merely mentions e.g. "cookies" is unaffected — only a card that is ONLY the label drops.
const NAV_LABELS = [
  "контакты", "контакти", "подписаться", "підписатися", "войти", "увійти",
  "правовая информация", "правова інформація", "конфиденциальность", "конфіденційність",
  "политика конфиденциальности", "політика конфіденційності",
  "о нас", "про нас", "новости", "новини", "события", "події", "гиды", "гіди",
  "рестораны", "ресторани", "услуги", "послуги", "документы", "документи",
  "política de privacidad", "política de cookies", "política de cookies y privacidad",
  "aviso legal", "cookies", "privacy", "privacy policy", "legal", "terms", "contact",
  "subscribe", "log in", "login", "sign in",
];

// PURE (T146): is the whole compacted text just an email address (optionally "mailto:")?
// A genuine event body that happens to contain a contact email is long and has other
// content, so we only treat a card that is ONLY an email as chrome.
function isBareEmail(text: string): boolean {
  return /^(?:mailto:)?\s*[^\s@]+@[^\s@]+\.[^\s@]{2,}\s*$/i.test(text);
}

// PURE (T146): is the whole compacted text just a Telegram @handle (e.g. "@janeS_31")?
function isBareHandle(text: string): boolean {
  return /^@[A-Za-z0-9_]{3,}$/.test(text);
}

// PURE (T146): strip trailing Telegram view/time/forward meta a header card may carry,
// e.g. "<channel> 499 views 15:28", "<channel> pinned a photo". Returns the core line.
function stripPostMeta(text: string): string {
  return text
    .replace(/\bpinned a (?:photo|message|video|file|poll|live stream)\b.*$/i, "")
    .replace(/\b\d[\d.,kKmM]*\s*views?\b.*$/i, "")
    .replace(/\b\d{1,2}:\d{2}\b\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

// PURE (T146): decide whether a parsed card is non-event chrome/meta and must be DROPPED.
// `title`/`body` are the raw title + body text; `sourceName` (optional) is the channel /
// site display name so a bare header line ("<channel name>", or "<channel> pinned a
// photo") is matched exactly. Deterministic keyword/shape tests only — a real event is
// never matched (it carries a date, a venue cue or a substantial multi-clause body).
export function isJunkCard(
  title?: string | null,
  body?: string | null,
  sourceName?: string | null,
): boolean {
  const t = compact(title) ?? "";
  const b = compact(body) ?? "";
  // The card text we test = the longer of title/body (header cards repeat the name in both).
  const text = (b.length >= t.length ? b : t).trim();
  if (!text) return true; // empty card

  // Telegram meta posts ("… pinned a photo / message").
  if (/\bpinned a (?:photo|message|video|file|poll|live stream)\b/i.test(text)) return true;

  const lower = text.toLowerCase();

  // Whole card is an email address or a bare @handle.
  if (isBareEmail(text) || isBareHandle(text)) return true;

  // Whole card is a pure nav / legal / chrome label (exact match after compaction).
  if (NAV_LABELS.includes(lower)) return true;

  // Bare channel/site header line: the card is ONLY the source name (optionally with
  // trailing Telegram view/time meta, or a leading 🔔-style decoration already compacted).
  if (sourceName) {
    const name = compact(sourceName)?.toLowerCase() ?? "";
    if (name) {
      const core = stripPostMeta(text).toLowerCase();
      if (core === name) return true;
      // also catch "<name> | <name>"-style duplicated headers and trailing temperature
      // chrome a snapshot may leave (e.g. "Валенсия Русская 25 °").
      const coreNoTemp = core.replace(/\s*\d{1,3}\s*°.*$/u, "").trim();
      if (coreNoTemp === name) return true;
    }
  }
  return false;
}

// Venue cue words (RU/ES) — when one precedes a proper-noun phrase we treat the rest
// of that segment as the venue name. Best-effort; venue stays null when unclear.
const VENUE_CUES = /(?:в\s+|место[:\s]+|venue[:\s]+|в\s+зале\s+|teatro\s+|sala\s+|centro\s+|museo\s+|palau\s+)/i;

// PURE: best-effort venue name from a line. Looks for a cue word followed by a
// capitalised phrase. Returns null when nothing confident is found.
export function parseVenue(text?: string | null): string | null {
  const t = compact(text);
  if (!t) return null;
  // direct address-ish "venue, address" or "@ Venue" patterns first
  const at = /(?:@|📍)\s*([^\n,;]{3,80})/.exec(t);
  if (at) return compact(at[1]);
  const cue = VENUE_CUES.exec(t);
  if (cue) {
    const after = t.slice(cue.index + cue[0].length);
    const m = /^([A-ZА-ЯÀ-Ü][\p{L}0-9'’.\- ]{2,60})/u.exec(after);
    if (m) return compact(m[1]);
  }
  return null;
}

// PURE: best-effort street address ("Calle/Av./Plaza … 12"). Returns null when none.
export function parseAddress(text?: string | null): string | null {
  const t = compact(text);
  if (!t) return null;
  const m = /\b((?:calle|c\/|av\.?|avenida|avda\.?|plaza|pl\.|paseo|carrer|carretera)\s+[\p{L}0-9'’.\- ]{2,60}\d{0,4})/iu.exec(t);
  return m ? compact(m[1]) : null;
}

// PURE: turn pending valenciarusa raw rows into event drafts (date/venue/address/
// price extracted where derivable). The full-page snapshot is dropped (no single
// event identity). DB-free so it unit-tests without a connection.
export function buildValenciarusaEvents(
  rows: RawItem[],
  today: Date = new Date(),
): Array<{ draft: EventInsert; sourceItemId: number }> {
  const out: Array<{ draft: EventInsert; sourceItemId: number }> = [];
  for (const item of rows) {
    const raw = parseRaw(item);
    if (raw.kind === "page_snapshot") continue;

    const title = compact(item.title);
    if (!title) continue;

    // T146: drop nav / contact / legal / chrome cards (email, "Правовая информация",
    // bare site-name header). Deterministic; a real dated listing is never matched.
    if (isJunkCard(title, item.raw_text, VALENCIARUSA_NAME)) continue;

    const haystack = `${title} ${item.raw_text || ""}`;
    const start = parseEventDate(haystack, today);
    const { price, isFree } = parsePrice(haystack);
    const venue = parseVenue(haystack);
    const address = parseAddress(haystack);

    out.push({
      sourceItemId: item.id,
      draft: {
        title: title.slice(0, 300),
        description: compact(item.raw_text)?.slice(0, 2000) ?? null,
        category: "culture",
        language: "ru",
        start_date: start,
        venue_name: venue,
        address,
        city: "Valencia",
        country: "Spain",
        price,
        is_free: isFree,
        url: item.url ?? SOURCE_URL,
        image_url: raw.meta?.["og:image"] || null,
        source: VALENCIARUSA_SOURCE_KEY,
        source_url: item.url ?? SOURCE_URL,
        raw_excerpt: compact(item.raw_text)?.slice(0, 1000) ?? null,
      },
    });
  }
  return out;
}

// Normalizer for valenciarusa. Reads pending raw rows, builds event drafts, upserts
// each idempotently (shared `upsertPlainEvent`), then marks every raw row normalized
// (append-only — constitution I). `exec` is injectable for tests.
export async function normalizeValenciarusa(
  { exec = sql }: { exec?: typeof sql } = {},
): Promise<{ created: number; updated: number; processed: number }> {
  const rows = (await exec`
    SELECT * FROM source_items
    WHERE source_key = ${VALENCIARUSA_SOURCE_KEY}
      AND (normalized_status IS NULL OR normalized_status = 'pending'
           OR normalized_at IS NULL OR normalized_at < last_seen)
  `) as unknown as RawItem[];

  const drafts = buildValenciarusaEvents(rows);
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
