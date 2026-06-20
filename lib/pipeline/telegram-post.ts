import { stripTags, decodeEntities } from "./util";

// Parse a SINGLE Telegram post from its public embed page (t.me/<channel>/<n>?embed=1).
// Public, no login — same principle as t.me/s/ (Constitution Telegram constraint),
// but addressable per-post so a channel's full history can be walked by post id. The
// structural fields here (photo CDN url, outbound links incl. a maps link, hashtags)
// are RELIABLE; turning the free-form RU body into a clean place record is the LLM's
// job (claude -p) — see scripts/crawl-telegram.mjs. Pure / DB-free / unit-testable.

export interface TelegramPost {
  post_id: number | null;
  text: string;
  photos: string[]; // real post photos (telesco.pe CDN), emoji images excluded
  links: string[]; // outbound non-telegram links
  maps_url: string | null; // first Google-Maps link, if any
  hashtags: string[];
}

const TEXT_FOOTER_RE = /tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>\s*<div class="tgme_widget_message_footer/;
const TEXT_RE = /tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/;
const BG_RE = /background-image:url\('([^']+)'\)/g;
const HREF_RE = /href="(https?:\/\/[^"]+)"/g;
const ID_RE = /t\.me\/[^/"']+\/(\d+)/;
const MAPS_RE = /maps\.app\.goo\.gl|google\.[^/]+\/maps|goo\.gl\/maps/;

export function parseTelegramPost(html: string): TelegramPost {
  const tm = TEXT_FOOTER_RE.exec(html) || TEXT_RE.exec(html);
  let text = "";
  if (tm) {
    text = stripTags(tm[1].replace(/<br\s*\/?>/gi, "\n")).trim();
  }

  const photos: string[] = [];
  BG_RE.lastIndex = 0;
  let bm: RegExpExecArray | null;
  while ((bm = BG_RE.exec(html)) !== null) {
    if (bm[1].includes("telesco.pe") && !photos.includes(bm[1])) photos.push(bm[1]);
  }

  const links: string[] = [];
  HREF_RE.lastIndex = 0;
  let hm: RegExpExecArray | null;
  while ((hm = HREF_RE.exec(html)) !== null) {
    const u = decodeEntities(hm[1]);
    if (!/t\.me|telegram\./.test(u) && !links.includes(u)) links.push(u);
  }

  const maps_url = links.find((u) => MAPS_RE.test(u)) || null;
  const hashtags = Array.from(new Set((text.match(/#([^\s#<]+)/g) || []).map((t) => t.slice(1))));
  const idm = ID_RE.exec(html);
  const post_id = idm ? Number(idm[1]) : null;

  return { post_id, text, photos, links, maps_url, hashtags };
}
