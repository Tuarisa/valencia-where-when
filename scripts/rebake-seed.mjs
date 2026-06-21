// Re-bake the prod seed `data/seed/events.json` via a CURATED MERGE so it picks
// up the live local-DB fixes (dedup, corrected dates/cities, lacotorra hybrid
// filter, exposition end_dates) WITHOUT regressing the Hemisfèric series or
// reintroducing null-date rows. (T173.)
//
// A naive `export-seed --commit` REGRESSES the seed: it would (a) drop the 104
// `api:hemisferic` rows (in the live DB those rows have been migrated away into
// event_series/event_occurrences, so they no longer export cleanly), losing the
// 11 Hemisfèric series, and (b) potentially export curated-source rows that live
// in SEPARATE files (events-feria-julio-2026.json / events-logunespa.json / the
// 2 curated DroneArt rows in events-fever.json), colliding on id.
//
// THE CORRECT MERGE = concat of:
//   (1) DERIVED events from the live main DB:
//         source <> 'api:hemisferic'
//         AND status = 'upcoming'      (excludes 'duplicate'/'filtered')
//         AND start_date IS NOT NULL   (0 null dates)
//         AND id >= 25000              (excludes curated low-id rows that belong
//                                       to the separate curated files — feria
//                                       1001-1043, logunespa 24737-24796, the 2
//                                       DroneArt rows 1101-1102; the live derived
//                                       id range starts at 25171)
//       This set already reflects dedup, corrected dates/cities, the lacotorra
//       hybrid filter, and exposition end_dates.
//   (2) The 104 `api:hemisferic` rows taken VERBATIM from the CURRENT
//       data/seed/events.json (ids ~193-296), preserved unchanged so
//       db:migrate:series still yields 11 series + 104 occurrences.
//
// Output defaults to data/seed-rebake/ (scratch); pass `--commit` (or
// `--out data/seed`) to write the real seed. READ-ONLY on the DB (SELECT only).
//
// Usage:
//   DATABASE_URL=postgresql://postgres:postgres@db.localtest.me:5432/main \
//     node --import tsx scripts/rebake-seed.mjs [--out <dir>] [--commit]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  let out = "data/seed-rebake";
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

// Column set MUST mirror scripts/export-seed.mjs events.json contract so the row
// shape matches what scripts/seed.mjs loads.
const EVENT_COLS = [
  "id", "dedup_hash", "title", "description", "category", "language",
  "audience", "start_date", "end_date", "start_time", "end_time",
  "timezone", "venue_name", "district", "address", "city", "country",
  "lat", "lng", "geo_source", "location_notes", "price", "is_free", "url",
  "venue_url", "image_url", "external_ref", "source", "source_url",
  "raw_excerpt", "source_item_id", "tags_json", "metadata_json", "title_ru",
  "description_ru", "links_json", "enrichment_json", "enriched_at",
  "status", "score", "first_seen", "last_seen", "notified", "notified_at",
];

// Floor for "derived" ids; curated low-id rows (feria/logunespa/DroneArt) live in
// separate files and must NOT be duplicated into events.json.
const DERIVED_ID_FLOOR = 25000;

function shape(row, cols) {
  const o = {};
  for (const c of cols) o[c] = row[c] === undefined ? null : row[c];
  return o;
}

async function run() {
  mkdirSync(outDir, { recursive: true });
  if (clobbersSeed) {
    console.warn("⚠ --commit/--out data/seed — this OVERWRITES the curated seed events.json.");
  }

  // (1) DERIVED events from the live DB. READ-ONLY. ORDER BY id → stable diffs.
  const colList = EVENT_COLS.map((c) => `"${c}"`).join(", ");
  const derived = await sql(
    `SELECT ${colList} FROM events
       WHERE source <> 'api:hemisferic'
         AND status = 'upcoming'
         AND start_date IS NOT NULL
         AND id >= ${DERIVED_ID_FLOOR}
       ORDER BY id ASC`,
  );
  const derivedShaped = derived.map((r) => shape(r, EVENT_COLS));

  // (2) The 104 api:hemisferic rows VERBATIM from the current seed file.
  const currentSeedPath = join(repoRoot, "data", "seed", "events.json");
  const currentSeed = JSON.parse(readFileSync(currentSeedPath, "utf-8"));
  const hemisferic = currentSeed.filter((e) => e.source === "api:hemisferic");

  // --- merge + integrity guards ---------------------------------------------
  const merged = [...derivedShaped, ...hemisferic];

  // Guard: no id collisions.
  const ids = merged.map((e) => e.id);
  const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupIds.length) {
    console.error("id collision in merged set:", [...new Set(dupIds)]);
    process.exit(1);
  }
  // Guard: 0 null start_date.
  const nullDates = merged.filter((e) => !e.start_date).length;
  if (nullDates) {
    console.error(`merged set has ${nullDates} null start_date rows — aborting.`);
    process.exit(1);
  }
  // Guard: exactly 104 hemisferic (else series count would change).
  if (hemisferic.length !== 104) {
    console.error(
      `expected 104 api:hemisferic rows in current seed, found ${hemisferic.length} — aborting.`,
    );
    process.exit(1);
  }

  const path = join(outDir, "events.json");
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", "utf-8");

  console.log(
    JSON.stringify(
      {
        ok: true,
        out: path,
        total: merged.length,
        derived: derivedShaped.length,
        hemisferic: hemisferic.length,
        nullDates,
      },
      null,
      2,
    ),
  );
}

run().catch((err) => {
  console.error("rebake-seed failed:", err?.message || err);
  process.exit(1);
});
