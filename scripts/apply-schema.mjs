// Apply db/schema.sql to the Neon/Postgres database in DATABASE_URL.
// Usage: DATABASE_URL=... node scripts/apply-schema.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { neon } from "@neondatabase/serverless";
import { applyLocalNeonConfig } from "./_neon-local.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Add it to .env.local or export it.");
  process.exit(1);
}
applyLocalNeonConfig(url);
const sql = neon(url);
const schema = readFileSync(join(__dirname, "..", "db", "schema.sql"), "utf-8");

// Strip full-line `--` comments FIRST so a leading comment block doesn't drag
// the CREATE that follows it into a comment-prefixed chunk (which would then be
// dropped — that silently lost the `sources` table). Inline `--` comments inside
// a statement are preserved (Postgres parses them fine). No functions/dollar-quotes.
const statements = schema
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .split(/;\s*\n/)
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

let applied = 0;
for (const stmt of statements) {
  // @neondatabase/serverless 0.10.x has no sql.query(); the function-call form
  // sql(text, params?) runs a raw/parameterized statement and returns rows.
  await sql(stmt);
  applied++;
}
console.log(JSON.stringify({ ok: true, statements: applied }, null, 2));
