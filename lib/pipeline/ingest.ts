import { sql } from "../db";
import {
  USER_AGENT, nowIso, isoAgo, compact, stripTags, decodeEntities,
  sourceItemHash, fetchText, fetchJson,
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

function isNoiseLink(url: string, text: string): boolean {
  const lower = url.toLowerCase();
  if (["/tag/", "/category/", "/author/", "/feed", "/wp-json/", ".jpg", ".png", ".webp", ".svg", ".pdf"].some((p) => lower.includes(p))) return true;
  if (["leer más", "read more", "more", "saber más", "ver más"].some((p) => text.toLowerCase().startsWith(p))) return true;
  return false;
}

function parseGeneric(source: any, html: string): RawItem[] {
  const meta = pageMeta(html);
  const pageText = stripTags(html);
  const items: RawItem[] = [{
    source_key: source.key,
    external_id: source.url,
    item_type: "snapshot",
    title: meta.title || source.name,
    url: source.url,
    raw_text: pageText.slice(0, 12000),
    raw_json: { kind: "page_snapshot", meta },
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

async function parseHemisferic(source: any, days = 14): Promise<RawItem[]> {
  const items: RawItem[] = [];
  const today = new Date();
  const referer = "https://cac.es/apifront-servicios-colossus/cartelerasemanal.html";
  for (let offset = 0; offset < days; offset++) {
    const target = new Date(today.getTime() + offset * 86400_000);
    const day = target.toISOString().slice(0, 10);
    const url = `https://servicios.cac.es/apiback-servicios-colossus/cartelerasemanal.jsp?fechacartelera=${day}`;
    let data: any;
    try {
      ({ data } = await fetchJson(url, { Referer: referer }));
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

// Parser registry (sub-area A, research A1) — mirrors NORMALIZER_REGISTRY. Replaces
// the hardcoded if/else parser dispatch in ingestSource so adding a source is a
// registry entry, not a core edit ("add a source" contract, A2). A parser turns a
// fetched body into RawItem[]; `selfFetch` entries (bespoke APIs like Hemisfèric)
// fetch their own data and ignore the body.
export type Parser = (source: any, body: string) => RawItem[] | Promise<RawItem[]>;
export interface ParserEntry {
  parse: Parser;
  selfFetch?: boolean;
}

export const PARSER_REGISTRY: Map<string, ParserEntry> = new Map<string, ParserEntry>([
  ["api:hemisferic", { parse: (source) => parseHemisferic(source), selfFetch: true }],
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

async function upsertSourceItem(item: RawItem, runId: number): Promise<void> {
  const ts = nowIso();
  const dedup = sourceItemHash(item);
  const rawJson = item.raw_json != null ? JSON.stringify(item.raw_json) : null;
  const existing = (await sql`SELECT id FROM source_items WHERE dedup_hash = ${dedup}`) as any[];
  if (existing.length) {
    await sql`UPDATE source_items SET last_seen = ${ts}, title = ${item.title ?? null},
      url = ${item.url ?? null}, raw_text = ${item.raw_text ?? null}, raw_html = ${item.raw_html ?? null},
      raw_json = ${rawJson}, run_id = ${runId} WHERE dedup_hash = ${dedup}`;
  } else {
    await sql`INSERT INTO source_items
      (dedup_hash, source_key, run_id, external_id, item_type, title, url, published_at, raw_text, raw_html, raw_json, normalized_status, first_seen, last_seen)
      VALUES (${dedup}, ${item.source_key}, ${runId}, ${item.external_id ?? null}, ${item.item_type ?? null},
      ${item.title ?? null}, ${item.url ?? null}, ${item.published_at ?? null}, ${item.raw_text ?? null},
      ${item.raw_html ?? null}, ${rawJson}, 'pending', ${ts}, ${ts})`;
  }
}

export async function ingestSource(source: any, minIntervalHours = 6): Promise<{ source: string; status: string; items?: number; reason?: string; error?: string }> {
  if (source.last_fetched && minIntervalHours > 0 && source.last_fetched >= isoAgo(minIntervalHours)) {
    return { source: source.key, status: "skipped", reason: "fresh_enough" };
  }
  const started = nowIso();
  let httpStatus = 0;
  let items: RawItem[] = [];
  try {
    const parser = resolveParser(source);
    if (parser.selfFetch) {
      httpStatus = 200;
      items = await parser.parse(source, "");
    } else {
      const { status, body } = await fetchText(source.url);
      httpStatus = status;
      items = await parser.parse(source, body);
    }
    const runRows = (await sql`INSERT INTO source_runs (source_key, status, started_at, fetched_url, http_status, parser_version)
      VALUES (${source.key}, 'ok', ${started}, ${source.url}, ${httpStatus}, 'node-v1') RETURNING id`) as any[];
    const runId = runRows[0].id;
    for (const item of items) await upsertSourceItem(item, runId);
    await sql`UPDATE source_runs SET finished_at = ${nowIso()}, item_count = ${items.length} WHERE id = ${runId}`;
    await sql`UPDATE sources SET last_fetched = ${nowIso()} WHERE key = ${source.key}`;
    return { source: source.key, status: "ok", items: items.length };
  } catch (err: any) {
    const msg = `${err?.name || "Error"}: ${err?.message || err}`;
    await sql`INSERT INTO source_runs (source_key, status, started_at, fetched_url, http_status, item_count, finished_at, notes)
      VALUES (${source.key}, 'error', ${started}, ${source.url}, ${httpStatus}, 0, ${nowIso()}, ${msg})`;
    return { source: source.key, status: "error", error: msg };
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
