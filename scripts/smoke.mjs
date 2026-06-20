#!/usr/bin/env node
// Post-deploy smoke check (sub-area I, T138). GETs the public surfaces of a deployed
// (or local) Valencia Radar and asserts each is reachable, returns HTTP 200, and has a
// non-empty body; the /api/health JSON must also report ok=true. Exits non-zero on the
// first failure so it can gate a deploy step.
//
//   npm run smoke                       # → http://localhost:3000
//   APP_BASE_URL=https://… npm run smoke
//
// No dependencies (uses global fetch, Node ≥20). Read-only — it never mutates anything.

const BASE = (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 20000);

// Each check: a path, whether to parse + assert health ok, and a label.
const checks = [
  { path: "/", label: "home feed" },
  { path: "/places", label: "places catalog" },
  { path: "/api/health", label: "health endpoint", health: true },
];

async function getWithTimeout(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    const body = await res.text();
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function runCheck(check) {
  const url = `${BASE}${check.path}`;
  let status, body;
  try {
    ({ status, body } = await getWithTimeout(url));
  } catch (err) {
    return { ...check, url, pass: false, detail: `fetch failed: ${err?.message || err}` };
  }

  if (status !== 200) {
    return { ...check, url, pass: false, detail: `HTTP ${status}` };
  }
  if (!body || body.trim().length === 0) {
    return { ...check, url, pass: false, detail: "empty body" };
  }
  if (check.health) {
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      return { ...check, url, pass: false, detail: "health body is not JSON" };
    }
    if (json.ok !== true) {
      const warns = Array.isArray(json.warnings) ? json.warnings.join("; ") : "";
      return { ...check, url, pass: false, detail: `health ok=${json.ok}${warns ? ` — ${warns}` : ""}` };
    }
    return { ...check, url, pass: true, detail: `200, ok=true (${json.counts?.events_upcoming ?? "?"} upcoming events)` };
  }
  return { ...check, url, pass: true, detail: `200, ${body.length} bytes` };
}

async function main() {
  console.log(`smoke: base = ${BASE}`);
  const results = [];
  for (const check of checks) {
    const r = await runCheck(check);
    results.push(r);
    const mark = r.pass ? "PASS" : "FAIL";
    console.log(`  [${mark}] ${check.label.padEnd(16)} ${check.path}  —  ${r.detail}`);
  }
  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.error(`smoke: ${failed.length}/${results.length} checks FAILED`);
    process.exit(1);
  }
  console.log(`smoke: all ${results.length} checks passed`);
}

main().catch((err) => {
  console.error(`smoke: unexpected error — ${err?.message || err}`);
  process.exit(1);
});
