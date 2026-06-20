// Export the LIVE DB's normalized/enriched rows back into the data/seed/*.json
// format, so real local data can later be BAKED into the seed and prod ships
// pre-populated. (T144 part 1.)
//
// READ-ONLY: this tool issues SELECT statements only. It never writes to the DB.
//
// Round-trip contract (mirror of scripts/seed.mjs):
//   export → <outdir>/*.json → copy into data/seed/ → `npm run db:setup`
//   reproduces the data. We emit the SAME filenames + the SAME column sets the
//   loader expects (one INSERT per file, columns = Object.keys(rows[0])).
//
//   - sources.json        BASE source columns only (cadence cols are re-seeded
//                         by seed.mjs::seedCadence, so we deliberately omit them).
//   - events.json         all 44 event columns incl. enriched/score/tags/links.
//   - places.json         all place columns INCL. the enrich/notify cols — the
//                         whole point of baking is to ship enriched places.
//   - media_assets.json   as-is.
//   event_series / event_occurrences are NOT exported: they are re-derived from
//   the api:hemisferic events by `npm run db:migrate:series` during db:setup.
//
// Output defaults to data/seed-export/ (scratch) so the curated data/seed/ is
// never clobbered. Pass `--out data/seed` (or `--commit`) to target the real seed.
//
// Usage:
//   DATABASE_URL=postgresql://postgres:postgres@db.localtest.me:5432/main \
//     node --import tsx scripts/export-seed.mjs [--out <dir>]

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute } from "node:path";
import { sql } from "../lib/db.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

// --- args -------------------------------------------------------------------
function parseArgs(argv) {
  let out = "data/seed-export";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out = argv[++i];
    else if (a.startsWith("--out=")) out = a.slice("--out=".length);
    else if (a === "--commit") out = "data/seed"; // explicit opt-in to clobber curated seed
  }
  return { out };
}
const { out } = parseArgs(process.argv.slice(2));
const outDir = isAbsolute(out) ? out : join(repoRoot, out);
const clobbersSeed = outDir === join(repoRoot, "data", "seed");

// --- column contracts (mirror data/seed/*.json key sets) --------------------
// Listed in schema order; the loader is column-agnostic but stable order keeps
// JSON diffs clean. ORDER BY id gives deterministic row order.
const EXPORTS = [
  {
    file: "sources.json",
    table: "sources",
    // BASE columns only — cadence/etag/fail_count are re-seeded by seed.mjs.
    cols: [
      "id", "key", "name", "type", "url", "lang", "enabled", "weight",
      "last_fetched", "notes",
    ],
  },
  {
    file: "events.json",
    table: "events",
    cols: [
      "id", "dedup_hash", "title", "description", "category", "language",
      "audience", "start_date", "end_date", "start_time", "end_time",
      "timezone", "venue_name", "district", "address", "city", "country",
      "lat", "lng", "geo_source", "location_notes", "price", "is_free", "url",
      "venue_url", "image_url", "external_ref", "source", "source_url",
      "raw_excerpt", "source_item_id", "tags_json", "metadata_json", "title_ru",
      "description_ru", "links_json", "enrichment_json", "enriched_at",
      "status", "score", "first_seen", "last_seen", "notified", "notified_at",
    ],
  },
  {
    file: "places.json",
    table: "places",
    // FULL set incl. enrich/notify cols (curated places.json omits them, but
    // baking enriched places is the whole point; extra valid cols load fine).
    cols: [
      "id", "dedup_hash", "name", "description", "category", "area", "district",
      "address", "city", "country", "lat", "lng", "geo_source",
      "location_notes", "price_level", "occasion", "recommended_by", "source",
      "source_url", "url", "maps_url", "image_url", "rating", "notes",
      "external_ref", "source_item_id", "tags_json", "metadata_json",
      "title_ru", "description_ru", "links_json", "enrichment_json",
      "enriched_at", "notified", "notified_at", "first_seen", "last_seen",
    ],
  },
  {
    file: "media_assets.json",
    table: "media_assets",
    cols: [
      "id", "entity_type", "entity_id", "source_item_id", "url", "mime_type",
      "width", "height", "caption", "credit", "sort_order", "is_primary",
      "created_at",
    ],
  },
];

// Build an ordered, stable-keyed object from a DB row.
function shape(row, cols) {
  const o = {};
  for (const c of cols) o[c] = row[c] === undefined ? null : row[c];
  return o;
}

async function run() {
  mkdirSync(outDir, { recursive: true });
  if (clobbersSeed) {
    console.warn("⚠ --out targets data/seed — this OVERWRITES the curated seed.");
  }
  const summary = {};
  for (const { file, table, cols } of EXPORTS) {
    const colList = cols.map((c) => `"${c}"`).join(", ");
    // READ-ONLY. ORDER BY id → deterministic row order for clean diffs.
    const rows = await sql(`SELECT ${colList} FROM ${table} ORDER BY id ASC`);
    const shaped = rows.map((r) => shape(r, cols));
    const path = join(outDir, file);
    writeFileSync(path, JSON.stringify(shaped, null, 2) + "\n", "utf-8");
    summary[file] = shaped.length;
  }
  console.log(JSON.stringify({ ok: true, out: outDir, rows: summary }, null, 2));
}

run().catch((err) => {
  console.error("export-seed failed:", err?.message || err);
  process.exit(1);
});
