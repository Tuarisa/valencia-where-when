// One-off (resumable) seed geo-baking (T135 PART 1): resolve coordinates for crawled
// places and persist them INTO the seed JSON, so the map renders deterministically on a
// fresh deploy WITHOUT a slow Nominatim pass at db:setup time. Deterministic — no claude -p.
//
//   node --import tsx scripts/bake-place-geo.mjs [channel=logunespa] [delayMs=1100]
//
// Reuses lib/pipeline/geo.ts `resolvePlaceGeo` so the resolution logic NEVER drifts from
// the live pipeline (follow maps_url → direct coords, else Nominatim on the maps `q=`
// address first, then name/address composites). Idempotent: skips places that already
// have lat/lng. Writes after EACH place (crash-safe / resumable). Also backfills `address`
// from the maps `q=` text when the crawl left it null. Paces Nominatim by delayMs.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolvePlaceGeo } from "../lib/pipeline/geo.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const channel = process.argv[2] || "logunespa";
const delayMs = Number(process.argv[3] || 1100);
const path = join(root, "data", "seed", `places-${channel}.json`);
if (!existsSync(path)) {
  console.error("no seed file:", path);
  process.exit(1);
}
const places = JSON.parse(readFileSync(path, "utf8"));

let resolved = 0,
  skipped = 0,
  failed = 0;
for (const p of places) {
  if (p.lat != null && p.lng != null) {
    skipped++;
    continue;
  }
  if (!p.maps_url && !p.address && !p.name) {
    failed++;
    continue;
  }
  const g = await resolvePlaceGeo(p, delayMs);
  if (g.lat != null && g.lng != null) {
    p.lat = g.lat;
    p.lng = g.lng;
    p.geo_source = g.geo_source;
    if (!p.address && g.mapsQuery) p.address = g.mapsQuery;
    resolved++;
    console.log(`  geo +${p.id}: ${String(p.name || "?").slice(0, 42)} → ${g.lat.toFixed(5)},${g.lng.toFixed(5)} (${g.geo_source})`);
  } else {
    failed++;
    console.log(`  geo --${p.id}: ${String(p.name || "?").slice(0, 42)} unresolved`);
  }
  writeFileSync(path, JSON.stringify(places, null, 2) + "\n"); // incremental → resumable
}
const withGeo = places.filter((x) => x.lat != null && x.lng != null).length;
console.log(JSON.stringify({ ok: true, channel, total: places.length, resolved, skipped, failed, withGeo }, null, 2));
