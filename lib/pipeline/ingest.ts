import { sql } from "../db";
import {
  USER_AGENT, nowIso, isoAgo, compact, stripTags, decodeEntities,
  sourceItemHash, fetchText, fetchJson, sanitizeText,
} from "./util";

export interface RawItem {
  source_key: string;
  external_id?: string | null;
  item_type?: string | null;
  title?: string | null;
  url?: string | null;
  published_at?: string | null;
  raw_text?: string | null;
  raw_html?: string | null;
  raw_json?: any;
}

const TELEGRAM_POST_RE = /(<div class="tgme_widget_message_wrap[^"]*"[\s\S]*?<div class="tgme_widget_message[^"]*"[^>]*data-post="([^"]+)"[^>]*>[\s\S]*?<\/div>\s*<\/div>)/gi;
const TIME_RE = /<time[^>]*datetime=["']([^"']+)["']/i;
const TG_TEXT_RE = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i;
const TG_LINK_RE = /tgme_widget_message_date[^>]*>\s*<a[^>]*href=["']([^"']+)["']/i;
const TG_PHOTO_RE = /background-image:url\('([^']+)'\)/gi;
const TG_IMG_RE = /<img[^>]+src=["']([^"']+)["']/gi;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const META_RE = /<meta[^>]+(?:property|name)=["']([^"']+)["'][^>]+content=["']([^"']*)["']/gi;
const ANCHOR_RE = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

function pageMeta(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const tm = TITLE_RE.exec(html);
  if (tm) out.title = compact(stripTags(tm[1])) || "";
  let m: RegExpExecArray | null;
  META_RE.lastIndex = 0;
  while ((m = META_RE.exec(html)) !== null) {
    const name = m[1].toLowerCase().trim();
    if (["og:image", "twitter:image", "description", "og:description"].includes(name)) {
      out[name] = m[2].trim();
    }
  }
  return out;
}

function telegramMediaUrls(block: string): string[] {
  const urls: string[] = [];
  for (const re of [TG_PHOTO_RE, TG_IMG_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) if (!urls.includes(m[1])) urls.push(m[1]);
  }
  return urls;
}

function parseTelegram(source: any, html: string): RawItem[] {
  const items: RawItem[] = [];
  let m: RegExpExecArray | null;
  TELEGRAM_POST_RE.lastIndex = 0;
  while ((m = TELEGRAM_POST_RE.exec(html)) !== null) {
    const block = m[1];
    const postRef = m[2];
    let url: string | null = null;
    const lm = TG_LINK_RE.exec(block);
    if (lm) url = decodeEntities(lm[1]);
    if (!url && postRef) {
      const [channel, postId] = postRef.split("/");
      url = `https://t.me/${channel}/${postId}`;
    }
    const tm = TG_TEXT_RE.exec(block);
    const rawHtml = tm ? tm[1] : "";
    const rawText = compact(stripTags(rawHtml || block)) || "";
    const title = compact(rawText.split("\n", 1)[0]) || source.name;
    const time = TIME_RE.exec(block);
    items.push({
      source_key: source.key,
      external_id: postRef,
      item_type: "mixed",
      title: title.slice(0, 200),
      url,
      published_at: time ? time[1] : null,
      raw_text: rawText.slice(0, 12000),
      raw_html: rawHtml ? rawHtml.slice(0, 20000) : null,
      raw_json: { kind: "telegram_post", post_ref: postRef, media_urls: telegramMediaUrls(block) },
    });
  }
  if (items.length) return items;
  return parseGeneric(source, html);
}

// T190 — per-event detail-link capture for snapshot-driven aggregators (lacotorra,
// cac.es). Those listings render each event as a CARD: an `<a href="/detail">` that
// wraps only an IMAGE (empty/short inner text, so `parseGeneric`'s anchor pass drops
// it) plus a separate TITLE element (an `.event-title <p>` on lacotorra, an `<h1-4>` on
// cac/Elementor) that follows the anchor inside the same card. We pair each
// detail-looking internal anchor with the FIRST title element that follows it (before
// the next anchor's title), giving a deterministic title→href map. The map is stashed on
// the page_snapshot's `raw_json.event_links` so the snapshot-driven normalizers can point
// each parsed event at its OWN page instead of the aggregator index (T140 — no LLM).
const A_OPEN_RE = /<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi;
const TITLE_EL_RE =
  /<(?:p|span|div)[^>]*class=["'][^"']*(?:event-title|card-title|entry-title|post-title)[^"']*["'][^>]*>([\s\S]*?)<\/(?:p|span|div)>|<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i;

// PURE: an internal anchor that points at a per-event DETAIL page (not the listing
// index, a section, or chrome). Heuristic: same host, a path with ≥1 segment that is a
// content slug (letters + hyphens, ≥ 6 chars), and not an obvious section/chrome path.
function isDetailHref(href: string, baseHost: string): boolean {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return false;
  }
  if (u.host !== baseHost) return false;
  const path = u.pathname.replace(/\/+$/, "");
  if (!path || path === "") return false;
  const lower = path.toLowerCase();
  if (
    ["/tag/", "/category/", "/author/", "/feed", "/wp-", "/page", "/cookies", "/privacidad", "/aviso", "/contacto"].some(
      (p) => lower.includes(p),
    )
  )
    return false;
  const segs = path.split("/").filter(Boolean);
  const last = segs[segs.length - 1];
  // a content slug: hyphenated words, reasonably long, not a bare section word
  if (!/[a-z0-9]-[a-z0-9]/i.test(last)) return false;
  if (last.length < 8) return false;
  return true;
}

// PURE: extract title→detail-URL pairs from a listing page's event cards. Exported for
// tests. Deterministic; returns [] when nothing card-shaped is found.
export function extractEventLinks(html: string, baseUrl: string): Array<{ title: string; url: string }> {
  let baseHost: string;
  try {
    baseHost = new URL(baseUrl).host;
  } catch {
    return [];
  }
  const anchors: Array<{ href: string; end: number }> = [];
  let m: RegExpExecArray | null;
  A_OPEN_RE.lastIndex = 0;
  while ((m = A_OPEN_RE.exec(html)) !== null) {
    let href: string;
    try {
      href = new URL(decodeEntities(m[1]), baseUrl).toString();
    } catch {
      continue;
    }
    if (isDetailHref(href, baseHost)) anchors.push({ href, end: m.index + m[0].length });
  }

  const out: Array<{ title: string; url: string }> = [];
  const seen = new Set<string>();
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    // Window: from just after this anchor up to the next detail anchor (so a title is
    // attributed to the card it belongs to, not the following card).
    const winEnd = i + 1 < anchors.length ? anchors[i + 1].end : Math.min(html.length, a.end + 2500);
    const win = html.slice(a.end, winEnd + 200);
    const tm = TITLE_EL_RE.exec(win);
    if (!tm) continue;
    const title = compact(stripTags(tm[1] || tm[2] || ""));
    if (!title || title.length < 4 || title.length > 220) continue;
    const key = a.href;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, url: a.href });
    if (out.length >= 200) break;
  }
  return out;
}

function isNoiseLink(url: string, text: string): boolean {
  const lower = url.toLowerCase();
  if (["/tag/", "/category/", "/author/", "/feed", "/wp-json/", ".jpg", ".png", ".webp", ".svg", ".pdf"].some((p) => lower.includes(p))) return true;
  if (["leer más", "read more", "more", "saber más", "ver más"].some((p) => text.toLowerCase().startsWith(p))) return true;
  return false;
}

function parseGeneric(source: any, html: string): RawItem[] {
  const meta = pageMeta(html);
  const pageText = stripTags(html);
  // T190: capture per-event detail links from the listing's cards so snapshot-driven
  // normalizers (lacotorra, cac) can point each event at its own page (not the index).
  const eventLinks = extractEventLinks(html, source.url);
  const items: RawItem[] = [{
    source_key: source.key,
    external_id: source.url,
    item_type: "snapshot",
    title: meta.title || source.name,
    url: source.url,
    raw_text: pageText.slice(0, 12000),
    raw_json: { kind: "page_snapshot", meta, event_links: eventLinks },
  }];

  const baseHost = new URL(source.url).host;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  ANCHOR_RE.lastIndex = 0;
  while ((m = ANCHOR_RE.exec(html)) !== null && items.length < 81) {
    let href: string;
    try {
      href = new URL(decodeEntities(m[1]), source.url).toString();
    } catch {
      continue;
    }
    const text = compact(stripTags(m[2]));
    if (!text || text.length < 18 || text.length > 220) continue;
    if (isNoiseLink(href, text)) continue;
    const host = new URL(href).host;
    if (host && baseHost && host !== baseHost && !host.includes("ticketmaster") && !host.includes("songkick")) continue;
    const key = `${href}|${text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      source_key: source.key,
      external_id: href,
      item_type: "mixed",
      title: text.slice(0, 200),
      url: href,
      raw_text: text.slice(0, 1000),
      raw_json: { kind: "link_card", source_page: source.url },
    });
  }
  return items;
}

// T200: cap one request's timeout to the time left before the shared tick deadline, so
// a slow host can never drag a single fetch past the whole tick's budget. No deadline
// (legacy ingestAll, local rituals) keeps the plain 30s; the 1s floor avoids a
// degenerate instant abort when a caller starts right at the deadline.
export const FETCH_TIMEOUT_MS = 30_000;
export function clampedFetchTimeout(deadlineMs?: number, nowMs = Date.now()): number {
  if (deadlineMs == null) return FETCH_TIMEOUT_MS;
  return Math.min(FETCH_TIMEOUT_MS, Math.max(1_000, deadlineMs - nowMs));
}

async function parseHemisferic(source: any, days = 14, deadlineMs?: number): Promise<RawItem[]> {
  const items: RawItem[] = [];
  const today = new Date();
  const referer = "https://cac.es/apifront-servicios-colossus/cartelerasemanal.html";
  for (let offset = 0; offset < days; offset++) {
    // T200: honour the shared tick deadline — 14 SEQUENTIAL day-requests are the single
    // biggest time sink in ingest (each has its own 30s abort, so the per-request
    // timeout bounds nothing overall). Stop early instead of outliving the budget;
    // the remaining days simply arrive on the next due run (idempotent upserts).
    if (deadlineMs != null && Date.now() >= deadlineMs) break;
    const target = new Date(today.getTime() + offset * 86400_000);
    const day = target.toISOString().slice(0, 10);
    const url = `https://servicios.cac.es/apiback-servicios-colossus/cartelerasemanal.jsp?fechacartelera=${day}`;
    let data: any;
    try {
      ({ data } = await fetchJson(url, { Referer: referer }, undefined, clampedFetchTimeout(deadlineMs)));
    } catch {
      continue;
    }
    if (!Array.isArray(data)) continue;
    for (const entry of data) {
      const showName = compact(entry.nombre) || "Hemisfèric session";
      const sessionTimes: string[] = entry.horasdeinicio || [];
      const description = compact(stripTags(entry.descripcion || "")) || showName;
      const externalId = `${day}:${entry.idcontenido}:${showName}`;
      const posterUrl = entry.idcontenido
        ? `https://exposiciones.cac.es/media/cartelerahemisferic/idcontenido_img_${entry.idcontenido}.jpg`
        : null;
      items.push({
        source_key: source.key,
        external_id: externalId,
        item_type: "event",
        title: showName.slice(0, 200),
        url: entry.urlweb,
        published_at: `${day}T00:00:00Z`,
        raw_text: `${showName} ${day} ${sessionTimes.join(" ")} ${description}`.slice(0, 12000),
        raw_json: {
          kind: "hemisferic_schedule",
          show_name: showName,
          schedule_date: day,
          session_times: sessionTimes,
          description,
          urlweb: entry.urlweb,
          idcontenido: entry.idcontenido,
          poster_url: posterUrl,
        },
      });
    }
  }
  return items;
}

// ── T201 — lacotorra FULL-TEXT detail pages ─────────────────────────────────
// The lacotorra.io/events index renders each event with a SHORT teaser ("…"-cut),
// while the per-event detail page (`/events/<slug>`, captured as `event_links` by
// T190) carries the FULL article text in a fixed, deterministic shape:
//   <h1 class="h2">Title</h1> … <section class="descr-section"><p>…</p>…</section>
// plus an event-SPECIFIC og:image (the index og:image is one generic banner).
// This bespoke self-fetch parser (parseHemisferic pattern) ingests the index via
// `parseGeneric` as before, then fetches ONLY the detail pages we don't already
// hold (`item_type='event_detail'` rows keyed by URL), bounded by a per-run cap,
// polite pacing and the shared tick deadline (T200). The normalizer prefers the
// detail row's full text over the index teaser. Deterministic (T140 — no LLM).
const LACOTORRA_DETAIL_MAX_PER_RUN = 60; // index holds ~56 events; steady-state ≈ new ones only
const LACOTORRA_DETAIL_PACE_MS = 250; // polite gap between detail fetches
const LACOTORRA_DETAIL_TIMEOUT_MS = 10_000; // one slow article must not eat the tick

const LACOTORRA_H1_RE = /<h1[^>]*>([\s\S]*?)<\/h1>/i;
const LACOTORRA_DESCR_RE =
  /<section[^>]*class=["'][^"']*descr-section[^"']*["'][^>]*>([\s\S]*?)<\/section>/i;

const lacotorraSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// PURE (exported for tests): extract the full article text + title + meta from a
// lacotorra event DETAIL page. `full_text` keeps paragraph breaks (stripTags turns
// </p> into newlines); a trailing photo-credit line ("Фото: …") is dropped — it is
// chrome, not event description. Falls back to og:description (a summary — still
// better than the index teaser) when the descr-section is missing.
export function extractLacotorraDetail(html: string): {
  title: string | null;
  full_text: string | null;
  meta: Record<string, string>;
} {
  const meta = pageMeta(html);
  const h1 = LACOTORRA_H1_RE.exec(html);
  const title = (h1 ? compact(stripTags(h1[1])) : null) || meta.title || null;
  let full: string | null = null;
  const sec = LACOTORRA_DESCR_RE.exec(html);
  if (sec) {
    const lines = stripTags(sec[1])
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    while (lines.length && /^Фото:/i.test(lines[lines.length - 1])) lines.pop();
    full = lines.join("\n\n") || null;
  }
  if (!full) full = meta["og:description"] || meta.description || null;
  return { title, full_text: full, meta };
}

// lacotorra self-fetch parser: index snapshot + link_cards exactly as the generic
// web parser produced them before, PLUS one `event_detail` RawItem per newly seen
// detail URL. Detail rows are keyed by their URL (`external_id`), so the "already
// fetched" check is a cheap DB lookup and re-runs only fetch NEW events. A fetched
// page that yields NO text is still stored as a stub (prevents eternal refetching);
// network errors are NOT stored so the next run retries. Honours `deadlineMs`.
async function parseLacotorra(source: any, deadlineMs?: number): Promise<RawItem[]> {
  // Index page — self-fetch (no conditional GET, mirroring parseHemisferic; the
  // dispatcher's cadence gates how often we land here).
  const res = await fetchText(source.url, undefined, clampedFetchTimeout(deadlineMs));
  if (res.status !== 200 || !res.body) return [];
  const items = parseGeneric(source, res.body);

  const snapshot = items.find((i) => i.raw_json?.kind === "page_snapshot");
  const links: Array<{ title: string; url: string }> = snapshot?.raw_json?.event_links ?? [];
  const detailUrls: string[] = [];
  for (const l of links) {
    try {
      const u = new URL(l.url);
      // Only true per-event pages (/events/<slug>) — the captured links also carry
      // chrome (privacy-policy) and category filters.
      if (u.host === new URL(source.url).host && /^\/events\/[^/]+$/.test(u.pathname)) {
        if (!detailUrls.includes(l.url)) detailUrls.push(l.url);
      }
    } catch {
      /* malformed href — skip */
    }
  }
  if (detailUrls.length === 0) return items;

  const existingRows = (await sql`SELECT external_id FROM source_items
    WHERE source_key = ${source.key} AND item_type = 'event_detail'`) as any[];
  const existing = new Set(existingRows.map((r) => r.external_id));
  const missing = detailUrls
    .filter((u) => !existing.has(u))
    .slice(0, LACOTORRA_DETAIL_MAX_PER_RUN);

  for (const url of missing) {
    if (deadlineMs != null && Date.now() >= deadlineMs) break; // T200: stop at the tick budget
    try {
      const page = await fetchText(
        url,
        undefined,
        Math.min(LACOTORRA_DETAIL_TIMEOUT_MS, clampedFetchTimeout(deadlineMs)),
      );
      if (page.status !== 200 || !page.body) continue; // transient → retry next run
      const detail = extractLacotorraDetail(page.body);
      items.push({
        source_key: source.key,
        external_id: url,
        item_type: "event_detail",
        title: detail.title ? detail.title.slice(0, 200) : null,
        url,
        raw_text: detail.full_text ? detail.full_text.slice(0, 12000) : null,
        raw_json: { kind: "event_detail", source_page: source.url, meta: detail.meta },
      });
    } catch {
      /* fail-soft per page — the URL stays missing and retries next run */
    }
    await lacotorraSleep(LACOTORRA_DETAIL_PACE_MS);
  }
  return items;
}

// Parser registry (sub-area A, research A1) — mirrors NORMALIZER_REGISTRY. Replaces
// the hardcoded if/else parser dispatch in ingestSource so adding a source is a
// registry entry, not a core edit ("add a source" contract, A2). A parser turns a
// fetched body into RawItem[]; `selfFetch` entries (bespoke APIs like Hemisfèric)
// fetch their own data and ignore the body. `deadlineMs` (T200, optional) is the shared
// tick deadline — only self-fetching parsers need it (their network time is their own).
export type Parser = (source: any, body: string, deadlineMs?: number) => RawItem[] | Promise<RawItem[]>;
export interface ParserEntry {
  parse: Parser;
  selfFetch?: boolean;
}

export const PARSER_REGISTRY: Map<string, ParserEntry> = new Map<string, ParserEntry>([
  ["api:hemisferic", { parse: (source, _body, deadlineMs) => parseHemisferic(source, 14, deadlineMs), selfFetch: true }],
  // T201: bespoke lacotorra parser — index snapshot + full-text detail pages.
  ["web:lacotorra", { parse: (source, _body, deadlineMs) => parseLacotorra(source, deadlineMs), selfFetch: true }],
  ["telegram", { parse: (source, body) => parseTelegram(source, body) }],
  ["web", { parse: (source, body) => parseGeneric(source, body) }],
  ["ticketing", { parse: (source, body) => parseGeneric(source, body) }],
  ["api", { parse: (source, body) => parseGeneric(source, body) }],
]);

// PURE: which registry key handles this source? key (bespoke) → telegram (by type or
// `t.me/s/` url) → type → `web` fallback. Returned key always exists in the registry.
export function resolveParserKey(source: { key?: string; type?: string; url?: string }): string {
  if (source.key && PARSER_REGISTRY.has(source.key)) return source.key;
  if (source.type === "telegram" || (source.url || "").includes("t.me/s/")) return "telegram";
  if (source.type && PARSER_REGISTRY.has(source.type)) return source.type;
  return "web";
}

export function resolveParser(source: { key?: string; type?: string; url?: string }): ParserEntry {
  return PARSER_REGISTRY.get(resolveParserKey(source))!;
}

// Returns true when the row was NEWLY inserted (false = updated existing). The
// dispatcher uses the new-item count to decide whether a run "changed" the source.
async function upsertSourceItem(item: RawItem, runId: number): Promise<boolean> {
  const ts = nowIso();
  const dedup = sourceItemHash(item);
  // Sanitize every text value written to the DB: real posts (e.g. tg:rutatuta_vlc,
  // T147) can carry a lone surrogate from a `.slice()` cut mid-emoji, a NUL or other
  // control bytes that the Neon HTTP driver rejects ("unexpected end of hex escape").
  // dedup_hash is computed from the raw item (above) so dedup identity is unaffected.
  const externalId = sanitizeText(item.external_id ?? null);
  const title = sanitizeText(item.title ?? null);
  const url = sanitizeText(item.url ?? null);
  const rawText = sanitizeText(item.raw_text ?? null);
  const rawHtml = sanitizeText(item.raw_html ?? null);
  const rawJson = item.raw_json != null ? sanitizeText(JSON.stringify(item.raw_json)) : null;
  const existing = (await sql`SELECT id FROM source_items WHERE dedup_hash = ${dedup}`) as any[];
  if (existing.length) {
    await sql`UPDATE source_items SET last_seen = ${ts}, title = ${title},
      url = ${url}, raw_text = ${rawText}, raw_html = ${rawHtml},
      raw_json = ${rawJson}, run_id = ${runId} WHERE dedup_hash = ${dedup}`;
    return false;
  }
  await sql`INSERT INTO source_items
    (dedup_hash, source_key, run_id, external_id, item_type, title, url, published_at, raw_text, raw_html, raw_json, normalized_status, first_seen, last_seen)
    VALUES (${dedup}, ${item.source_key}, ${runId}, ${externalId}, ${item.item_type ?? null},
    ${title}, ${url}, ${item.published_at ?? null}, ${rawText},
    ${rawHtml}, ${rawJson}, 'pending', ${ts}, ${ts})`;
  return true;
}

// Outcome shape consumed by the dispatcher (T012b) to update cadence state. Legacy
// callers (ingestAll) still read `status`/`items`.
export interface IngestOutcome {
  source: string;
  status: string;
  items?: number;
  newItems?: number;
  notModified?: boolean;
  etag?: string | null;
  lastModified?: string | null;
  httpStatus?: number;
  reason?: string;
  error?: string;
}

// `deadlineMs` (T200, optional) — the dispatch tick's SHARED deadline: fetch timeouts
// are clamped to the remaining budget and self-fetch parsers stop their request chains
// at it. Absent (legacy ingestAll, local rituals) → plain 30s per-request timeout.
export async function ingestSource(source: any, minIntervalHours = 6, deadlineMs?: number): Promise<IngestOutcome> {
  if (source.last_fetched && minIntervalHours > 0 && source.last_fetched >= isoAgo(minIntervalHours)) {
    return { source: source.key, status: "skipped", reason: "fresh_enough" };
  }
  const started = nowIso();
  let httpStatus = 0;
  let items: RawItem[] = [];
  let etag: string | null = null;
  let lastModified: string | null = null;
  try {
    const parser = resolveParser(source);
    if (parser.selfFetch) {
      // Bespoke self-fetch parsers (Hemisfèric) don't go through conditional GET.
      httpStatus = 200;
      items = await parser.parse(source, "", deadlineMs);
    } else {
      const res = await fetchText(source.url, {
        etag: source.etag ?? null,
        lastModified: source.last_modified ?? null,
      }, clampedFetchTimeout(deadlineMs));
      httpStatus = res.status;
      etag = res.etag;
      lastModified = res.lastModified;
      if (res.notModified) {
        // Source unchanged since last fetch — record the cheap no-op run and bail.
        await sql`INSERT INTO source_runs
          (source_key, status, started_at, fetched_url, http_status, item_count, changed, not_modified, finished_at)
          VALUES (${source.key}, 'ok', ${started}, ${source.url}, ${httpStatus}, 0, 0, 1, ${nowIso()})`;
        await sql`UPDATE sources SET last_fetched = ${nowIso()} WHERE key = ${source.key}`;
        return { source: source.key, status: "ok", items: 0, newItems: 0, notModified: true, httpStatus };
      }
      items = await parser.parse(source, res.body);
    }
    const runRows = (await sql`INSERT INTO source_runs (source_key, status, started_at, fetched_url, http_status, parser_version)
      VALUES (${source.key}, 'ok', ${started}, ${source.url}, ${httpStatus}, 'node-v1') RETURNING id`) as any[];
    const runId = runRows[0].id;
    let newItems = 0;
    for (const item of items) {
      if (await upsertSourceItem(item, runId)) newItems++;
    }
    const changed = newItems > 0 ? 1 : 0;
    await sql`UPDATE source_runs SET finished_at = ${nowIso()}, item_count = ${items.length},
      changed = ${changed}, not_modified = 0 WHERE id = ${runId}`;
    // Persist the validators so the next run can do a conditional GET. COALESCE keeps
    // a previously-stored validator if this response omitted the header.
    await sql`UPDATE sources SET last_fetched = ${nowIso()},
      etag = COALESCE(${etag}, etag), last_modified = COALESCE(${lastModified}, last_modified)
      WHERE key = ${source.key}`;
    return {
      source: source.key,
      status: "ok",
      items: items.length,
      newItems,
      notModified: false,
      etag,
      lastModified,
      httpStatus,
    };
  } catch (err: any) {
    const msg = `${err?.name || "Error"}: ${err?.message || err}`;
    await sql`INSERT INTO source_runs (source_key, status, started_at, fetched_url, http_status, item_count, changed, not_modified, finished_at, notes)
      VALUES (${source.key}, 'error', ${started}, ${source.url}, ${httpStatus}, 0, 0, 0, ${nowIso()}, ${msg})`;
    return { source: source.key, status: "error", error: msg, httpStatus };
  }
}

export async function ingestAll(): Promise<{ total: number; ok: number; error: number; items: number; results: any[] }> {
  const sources = (await sql`SELECT * FROM sources WHERE enabled = 1 ORDER BY weight, key`) as any[];
  const results: any[] = [];
  for (const source of sources) {
    results.push(await ingestSource(source));
  }
  return {
    total: results.length,
    ok: results.filter((r) => r.status === "ok").length,
    error: results.filter((r) => r.status === "error").length,
    items: results.reduce((a, r) => a + (r.items || 0), 0),
    results,
  };
}
