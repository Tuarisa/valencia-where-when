import { neon, neonConfig } from "@neondatabase/serverless";

neonConfig.fetchConnectionCache = true;

const url = process.env.DATABASE_URL;
// Local Docker dev: route the Neon HTTP driver to the local proxy when
// DATABASE_URL targets the local stack. Gated on the host substring
// 'db.localtest.me' (NEVER on NODE_ENV) so production paths are untouched.
if (url && url.includes("db.localtest.me")) {
  neonConfig.fetchEndpoint = (host: string) => `http://${host}:4444/sql`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.poolQueryViaFetch = true;
}
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
