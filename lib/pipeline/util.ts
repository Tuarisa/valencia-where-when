import crypto from "crypto";

export const USER_AGENT =
  "Mozilla/5.0 (compatible; ValenciaRadarIngest/1.0; +https://valencia-where-when.vercel.app)";

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

export function isoAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString().replace(/\.\d+Z$/, "Z");
}

export function sha1short(base: string): string {
  return crypto.createHash("sha1").update(base, "utf-8").digest("hex").slice(0, 16);
}

// Mirror of db.norm(): lowercase, collapse whitespace, strip punctuation.
export function norm(value?: string | null): string {
  if (value == null) return "";
  let text = String(value).toLowerCase().trim();
  text = text.replace(/[\s ]+/g, " ");
  text = text.replace(/[^\p{L}\p{N}\s]/gu, "");
  return text;
}

export function compact(value?: string | null): string | null {
  if (value == null) return null;
  const v = String(value).replace(/\s+/g, " ").trim();
  return v || null;
}

export function sourceItemHash(row: {
  source_key?: string | null;
  external_id?: string | null;
  url?: string | null;
  title?: string | null;
  raw_text?: string | null;
}): string {
  const base = [
    row.source_key || "",
    row.external_id || "",
    norm(row.url),
    norm(row.title),
    norm(row.raw_text),
  ].join("|");
  return sha1short(base);
}

export function eventHash(row: {
  title?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  venue_name?: string | null;
  address?: string | null;
}): string {
  const base = [
    norm(row.title),
    row.start_date || "",
    row.end_date || "",
    norm(row.venue_name),
    norm(row.address),
  ].join("|");
  return sha1short(base);
}

const SCRIPT_STYLE_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
const TAG_RE = /<[^>]+>/g;

export function stripTags(html: string): string {
  let h = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n");
  h = h.replace(SCRIPT_STYLE_RE, " ");
  let text = h.replace(TAG_RE, " ");
  text = decodeEntities(text);
  text = text.replace(/\xa0/g, " ").replace(/\r/g, "");
  text = text.replace(/\n\s*\n\s*\n+/g, "\n\n").replace(/[ \t]+/g, " ");
  return text.trim();
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

export async function fetchText(url: string, timeoutMs = 30000): Promise<{ status: number; body: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: ctrl.signal });
    const body = await res.text();
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

export async function fetchJson(url: string, headers: Record<string, string> = {}, timeoutMs = 30000): Promise<{ status: number; data: any }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, ...headers }, signal: ctrl.signal });
    const data = await res.json();
    return { status: res.status, data };
  } finally {
    clearTimeout(t);
  }
}
