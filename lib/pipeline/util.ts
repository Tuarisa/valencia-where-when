import crypto from "crypto";
import https from "node:https";
import http from "node:http";

export const USER_AGENT =
  "Mozilla/5.0 (compatible; ValenciaRadarIngest/1.0; +https://valencia-where-when.vercel.app)";

// TLS workaround allowlist (T148). Some public read-only sources serve an INCOMPLETE
// certificate chain (a missing intermediate CA). `curl` tolerates this via the system
// CA bundle, but Node's global `fetch` (undici) rejects it with
// UNABLE_TO_VERIFY_LEAF_SIGNATURE. For these specific hosts ONLY we fall back to a
// built-in `https` GET with rejectUnauthorized:false — a chain-completeness workaround,
// NOT a blanket TLS-off: the host's identity is still the one we asked for, we just
// don't enforce the (broken) chain on a host we already trust to scrape publicly.
// Hosts are matched exactly or as a parent suffix (cac.es matches www.cac.es too).
// Keep this list as SMALL as possible; do NOT add a host to "make a flaky fetch work".
const INSECURE_TLS_HOSTS = new Set<string>(["cac.es"]);

// PURE: does this URL target a known chain-broken host that needs the insecure-TLS
// fallback? Only https hosts qualify; http and any non-allowlisted host return false.
export function needsInsecureTls(url: string): boolean {
  let host: string;
  let protocol: string;
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    protocol = u.protocol;
  } catch {
    return false;
  }
  if (protocol !== "https:") return false;
  if (INSECURE_TLS_HOSTS.has(host)) return true;
  // Subdomain match: www.cac.es is covered by cac.es, but evilcac.es is NOT.
  for (const allowed of INSECURE_TLS_HOSTS) {
    if (host.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

interface RawResponse {
  status: number;
  body: string;
  etag: string | null;
  lastModified: string | null;
}

// Built-in-http GET used ONLY for `needsInsecureTls` hosts (T148). Mirrors the bits of
// `fetch` the ingest path relies on: follows redirects, returns body + etag/last-modified,
// honours a timeout (AbortSignal-equivalent via req.destroy). rejectUnauthorized:false is
// the deliberate per-host chain-completeness workaround — applied here and NOWHERE else.
function insecureGet(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  depth = 0,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    if (depth > 5) {
      reject(new Error("too many redirects"));
      return;
    }
    let u: URL;
    try {
      u = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    const isHttp = u.protocol === "http:";
    const mod = isHttp ? http : https;
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (isHttp ? 80 : 443),
        path: `${u.pathname}${u.search}`,
        method: "GET",
        headers,
        // Per-host incomplete-chain workaround. Plain http requests ignore this.
        rejectUnauthorized: false,
      },
      (res) => {
        const status = res.statusCode || 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume(); // drain so the socket frees
          let next: string;
          try {
            next = new URL(location, url).toString();
          } catch (err) {
            reject(err);
            return;
          }
          resolve(insecureGet(next, headers, timeoutMs, depth + 1));
          return;
        }
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () =>
          resolve({
            status,
            body,
            etag: (res.headers.etag as string) || null,
            lastModified: (res.headers["last-modified"] as string) || null,
          }),
        );
      },
    );
    const timer = setTimeout(() => req.destroy(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    req.on("error", reject);
    req.on("close", () => clearTimeout(timer));
    req.end();
  });
}

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

// Strip bytes that the @neondatabase/serverless driver cannot serialise into its
// HTTP request body (it fails with "unexpected end of hex escape"). Causes seen in
// the wild (T147, tg:rutatuta_vlc): a `.slice(0, N)` cut landing mid-surrogate-pair
// leaves a LONE surrogate (e.g. a chopped emoji), which is not valid UTF-8. Also
// drops NUL + other C0/C1 control chars (except \t \n \r) and Unicode noncharacters.
// Pure + minimal: normal text, Cyrillic, links and intact emoji round-trip unchanged.
// C0 (0x00-0x1F) except TAB/LF/CR, DEL + C1 (0x7F-0x9F).
const CONTROL_RE =
  // eslint-disable-next-line no-control-regex
  /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// BMP noncharacters: U+FDD0-U+FDEF and U+FFFE/U+FFFF.
const NONCHAR_RE = /[\uFDD0-\uFDEF\uFFFE\uFFFF]/g;

export function sanitizeText<T extends string | null | undefined>(value: T): T {
  if (value == null) return value;
  const out = String(value)
    .replace(CONTROL_RE, "")
    .replace(LONE_SURROGATE_RE, "")
    .replace(NONCHAR_RE, "");
  return out as T;
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

// Optional conditional-GET state (research A1): when present, the fetch sends
// If-None-Match / If-Modified-Since so an unchanged source answers 304 (no body),
// which the dispatcher turns into a longer poll interval (back-off).
export interface ConditionalGet {
  etag?: string | null;
  lastModified?: string | null;
}

function conditionalHeaders(cond?: ConditionalGet): Record<string, string> {
  const h: Record<string, string> = {};
  if (cond?.etag) h["If-None-Match"] = cond.etag;
  if (cond?.lastModified) h["If-Modified-Since"] = cond.lastModified;
  return h;
}

export async function fetchText(
  url: string,
  cond?: ConditionalGet,
  timeoutMs = 30000,
): Promise<{ status: number; body: string; etag: string | null; lastModified: string | null; notModified: boolean }> {
  // Chain-broken hosts (T148, e.g. cac.es) bypass undici's `fetch` for a built-in
  // `https` GET with the per-host insecure-TLS workaround; conditional-GET, UA and
  // timeout are preserved identically.
  if (needsInsecureTls(url)) {
    const res = await insecureGet(url, { "User-Agent": USER_AGENT, ...conditionalHeaders(cond) }, timeoutMs);
    const notModified = res.status === 304;
    return {
      status: res.status,
      body: notModified ? "" : res.body,
      etag: res.etag,
      lastModified: res.lastModified,
      notModified,
    };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, ...conditionalHeaders(cond) },
      signal: ctrl.signal,
    });
    const notModified = res.status === 304;
    const body = notModified ? "" : await res.text();
    return {
      status: res.status,
      body,
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
      notModified,
    };
  } finally {
    clearTimeout(t);
  }
}

export async function fetchJson(
  url: string,
  headers: Record<string, string> = {},
  cond?: ConditionalGet,
  timeoutMs = 30000,
): Promise<{ status: number; data: any; etag: string | null; lastModified: string | null; notModified: boolean }> {
  // Same per-host TLS workaround as fetchText (T148) for chain-broken hosts.
  if (needsInsecureTls(url)) {
    const res = await insecureGet(url, { "User-Agent": USER_AGENT, ...headers, ...conditionalHeaders(cond) }, timeoutMs);
    const notModified = res.status === 304;
    return {
      status: res.status,
      data: notModified || !res.body ? null : JSON.parse(res.body),
      etag: res.etag,
      lastModified: res.lastModified,
      notModified,
    };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, ...headers, ...conditionalHeaders(cond) },
      signal: ctrl.signal,
    });
    const notModified = res.status === 304;
    const data = notModified ? null : await res.json();
    return {
      status: res.status,
      data,
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
      notModified,
    };
  } finally {
    clearTimeout(t);
  }
}
