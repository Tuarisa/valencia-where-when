// Load the migrated data (data/seed/*.json) into the Postgres database.
// Idempotent: rows are inserted by primary key, conflicts are skipped.
// Usage: DATABASE_URL=... node scripts/seed.mjs
import { readFileSync, existsSync } from "node:fs";
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
  // Optional crawl-output files (places-*/events-*) may be absent on a fresh checkout.
  const p = join(seedDir, name);
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, "utf-8"));
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

// Per-type adaptive-cadence defaults (T014; mirrors lib/pipeline/cadence.ts
// cadenceDefaults). telegram 10m–3h, web 1h–24h, ticketing/api 2h–24h.
function cadenceDefaults(type) {
  if (type === "telegram") return { min: 600, max: 10800 };
  if (type === "ticketing" || type === "api") return { min: 7200, max: 86400 };
  return { min: 3600, max: 86400 }; // web + fallback
}

// Seed cadence so the first dispatch picks every enabled source up (next_due_at=now)
// and starts polling at the per-type floor. IDEMPOTENT: COALESCE keeps any non-null
// value already on the row, so a re-seed never clobbers adapted cadence state.
async function seedCadence() {
  const sources = await sql(`SELECT key, type FROM sources`);
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  let touched = 0;
  for (const s of sources) {
    const { min, max } = cadenceDefaults(s.type);
    await sql(
      `UPDATE sources SET
         min_interval_sec  = COALESCE(min_interval_sec, $1),
         max_interval_sec  = COALESCE(max_interval_sec, $2),
         poll_interval_sec = COALESCE(poll_interval_sec, $1),
         next_due_at       = COALESCE(next_due_at, $3)
       WHERE key = $4`,
      [min, max, now, s.key],
    );
    touched++;
  }
  return touched;
}

const order = [
  ["sources", "sources.json"],
  ["events", "events.json"],
  ["events", "events-feria-julio-2026.json"], // one-off: Feria de Julio 2026 curated highlights
  ["events", "events-fever.json"], // T132: one-off Fever DroneArt Show (drone show) dates
  ["events", "events-logunespa.json"], // T130: dated events mined from tg:logunespa posts
  ["places", "places.json"],
  ["places", "places-logunespa.json"], // T130: historical place recs crawled from tg:logunespa
  ["media_assets", "media_assets.json"],
];

const summary = {};
for (const [table, file] of order) {
  const rows = load(file);
  // Accumulate: several files (e.g. events.json + events-feria-julio-2026.json)
  // load into the same table, so don't let the later one clobber the count.
  summary[table] = (summary[table] || 0) + (await insertRows(table, rows));
}
const cadenceTouched = await seedCadence();
console.log(JSON.stringify({ ok: true, inserted: summary, cadence: cadenceTouched }, null, 2));
