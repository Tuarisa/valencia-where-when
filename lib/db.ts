import { neon, neonConfig } from "@neondatabase/serverless";

neonConfig.fetchConnectionCache = true;

const url = process.env.DATABASE_URL;
if (!url) {
  // Surfaced at runtime in server components / route handlers.
  console.warn("DATABASE_URL is not set — database queries will fail.");
}

// Tagged-template SQL client. Usage: await sql`SELECT * FROM events`
// The placeholder is format-valid so the client can be constructed at build
// time without a real connection; actual queries require a real DATABASE_URL.
export const sql = neon(url || "postgresql://user:password@localhost/placeholder");

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}
