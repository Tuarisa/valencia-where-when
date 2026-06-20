// Local Docker dev shim for @neondatabase/serverless (sub-area H, research H2).
//
// Routes the Neon HTTP driver to the local proxy (docker-compose.yml) when
// DATABASE_URL targets the local stack. Gated ONLY on the host substring
// 'db.localtest.me' — NEVER on NODE_ENV — so production neon() paths are
// untouched (constitution VI) and no query site needs rewriting.
import { neonConfig } from "@neondatabase/serverless";

export function applyLocalNeonConfig(url = process.env.DATABASE_URL) {
  if (!url || !url.includes("db.localtest.me")) return false;
  neonConfig.fetchEndpoint = (host) => `http://${host}:4444/sql`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.poolQueryViaFetch = true;
  return true;
}
