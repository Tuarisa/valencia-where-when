// Load the migrated data (data/seed/*.json) into the Postgres database.
// Idempotent: rows are inserted by primary key, conflicts are skipped.
// Usage: DATABASE_URL=... node scripts/seed.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { neon } from "@neondatabase/serverless";
import { applyLocalNeonConfig } from "./_neon-local.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
applyLocalNeonConfig(url);
const sql = neon(url);
const seedDir = join(__dirname, "..", "data", "seed");

function load(name) {
  return JSON.parse(readFileSync(join(seedDir, name), "utf-8"));
}

async function insertRows(table, rows) {
  if (!rows.length) return 0;
  const cols = Object.keys(rows[0]);
  const colList = cols.map((c) => `"${c}"`).join(", ");
  let inserted = 0;
  for (const row of rows) {
    const values = cols.map((c) => (row[c] === undefined ? null : row[c]));
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    const text = `INSERT INTO ${table} (${colList}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`;
    await sql(text, values);
    inserted++;
  }
  // Keep the SERIAL sequence ahead of the imported ids.
  await sql(
    `SELECT setval(pg_get_serial_sequence('${table}', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM ${table}), 1))`,
  );
  return inserted;
}

const order = [
  ["sources", "sources.json"],
  ["events", "events.json"],
  ["events", "events-feria-julio-2026.json"], // one-off: Feria de Julio 2026 curated highlights
  ["places", "places.json"],
  ["media_assets", "media_assets.json"],
];

const summary = {};
for (const [table, file] of order) {
  const rows = load(file);
  // Accumulate: several files (e.g. events.json + events-feria-julio-2026.json)
  // load into the same table, so don't let the later one clobber the count.
  summary[table] = (summary[table] || 0) + (await insertRows(table, rows));
}
console.log(JSON.stringify({ ok: true, inserted: summary }, null, 2));
