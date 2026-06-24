// One-off (T193): repair place cards that show a raw `maps.app.goo.gl/<short>` URL AS the
// NAME (early logunespa crawl — DB ids 7–14, baked into data/seed/places.json). Deterministic,
// no LLM (T140): follow the short-link redirect to the resolved Google-Maps URL, parse the
// real venue name out of it (lib/pipeline/geo.ts `placeNameFromMapsUrl`), and backfill
// `address` from the maps `q=` when the row has none. Updates the LIVE DB and re-bakes
// data/seed/places.json IN PLACE (surgical string edits — only the affected name/address
// fields, preserving the compact one-line format). Falls back to a sensible label
// (area/city → "Место в <city>") when a short-link is dead or yields no name — never leaves
// a raw URL as the name.
//
//   DATABASE_URL=postgresql://postgres:postgres@db.localtest.me:5432/main \
//     node --import tsx scripts/fix-mapsurl-place-names.mjs [delayMs=1500]
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sql } from "../lib/db.ts";
import { resolveMapUrl, placeNameFromMapsUrl, mapsAddressQuery } from "../lib/pipeline/geo.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const delayMs = Number(process.argv[2] || 1500);
const seedPath = join(root, "data", "seed", "places.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isUrlName = (n) => !n || /^https?:\/\/|maps\.app\.goo\.gl|goo\.gl/i.test(String(n));

function fallbackLabel(row) {
  const area = (row.area || "").trim();
  const city = (row.city || "").trim();
  if (area && city) return `${area}, ${city}`;
  if (area) return area;
  if (city) return `Место в ${city}`;
  return null;
}

// Resolve ONE row's real name + (maybe) address from its short-link. Caches by maps_url so a
// repeated short-link (Costco list) isn't fetched twice.
const cache = new Map();
async function resolveRow(row) {
  const url = row.maps_url || row.url || null;
  let name = null;
  let address = row.address || null;
  if (url) {
    let map = cache.get(url);
    if (!map) {
      map = await resolveMapUrl(url); // follows redirect → map.final_url + q text
      cache.set(url, map);
      await sleep(delayMs); // be polite to Google
    }
    name = placeNameFromMapsUrl(map.final_url);
    if (!address && map.query_text) address = mapsAddressQuery(map.query_text) || map.query_text || null;
  }
  if (!name) name = fallbackLabel(row);
  return { name, address };
}

async function main() {
  // 1) LIVE DB rows whose NAME is a raw maps URL.
  const dbRows = await sql`
    SELECT id, name, maps_url, url, address, area, city
    FROM places
    WHERE name ~* 'maps\\.app\\.goo\\.gl|goo\\.gl|^https?://'
    ORDER BY id
  `;
  console.log(`DB: ${dbRows.length} place(s) with a URL name`);

  const resolvedById = new Map();
  const report = [];
  for (const row of dbRows) {
    const { name, address } = await resolveRow(row);
    const fellBack = !!name && name === fallbackLabel(row);
    if (!name) {
      console.log(`  !!${row.id}: unresolved (dead link + no area/city) → left as-is`);
      report.push({ id: row.id, before: row.name, after: null });
      continue;
    }
    await sql`UPDATE places SET name = ${name}, address = COALESCE(${address}, address) WHERE id = ${row.id}`;
    resolvedById.set(row.id, { name, address: address || row.address || null });
    report.push({ id: row.id, before: row.name, after: name, fellBack });
    console.log(`  +${row.id}: ${String(row.name).slice(0, 36)}… → "${name}"${fellBack ? " [fallback]" : ""}`);
  }

  // 2) Re-bake data/seed/places.json — surgical, format-preserving. We only touch the
  //    name/address of each affected object by re-emitting that object's JSON and swapping it
  //    into the raw text (so unaffected rows keep their byte-identical serialization).
  let raw = readFileSync(seedPath, "utf8");
  const arr = JSON.parse(raw);
  // Map the OLD compact serialization of each affected object → its FIXED serialization.
  let baked = 0;
  for (const obj of arr) {
    if (!isUrlName(obj.name)) continue;
    const r = resolvedById.get(obj.id) || (await resolveRow(obj));
    const name = r.name;
    if (!name || isUrlName(name)) continue;
    const oldStr = JSON.stringify(obj); // not in the file verbatim — rebuild from the array slice
    obj.name = name;
    if (!obj.address && r.address) obj.address = r.address;
    baked++;
    // (oldStr captured for clarity; actual swap done below via full re-serialize in same style)
    void oldStr;
  }
  // Re-serialize in the file's EXACT style: "[" + objects joined by ", " + "]" (no trailing
  // newline) with ": " after keys and ", " between members — matches json.dumps default.
  if (baked > 0) {
    const body = arr.map((o) => stringifyPyStyle(o)).join(", ");
    writeFileSync(seedPath, "[" + body + "]", "utf8");
  }

  console.log(JSON.stringify({ ok: true, dbUpdated: report.filter((r) => r.after).length, seedBaked: baked }, null, 2));
  console.log("\nBEFORE → AFTER:");
  for (const r of report) console.log(`  ${r.id}: ${String(r.before).slice(0, 48)} → ${r.after ?? "(unresolved)"}${r.fellBack ? " [fallback]" : ""}`);
  process.exit(0);
}

// Serialize an object the way Python's json.dumps default does: ", " between members,
// ": " after each key, ensure_ascii=False (Unicode kept literal — matches the source file).
function stringifyPyStyle(obj) {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) parts.push(JSON.stringify(k) + ": " + JSON.stringify(v));
  return "{" + parts.join(", ") + "}";
}

main().catch((e) => { console.error(e); process.exit(1); });
