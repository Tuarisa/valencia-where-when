// Formatting + title-derivation helpers, ported 1:1 from the Python prototype
// (build_site.py: derive_title / format_date_label / excerpt / page_slug, and
// entity_tags.py: slugify / load_tags).

const MONTH_NAMES_RU = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

export function parseIsoDate(value?: string | null): Date | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function excerpt(value?: string | null, limit = 220): string {
  const text = (value || "").trim();
  if (text.length <= limit) return text;
  return text.slice(0, limit - 1).replace(/\s+$/, "") + "…";
}

const DATE_SEG_RE = /^\d{1,2}\s*[а-яёa-z]*\.?,?\s*\d{0,2}[:.]?\d{0,2}\s*$/i;
const PINNED_RE = /^.{0,48}?pinned\s*[«"']?\s*/i;
const LEAD_TRIM_RE = /^[\s«»"'\-—–:;,.!?…👉👇✨⭐️🔥🇺🇦🎟️📍🕐⏱️©]+/u;
const TRAIL_TRIM_RE = /[\s«»"'\-—–:;,👉👇✨⭐️🔥📍🕐⏱️©]+$/u;

function dedupRepeat(text: string): string {
  const sig = text.slice(0, 15).trim();
  if (sig.length < 8) return text;
  const second = text.indexOf(sig, 6);
  if (second > 6 && second < text.length * 0.7) return text.slice(0, second).trim();
  return text;
}

// Pull a short human title out of a raw post body.
export function deriveTitle(raw?: string | null, limit = 72): string {
  let text = (raw || "").replace(/\s+/g, " ").trim();
  if (!text) return "Без названия";
  text = text.replace(PINNED_RE, "");
  if (text.includes("👉")) {
    let segs = text.split("👉").map((s) => s.replace(/^[\s«»"']+|[\s«»"']+$/g, "")).filter(Boolean);
    if (segs.length && DATE_SEG_RE.test(segs[0])) segs = segs.slice(1);
    if (segs.length) text = segs[0];
  }
  text = text.replace(LEAD_TRIM_RE, "");
  text = dedupRepeat(text);
  const m = /[.!?…](?:\s|$)/.exec(text);
  if (m && m.index >= 12 && m.index <= limit) {
    text = text.slice(0, m.index + 1);
  } else if (text.length > limit) {
    let cut = text.slice(0, limit).replace(/\s+$/, "");
    const space = cut.lastIndexOf(" ");
    if (space > limit * 0.5) cut = cut.slice(0, space);
    text = cut + "…";
  }
  text = text.replace(TRAIL_TRIM_RE, "").trim();
  return text || "Без названия";
}

export function slugify(value?: string | null): string {
  if (!value) return "";
  const ascii = String(value)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .trim();
  return ascii.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function pageSlug(value: string | null | undefined, fallback: string): string {
  const base = slugify(value);
  if (!base) return fallback;
  const parts = base.split("-").filter(Boolean);
  const shortened = parts.slice(0, 8).join("-").slice(0, 72).replace(/^-+|-+$/g, "");
  return shortened || fallback;
}

export function formatDateLabel(
  startDate?: string | null,
  endDate?: string | null,
  startTime?: string | null,
): string {
  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  if (!start) return "Дата уточняется";
  const fmt = (d: Date) =>
    `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`;
  let label = end && end.getTime() !== start.getTime() ? `${fmt(start)}–${fmt(end)}` : fmt(start);
  if (startTime) label += ` ${startTime}`;
  return label;
}

export function loadTags(value?: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(Boolean).map((x) => String(x));
  } catch {
    return [];
  }
}

export function monthLabel(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  return `${MONTH_NAMES_RU[month - 1]} ${year}`;
}

export function eventLocationLabel(row: {
  venue_name?: string | null;
  district?: string | null;
  city?: string | null;
}): string {
  const out: string[] = [];
  for (const part of [row.venue_name, row.district, row.city]) {
    if (part && !out.includes(part)) out.push(part);
  }
  return out.join(", ") || "Локация уточняется";
}

export function placeLocationLabel(row: {
  area?: string | null;
  district?: string | null;
  city?: string | null;
}): string {
  const out: string[] = [];
  for (const part of [row.area, row.district, row.city]) {
    if (part && !out.includes(part)) out.push(part);
  }
  return out.join(", ") || "Valencia";
}

// Image URL gate (T187). Many records carry a Telegram CDN image_url
// (https://cdn4.telesco.pe/file/…) that is hotlink-protected / expiring, so it 404s in
// the browser → a broken-image icon on every card. usableImageUrl() returns the URL only
// if it's a plausibly-loadable image, else null so the caller renders the placeholder
// gradient instead of a broken <img>. Pure + SSR-safe (no fetch) — we route dead hosts to
// the placeholder, we do NOT try to re-host. Deterministic (T140).
const DEAD_IMAGE_HOST_RE = /(^|\.)telesco\.pe$/i; // Telegram CDN (incl. cdn4.telesco.pe)

export function usableImageUrl(url?: string | null): string | null {
  const raw = (url || "").trim();
  if (!raw) return null;
  let host: string;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    host = u.hostname;
  } catch {
    return null; // not a parseable absolute URL → can't safely use as <img src>
  }
  if (DEAD_IMAGE_HOST_RE.test(host)) return null; // known-dead Telegram CDN host
  return raw;
}

export function humanizeTag(tag: string): string {
  return tag
    .replace(/^city:/, "city ")
    .replace(/^district:/, "district ")
    .replace(/^area:/, "area ")
    .replace(/-/g, " ");
}
