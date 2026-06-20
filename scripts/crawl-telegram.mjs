// Slow, resumable per-post Telegram crawler → place/event seed (T130).
// Walks a channel BACKWARD from a start post id via the PUBLIC embed page
// (t.me/<channel>/<n>?embed=1 — no login), parses each post, and uses `claude -p`
// (Claude subscription, no API key) to extract a clean record. Polite + resumable.
//
// FETCH CACHE: each post's HTML is cached under data/.cache/tg/<channel>/ (gitignored)
// so re-runs / better-prompt re-extractions DON'T re-request the same posts.
// Extraction captures date/place/category/etc and routes:
//   kind=place → data/seed/places-<channel>.json   (places table)
//   kind=event → data/seed/events-<channel>.json    (events table, with start_date)
//
//   node --import tsx scripts/crawl-telegram.mjs logunespa 1800 20 2500
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import { parseTelegramPost } from "../lib/pipeline/telegram-post.ts";

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const UA = "Mozilla/5.0 (compatible; ValenciaRadarIngest/1.0; +https://valencia-where-when.vercel.app)";

const channel = process.argv[2] || "logunespa";
const startId = Number(process.argv[3] || 0);
const count = Number(process.argv[4] || 20);
const delayMs = Number(process.argv[5] || 2500);
const placesOnly = process.argv[6] === "places"; // skip dated events, collect only place recs (user)

const placesPath = join(root, "data", "seed", `places-${channel}.json`);
const eventsPath = join(root, "data", "seed", `events-${channel}.json`);
const cacheDir = join(root, "data", ".cache", "tg", channel);
mkdirSync(cacheDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha1short = (s) => crypto.createHash("sha1").update(s, "utf-8").digest("hex").slice(0, 16);
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const loadArr = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : []);
const normName = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

// Fetch with on-disk cache: never re-request a post we've already pulled.
async function fetchPostCached(n) {
  const cf = join(cacheDir, `${n}.html`);
  if (existsSync(cf)) return { html: readFileSync(cf, "utf-8"), cached: true };
  const res = await fetch(`https://t.me/${channel}/${n}?embed=1`, { headers: { "User-Agent": UA } });
  if (!res.ok) return { html: null, cached: false };
  const html = await res.text();
  writeFileSync(cf, html);
  return { html, cached: false };
}

// claude -p structured extraction (subscription/OAuth, no key). Captures date + place
// + category + price etc. FOLLOWS the post's source links (claude's WebFetch) and reads
// them to enrich the record (address, hours, prices, fuller description). Emits ONLY
// JSON; we defensively extract the object.
async function extract(text, links = []) {
  const srcLinks = links.filter((u) => !/instagram\.com|facebook\.com|t\.me/.test(u)).slice(0, 3);
  const prompt = [
    "Извлеки структурированные данные из поста русскоязычного телеграм-канала про Валенсию (Испания).",
    srcLinks.length
      ? `В посте есть ссылки-источники: ${srcLinks.join(" , ")}. ОТКРОЙ их (WebFetch) и прочитай содержимое, чтобы дополнить запись (точный адрес, район, часы работы, цены, тип заведения, описание). Если ссылка недоступна — опирайся на текст поста.`
      : "",
    'Верни ТОЛЬКО JSON без markdown: {"kind":"place"|"event"|"none","name":str|null,"area":str|null,"address":str|null,"category":str|null,"description_ru":str|null,"start_date":"YYYY-MM-DD"|null,"price":str|null}.',
    'kind="place" — рекомендация заведения/локации (ресторан, кафе, бар, музей, парк, пляж, магазин);',
    'kind="event" — конкретное мероприятие с датой (концерт, фестиваль, выставка, шоу);',
    'kind="none" — новость/мнение/без конкретного места или события.',
    "name — название; area — район/город; address — точный адрес (можно из открытой ссылки); category — тип; start_date — дата мероприятия если указана (иначе null); price — цена/диапазон если есть; description_ru — 1–2 предложения, дополни деталями из источника.",
    "ПОСТ:",
    text.slice(0, 4000),
  ].join("\n");
  try {
    // longer timeout: WebFetch of source links adds latency
    const { stdout } = await execFileP("claude", ["-p", prompt], { timeout: 240000, maxBuffer: 8 * 1024 * 1024 });
    const m = stdout.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch {
    return null;
  }
}

function placeRecord(post, ex) {
  const name = (ex.name || "").trim();
  const area = (ex.area || "").trim() || null;
  return {
    id: 21000 + (post.post_id || 0),
    dedup_hash: sha1short(`tg:${channel}|place|${name}|${area || ""}`),
    name, description: ex.description_ru || null, category: ex.category || null,
    area, district: null, address: ex.address || (area ? `${area}, Valencia` : null),
    city: "Valencia", country: "Spain", lat: null, lng: null, geo_source: null,
    price_level: ex.price || null, occasion: null, recommended_by: channel,
    source: `tg:${channel}`, source_url: `https://t.me/${channel}/${post.post_id}`,
    url: post.links[0] || null, maps_url: post.maps_url, image_url: post.photos[0] || null,
    rating: null, notes: null, external_ref: String(post.post_id), source_item_id: null,
    tags_json: JSON.stringify([...post.hashtags, "from:" + channel].slice(0, 12)),
    metadata_json: JSON.stringify({ post_id: post.post_id, crawl: channel }),
    first_seen: nowIso(), last_seen: nowIso(),
  };
}

function eventRecord(post, ex) {
  const title = (ex.name || "").trim();
  return {
    id: 23000 + (post.post_id || 0),
    dedup_hash: sha1short(`tg:${channel}|event|${title}|${ex.start_date || ""}`),
    title, description: ex.description_ru || null, category: ex.category || null,
    language: "ru", audience: null, start_date: ex.start_date || null, end_date: null,
    start_time: null, end_time: null, timezone: "Europe/Madrid",
    venue_name: (ex.name && ex.area) ? ex.name : null, district: null,
    address: ex.address || (ex.area ? `${ex.area}, Valencia` : null), city: "Valencia", country: "Spain",
    lat: null, lng: null, geo_source: null, location_notes: ex.area || null,
    price: ex.price || null, is_free: null, url: post.links[0] || null, venue_url: null,
    image_url: post.photos[0] || null, external_ref: String(post.post_id),
    source: `tg:${channel}`, source_url: `https://t.me/${channel}/${post.post_id}`,
    raw_excerpt: (post.text || "").slice(0, 500), source_item_id: null,
    tags_json: JSON.stringify([...post.hashtags, "from:" + channel].slice(0, 12)),
    metadata_json: JSON.stringify({ post_id: post.post_id, crawl: channel }),
    title_ru: null, description_ru: ex.description_ru || null, links_json: null,
    enrichment_json: null, enriched_at: null, status: "upcoming", score: null,
    first_seen: nowIso(), last_seen: nowIso(),
  };
}

const places = loadArr(placesPath);
const events = loadArr(eventsPath);
const seenPosts = new Set([...places, ...events].map((r) => Number(JSON.parse(r.metadata_json || "{}").post_id)).filter(Boolean));
const placeKeys = new Set(places.map((p) => p.dedup_hash));
const seenPlaceNames = new Set(places.map((p) => normName(p.name))); // dedup a venue by name regardless of area phrasing
const eventKeys = new Set(events.map((e) => e.dedup_hash));
const lowest = seenPosts.size ? Math.min(...seenPosts) : startId + 1;
const begin = startId || lowest - 1;

let scanned = 0, addedPlaces = 0, addedEvents = 0, fetched = 0;
for (let n = begin; n > begin - count && n > 0; n--) {
  if (seenPosts.has(n)) continue;
  scanned++;
  const { html, cached } = await fetchPostCached(n);
  if (!cached) fetched++;
  if (html) {
    const post = parseTelegramPost(html);
    post.post_id = post.post_id || n;
    if (post.text && (post.photos.length || post.maps_url)) {
      const ex = await extract(post.text, post.links);
      if (ex && ex.name) {
        if (ex.kind === "place") {
          const rec = placeRecord(post, ex);
          const nm = normName(rec.name);
          if (!placeKeys.has(rec.dedup_hash) && nm && !seenPlaceNames.has(nm)) { places.push(rec); placeKeys.add(rec.dedup_hash); seenPlaceNames.add(nm); addedPlaces++; console.log(`  place +${n}: ${rec.name}${rec.area ? " — " + rec.area : ""}${rec.maps_url ? " 📍" : ""}`); }
        } else if (!placesOnly && ex.kind === "event") {
          const rec = eventRecord(post, ex);
          if (!eventKeys.has(rec.dedup_hash)) { events.push(rec); eventKeys.add(rec.dedup_hash); addedEvents++; console.log(`  event +${n}: ${rec.title}${ex.start_date ? " @ " + ex.start_date : ""}`); }
        }
      }
    }
    writeFileSync(placesPath, JSON.stringify(places, null, 2) + "\n");
    writeFileSync(eventsPath, JSON.stringify(events, null, 2) + "\n");
  }
  if (!cached) await sleep(delayMs); // only pace real network fetches
}
console.log(JSON.stringify({ ok: true, channel, from: begin, scanned, fetched, addedPlaces, addedEvents, places: places.length, events: events.length }, null, 2));
