// Apply db/schema.sql to the Neon/Postgres database in DATABASE_URL.
// Usage: DATABASE_URL=... node scripts/apply-schema.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { neon } from "@neondatabase/serverless";

const __dirname = dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Add it to .env.local or export it.");
  process.exit(1);
}
const sql = neon(url);
const schema = readFileSync(join(__dirname, "..", "db", "schema.sql"), "utf-8");

// Split on statement boundaries (no functions/dollar-quotes in this schema).
const statements = schema
  .split(/;\s*\n/)
  .map((s) => s.trim())
  .filter((s) => s && !s.startsWith("--"));

let applied = 0;
for (const stmt of statements) {
  await sql.query(stmt);
  applied++;
}
console.log(JSON.stringify({ ok: true, statements: applied }, null, 2));
