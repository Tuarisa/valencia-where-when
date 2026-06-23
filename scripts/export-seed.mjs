// Export the LIVE DB's normalized/enriched rows back into the data/seed/*.json
// format, so real local data can later be BAKED into the seed and prod ships
// pre-populated. (T144 part 1.)
//
// READ-ONLY: this tool issues SELECT statements only. It never writes to the DB.
//
// SCHEMA-DRIVEN COLUMNS (T182, F3): the per-table column list is derived from the
// LIVE schema (information_schema.columns), NOT hardcoded. This project does
// additive schema changes often; a hardcoded list silently dropped any newly
// ADDed column from the baked prod seed with no error. Now a new column is
// exported by default. Server-only/runtime-state columns are removed via an
// explicit, documented EXCLUDE map (EXPORT_EXCLUDES in scripts/_seed-schema.mjs).
//
// Round-trip contract (mirror of scripts/seed.mjs):
//   export -> <outdir>/*.json -> copy into data/seed/ -> `npm run db:setup`
//   reproduces the data. We emit the SAME filenames + a column set the loader
//   accepts (one INSERT per file, columns = Object.keys(rows[0])).
//
//   - sources.json        BASE source columns only (the cadence/etag/fail-count
//                         state is re-seeded by seed.mjs::seedCadence, so it's in
//                         EXPORT_EXCLUDES and deliberately omitted).
//   - events.json         all event columns incl. enriched/score/tags/links.
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
import { resolveExportColumns, shape } from "./_seed-schema.mjs";

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

// --- table -> file map ------------------------------------------------------
// The COLUMN list per table is no longer hardcoded here — it's resolved off the
// live schema via resolveExportColumns() (full set minus EXPORT_EXCLUDES), so an
// additive ALTER TABLE can't silently drop a new column from the baked seed.
// event_series / event_occurrences are NOT exported (re-derived by
// db:migrate:series). The loader is column-agnostic; ORDER BY id keeps diffs
// stable.
const EXPORTS = [
  { file: "sources.json", table: "sources" },
  { file: "events.json", table: "events" },
  { file: "places.json", table: "places" },
  { file: "media_assets.json", table: "media_assets" },
];

async function run() {
  mkdirSync(outDir, { recursive: true });
  if (clobbersSeed) {
    console.warn("⚠ --out targets data/seed — this OVERWRITES the curated seed.");
  }
  const summary = {};
  const columnCounts = {};
  for (const { file, table } of EXPORTS) {
    // SCHEMA-DRIVEN: derive the column list from the live schema (minus excludes).
    const cols = await resolveExportColumns(sql, table);
    columnCounts[table] = cols.length;
    // Drift visibility: log the per-table column count so a missing/added col shows.
    console.log(`  ${table}: ${cols.length} columns -> ${file}`);
    const colList = cols.map((c) => `"${c}"`).join(", ");
    // READ-ONLY. ORDER BY id -> deterministic row order for clean diffs.
    const rows = await sql(`SELECT ${colList} FROM ${table} ORDER BY id ASC`);
    const shaped = rows.map((r) => shape(r, cols));
    const path = join(outDir, file);
    writeFileSync(path, JSON.stringify(shaped, null, 2) + "\n", "utf-8");
    summary[file] = shaped.length;
  }
  console.log(
    JSON.stringify({ ok: true, out: outDir, rows: summary, columns: columnCounts }, null, 2),
  );
}

run().catch((err) => {
  console.error("export-seed failed:", err?.message || err);
  process.exit(1);
});
