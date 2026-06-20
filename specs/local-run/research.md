---
spec: local-run
phase: research
created: 2026-06-20T13:05:00Z
---

# Research: local-run

## Executive Summary

A full offline local run is feasible: stand up a **plain Dockerized Postgres + the
`local-neon-http-proxy` sidecar** so the existing `@neondatabase/serverless` driver
talks to local Postgres over the Neon HTTP protocol with **zero changes to `lib/db.ts`,
`lib/queries.ts`, or any pipeline file** — only a runtime `neonConfig.fetchEndpoint`
shim gated on the local host. This keeps the Vercel/Neon production path byte-for-byte
unchanged (constitution VI) while letting the DB, schema, seed, the offline pipeline
stages, the `claude -p` enrichment, and `next dev` all run locally before deploy.

## Key Findings

| # | Finding | Evidence (file / source) |
|---|---------|--------------------------|
| 1 | DB layer uses Neon's **HTTP/WS driver**, not TCP `pg`. `sql = neon(url)` with `neonConfig.fetchConnectionCache = true`. | `lib/db.ts:1-14` |
| 2 | App + pipeline use **tagged-template** `sql\`...\`` exclusively (8 files). Scripts use **`sql.query(text, values)`**. `neon()` supports both — any driver swap must preserve both call shapes. | `lib/queries.ts`, `lib/pipeline/*.ts`, `lib/pipeline/normalizers/hemisferic.ts`; `scripts/apply-schema.mjs:26`, `scripts/seed.mjs:31` |
| 3 | Scripts read `DATABASE_URL` from `process.env`, exit 1 if missing, and `neon(url)` directly (no `dotenv`). User must `set -a && source .env.local`. | `scripts/apply-schema.mjs:9-14`, `scripts/seed.mjs:10-15` |
| 4 | `scripts/run-pipeline.mjs` requires **`tsx`** (`register("tsx/esm")`) — **tsx is NOT installed** (absent in `node_modules`, not in `package.json` devDeps). Pipeline run currently fails locally with "Install tsx". | `scripts/run-pipeline.mjs:9-16`; `npm ls`/node_modules check |
| 5 | Pipeline stages split cleanly: **ingest** + **geo** need network; **normalize / dedup / score / tag** are pure DB+CPU (offline). | ingest uses `fetchText`/`fetchJson` (`ingest.ts:218,151`), geo uses `fetch` + Nominatim (`geo.ts:15,62`); normalize/score/tags/dedup have **no** fetch (grep clean) |
| 6 | **No digest / alert / enrich endpoints or scripts exist yet** — only `/api/cron/refresh`. The goal's "weekly digest/alert endpoints" and `claude -p` enrichment are **planned, not built**. Local-run cannot exercise them until they exist (out of this spec's scope, or a thin local harness only). | only `app/api/cron/refresh/route.ts`; grep for digest/alert/enrich/notif found nothing in `app/`, `scripts/` |
| 7 | Cron route is `GET /api/cron/refresh` guarded by `Authorization: Bearer ${CRON_SECRET}` (only when `CRON_SECRET` set). `maxDuration=300`, `force-dynamic`. | `app/api/cron/refresh/route.ts:7-15` |
| 8 | Schema is plain DDL, **no functions/dollar-quotes**, split on `;\n`. Postgres features used: `SERIAL`, `DOUBLE PRECISION`, `TEXT`, `REFERENCES`, partial-free indexes, `pg_get_serial_sequence`/`setval` in seed. All standard PG15 — works on any local Postgres. | `db/schema.sql`; `scripts/seed.mjs:35-37` |
| 9 | Local toolchain: **`claude` CLI v2.1.177 present** on PATH; **`psql`+`pg_ctl` present** (native Postgres installed); **Docker NOT installed**; **`tsx` absent**; **`pg` absent**; Node **v24.14.0**. | shell probes (`which`, `node -v`) |
| 10 | Secrets already gitignored: `.env`, `.env*.local`, `.vercel`. `.env.example` documents `DATABASE_URL` + `CRON_SECRET`. Safe to add `.env.local`. | `.gitignore`; `.env.example` |
| 11 | `next dev` reads DB through the same `lib/db.ts` → `lib/queries.ts` server components; deterministic, no request-time scraping (constitution V). So once DB is local, the site "just works". | `app/page.tsx` → `buildPayload()` in `queries.ts:185` |

## DB-Driver Decision

**DECISION: Option 1 — local Neon HTTP proxy (`TimoWilhelm/local-neon-http-proxy`) + Dockerized Postgres, selected via a runtime `neonConfig` shim gated on a local host.**

### Why this wins

- **Zero prod-path change** (constitution VI, "reversible, build-green"): production keeps
  `neon(DATABASE_URL)` and real Neon endpoints untouched. The shim only fires when
  `DATABASE_URL` host is the local proxy host — on Vercel that branch is never taken.
- **Both call shapes keep working**: the proxy speaks the Neon wire protocol, so
  `sql\`...\`` (8 files) AND `sql.query(...)` (2 scripts) work unmodified. No rewrite of
  20+ query sites.
- **Fully offline**: no Neon account, no internet, no `NEON_API_KEY`. Pure local Postgres.
- **No behavioral drift**: same driver, same SQL dialect (real Postgres behind the proxy).

### Exact shim (the ONLY code change to `lib/db.ts`)

```ts
import { neon, neonConfig } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL || "postgresql://user:password@localhost/placeholder";

// Local-only: route the Neon HTTP driver at the local proxy. No-op in prod.
if (process.env.DATABASE_URL?.includes("db.localtest.me")) {
  neonConfig.fetchEndpoint = (host) =>
    host === "db.localtest.me" ? `http://${host}:4444/sql` : `https://${host}/sql`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.poolQueryViaFetch = true;
}

neonConfig.fetchConnectionCache = true;
export const sql = neon(url);
```

Scripts (`apply-schema.mjs`, `seed.mjs`, `run-pipeline.mjs`) call `neon()` directly, so the
same gated `neonConfig` block must be added there too (3-line copy), or — cleaner — extract a
tiny `scripts/_neon.mjs` helper that all three import. Either way the prod path is unchanged.

### docker-compose shape (offline)

```yaml
services:
  db:
    image: postgres:15
    environment: { POSTGRES_USER: postgres, POSTGRES_PASSWORD: postgres, POSTGRES_DB: main }
    ports: ["5432:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 2s; timeout: 5s; retries: 10
  neon-proxy:
    image: ghcr.io/timowilhelm/local-neon-http-proxy:main
    environment: { PG_CONNECTION_STRING: "postgres://postgres:postgres@db:5432/main" }
    ports: ["4444:4444"]
    depends_on: { db: { condition: service_healthy } }
```

Local `DATABASE_URL` (in `.env.local`):
`postgresql://postgres:postgres@db.localtest.me:5432/main`
(`db.localtest.me` resolves to 127.0.0.1, so host networking reaches the mapped ports.)

### Alternatives considered

| Option | Verdict | Rationale |
|--------|---------|-----------|
| **1. local-neon-http-proxy + Docker Postgres** | **CHOSEN** | Offline, zero prod change, both call shapes work, no SQL drift. Verified to support `@neondatabase/serverless` over HTTP/WS (TimoWilhelm/local-neon-http-proxy). |
| **2. Real Neon dev branch + `.env`** | **Fallback** (documented) | Simplest (no Docker, no shim) but **not truly local** — needs internet + Neon account; not "полноценный локальный запуск". Good when Docker is unavailable. |
| **3. Driver abstraction (`pg` local / Neon prod)** | **Rejected** | `pg` has no tagged-template API → must rewrite all 8 `sql\`...\`` files + the 2 `sql.query` scripts into a compat shim; real risk of behavioral drift (param binding, return shape `rows` vs array, `setval`/sequence quirks). Violates constitution VI's "minimal, reversible". High effort, high regression surface. |
| **4. PGlite / embedded Postgres** | **Rejected (primary)** | PGlite is a WASM Postgres with its **own client API**, not the Neon wire protocol — the Neon driver cannot talk to it without an adapter, reintroducing option-3's rewrite. Viable only as a deeper future experiment, not for "run the real stack before deploy". |
| **Neon Local (`neondatabase/neon_local`)** | **Rejected** | Despite the name it is **not offline**: requires `NEON_API_KEY` + `NEON_PROJECT_ID` and proxies to **real cloud branches**. Same internet dependency as option 2 with more setup. (Neon docs confirm.) |

## Proposed Local Bring-Up Design

Goal: 1–2 commands. Two bring-up tiers depending on Docker availability.

### Tier A (recommended, offline) — Docker present

1. Add `docker-compose.yml` (above) + the `neonConfig` shim.
2. Add devDeps: `tsx` (for `run-pipeline.mjs`). `dotenv-cli` optional for ergonomics.
3. New npm scripts:
   ```jsonc
   "db:local:up":   "docker compose up -d --wait",
   "db:local:down": "docker compose down",
   "db:setup":      "node scripts/apply-schema.mjs && node scripts/seed.mjs",  // existing
   "dev:local":     "npm run db:local:up && npm run db:setup && next dev"
   ```
4. One command: `set -a && source .env.local && set +a && npm run dev:local`.
   (Or a tiny `Makefile`/`bin/dev-local.sh` that sources `.env.local` then runs the chain,
   so the user doesn't repeat the `set -a` dance.)

### Tier B (fallback) — no Docker

Use a Neon dev branch: put its pooled URL in `.env.local`, then
`source .env.local && npm run db:setup && npm run dev`. Identical app code; only difference
is the URL points at cloud and the shim no-ops. Document clearly that this needs internet.

> Note: native Postgres (`psql`/`pg_ctl` already installed) is **not** directly usable by the
> Neon driver without the proxy — so even with local Postgres, Tier A still needs the proxy
> container (or the proxy run via a non-Docker binary, which it does not ship — Docker is the
> supported path). This is the one hard dependency to surface: **Tier A requires Docker, which
> is currently not installed on this machine.** Installing Docker Desktop is the prerequisite.

## What Runs Offline vs Needs Network

| Stage / capability | Offline on seed data? | Needs network? | Notes |
|--------------------|:---------------------:|:--------------:|-------|
| `db:schema` (apply-schema) | ✅ | – | DDL only |
| `db:seed` (342 events / 22 sources / 14 places / 216 media) | ✅ | – | from `data/seed/*.json` |
| `next dev` site (feed, calendar, map, detail pages) | ✅ | map **tiles** + fonts load from CDN at browser runtime (OSM/unpkg/Google Fonts) — page renders without them | reads local DB via `queries.ts` |
| Pipeline: **normalize** | ✅ | – | pure DB+CPU (`normalize.ts`, no fetch) |
| Pipeline: **dedup** | ✅ | – | pure (in-memory + DB) |
| Pipeline: **score** | ✅ | – | pure (`score.ts`, no fetch) |
| Pipeline: **tag** | ✅ | – | pure (`tags.ts`, no fetch) |
| Pipeline: **ingest** | ❌ | ✅ | fetches `t.me/s/`, web pages, CACSA Hemisfèric API (`ingest.ts`) |
| Pipeline: **geo** | ❌ | ✅ | resolves map URLs + Nominatim (`geo.ts`); honor ~1.1s rate-limit (constitution) |
| `claude -p` enrichment | ✅ (CLI local) | ✅ (Anthropic API auth at call time) | CLI present (v2.1.177); needs working `claude` auth. **No enrichment script exists yet to invoke it.** |
| Weekly digest / alert endpoints | n/a | n/a | **Not implemented.** Cannot be run locally until built. |

Practical consequence: a meaningful **offline** local verification = `db:setup` →
run normalize/dedup/score/tag against the **seeded** rows → `next dev` and eyeball the site.
A **full** pipeline run (`pipeline:run` or hitting `/api/cron/refresh`) exercises ingest+geo and
**requires internet**; that is fine for "verify before deploy" but is not an offline test.

## Hitting the Cron Endpoint Locally

```bash
# with next dev running and CRON_SECRET in .env.local
curl -sS -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/refresh | jq
# without CRON_SECRET set, the route runs unauthenticated (guard is conditional)
```
This runs the **full** pipeline (ingest→…→geo) against the local DB — needs network for
ingest/geo. For offline, call the pure stages directly via a small `tsx` harness instead of the
cron route.

## `vercel dev` vs `next dev`

- `next dev` is sufficient and simplest for local DB + UI + the cron route (App Router route
  handlers run under `next dev`).
- `vercel dev` adds closer prod parity (env injection via `vercel env pull`, edge/runtime
  emulation) **but does not run Vercel Cron on a schedule locally** — you still curl the endpoint.
  Recommend `next dev` as primary; mention `vercel dev` + `vercel env pull .env.local` as the
  parity option for users who want prod-identical env handling.

## "Verify Before Deploy" Checklist (maps to spec SC-001..SC-008)

| Check | Command / action | Maps to |
|-------|------------------|---------|
| Build is green | `npm run build` | constitution VI |
| Unit tests pass | `npm test` (node --test; dedup/normalize/smoke) | SC-002, SC-003 (logic) |
| DB schema applies clean | `npm run db:schema` → `{ok:true}` | foundation |
| Seed loads expected counts | `npm run db:seed` → events 342 / sources 22 / places 14 / media 216 | foundation |
| Site renders from local DB | `next dev`, open `/` — feed has events+places | SC-007 |
| Calendar opens on current month | inspect default month in UI | SC-005 |
| No junk items in feed | scan feed for nav/category/pagination rows | SC-001 |
| Places catalog renders independently | `/` places section populated even if events sparse | SC-003, SC-007 |
| Mapped-events ratio | count events with lat/lng vs with location hint (≥80%) | SC-004 |
| Detail pages load | open an `/events/[id]-slug` and `/places/[id]-slug` | SC-007 |
| (network) Full pipeline runs end-to-end | `curl -H "Authorization: Bearer $CRON_SECRET" .../api/cron/refresh` | SC-001, SC-003, SC-004 |
| (when built) Digest dedup & curation | run digest harness twice, assert 0 repeats / horizon+score filter | SC-002, SC-008 |
| (when built) Enrichment fail-soft | run `claude -p` batch; kill one; event still renders | SC-006 |

The last three are **gated on features that don't exist yet**; the checklist should mark them
as "pending implementation" so it doesn't block this spec.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|:----------:|:------:|------------|
| **Docker not installed** on the target machine | High (confirmed absent) | Blocks Tier A | Document Docker Desktop install as prereq; ship Tier B (Neon dev branch) as no-Docker fallback |
| `run-pipeline.mjs` already broken (no `tsx`) | High (confirmed) | Pipeline won't run locally | Add `tsx` to devDeps; trivial |
| Proxy image (`localtest.me`/Caddy) flakiness on macOS/Apple Silicon | Med | Tier A intermittent | Pin image tag; add healthcheck `--wait`; fallback to Tier B |
| Forgetting `set -a && source .env.local` → scripts exit 1 | Med | Confusing failure | Wrap in `dev:local` script / `dotenv-cli` / Makefile that sources env |
| `neonConfig` shim accidentally fires in prod | Low | Prod breakage | Gate strictly on `db.localtest.me` host substring; never on `NODE_ENV` |
| Map tiles/fonts need CDN at browser runtime | Low | Cosmetic offline | Note it; page still renders |
| Digest/alert/enrich "full run" expectation unmet | Med | Goal mismatch | Surface in requirements: those features are not built; local-run can only cover what exists + a harness scaffold |

## Quality Commands

| Type | Command | Source |
|------|---------|--------|
| Lint | `npm run lint` | package.json scripts.lint (`next lint`) |
| TypeCheck | Not found (no standalone script; `tsc` via `next build`) | — use `npx tsc --noEmit` if needed |
| Unit Test | `npm test` (`node --test tests/**/*.test.mjs`) | package.json scripts.test |
| Build | `npm run build` (`next build`) | package.json scripts.build |
| Integration/E2E | Not found | — |

**Local CI**: `npm run lint && npm run build && npm test`

## Verification Tooling

| Tool | Command | Detected From |
|------|---------|---------------|
| Dev Server | `npm run dev` (`next dev`, port 3000) | package.json scripts.dev |
| Browser Automation | None | no playwright/cypress/puppeteer in deps |
| E2E Config | None | no config files in root |
| Port | `3000` (Next default) | next dev default |
| Health Endpoint | `/api/cron/refresh` (functional, not a health probe) | app/api/cron |
| Docker | **Not installed**; `docker-compose.yml` to be added by this spec | shell probe |

**Project Type**: Web App (Next.js 14 App Router) + cron pipeline
**Verification Strategy**: `docker compose up` (Postgres + neon proxy) → `npm run db:setup` →
`next dev` on :3000 → curl `/api/cron/refresh` with Bearer for the full pipeline → manual UI
check against the SC checklist. No automated browser E2E exists; verification is build + unit
tests + manual UI + curl.

## Recommendations for Requirements

1. **Primary**: ship Tier A (docker-compose Postgres + `local-neon-http-proxy` + gated
   `neonConfig` shim) as the supported full-local path; **prereq: install Docker Desktop**.
2. **Fallback**: document Tier B (Neon dev branch in `.env.local`) for no-Docker / quick runs.
3. Add `tsx` (and optionally `dotenv-cli`) to devDependencies; fix `run-pipeline.mjs` so
   `npm run pipeline:run` actually works locally.
4. Add `db:local:up` / `db:local:down` / `dev:local` scripts (+ a `Makefile` or
   `bin/dev-local.sh` wrapper that sources `.env.local`) for the "one or two commands" goal.
5. Add an **offline pipeline mode** (run normalize→dedup→score→tag on seed without ingest/geo)
   so a true no-network verification is possible; document that ingest+geo and the cron route
   need internet.
6. Scope-flag: weekly digest/alert endpoints and the `claude -p` enrichment script **do not
   exist yet**. Either (a) keep local-run to "what's built + a harness scaffold", or (b) treat
   building minimal local-runnable digest/enrich stubs as explicit in-scope tasks — decide in
   requirements. Do **not** silently assume they exist.
7. Provide the SC-mapped "verify before deploy" checklist (above) in the repo (e.g.
   `LOCAL_RUN.md` or extend `SETUP_INSTRUCTIONS.md`), with the unbuilt items marked pending.
8. Keep `lib/db.ts` change to the minimal gated shim; never alter the prod neon call path
   (constitution VI).

## Open Questions

- Does the user have / will install **Docker Desktop**? (Tier A hard dependency; currently absent.)
- Is local-run expected to actually **build** the missing digest/alert/enrich endpoints, or only
  to run what already exists? (Goal text implies they should be runnable; code shows they're absent.)
- Is an **offline** run required (no internet at all), or is "local DB + internet for ingest" acceptable?
  This determines whether the offline-pipeline-mode task (rec #5) is mandatory.
- Is `claude -p` enrichment authenticated and usable headless in the user's shell (it is on PATH,
  v2.1.177), and is calling the Anthropic API during a "local run" acceptable cost-wise?

## Open Questions — RESOLVED (user answers, 2026-06-20)

1. **Docker** → **Install it.** Docker Desktop is being installed now (`brew install --cask
   docker-desktop`). Tier A (docker-compose: Postgres + `local-neon-http-proxy`) is the
   committed path; Tier B (Neon dev branch) stays only as a documented fallback.
2. **Missing digest/alert/enrich endpoints** → **Out of scope for local-run.** They get their
   **own specs later**. `local-run` covers only what exists: DB + the ingest→…→geo pipeline +
   `/api/cron/refresh` + the site. The three "pending implementation" checklist rows stay marked
   pending; do NOT build them here.
3. **Offline requirement** → **Not required; internet is OK.** The intent is to **run the app in
   Docker "as if it were Vercel"** to debug before deploy. So the primary path emphasizes
   **Vercel-parity in a container** (build + serve like prod, e.g. `next build && next start` or
   `vercel build`, internet allowed for ingest/geo) — NOT an offline-only run. The optional
   "offline pipeline mode" (rec #5) is therefore **deprioritized**, not mandatory.
4. **`claude -p` auth** → **Acceptable — "even on Vercel."** Using local `claude` CLI auth for
   enrichment is fine, and the user is fine relying on CLI auth in production too. (Practical
   caveat for the future enrich spec: running the `claude` CLI inside Vercel's serverless runtime
   is non-trivial; revisit there. Not a local-run concern.)

**Net effect on requirements**: primary deliverable = a docker-compose that runs Postgres +
neon proxy + the Next.js app in **Vercel-like** mode, one/two-command bring-up, internet allowed,
scoped to existing features; plus fix `npm run pipeline:run` (add `tsx`) and a `LOCAL_RUN.md`
verify-before-deploy checklist. Digest/enrich endpoints explicitly deferred to their own specs.

## Feasibility / Risk / Effort

**Feasibility: High** · **Risk: Medium** (Docker dependency + unbuilt digest/enrich features) · **Effort: M** (docker-compose + ~10-line gated shim across db.ts and 3 scripts + tsx devDep + a few npm scripts and a LOCAL_RUN doc; larger → L if the missing digest/enrich endpoints must also be built for local runnability).

## Sources

- `lib/db.ts`, `lib/queries.ts`, `lib/format.ts`
- `scripts/apply-schema.mjs`, `scripts/seed.mjs`, `scripts/run-pipeline.mjs`
- `lib/pipeline/run.ts`, `ingest.ts`, `normalize.ts`, `score.ts`, `tags.ts`, `dedup.ts`, `geo.ts`, `util.ts`, `normalizers/hemisferic.ts`
- `db/schema.sql`, `package.json`, `.env.example`, `vercel.json`, `.gitignore`, `next.config.mjs`
- `app/api/cron/refresh/route.ts`, `app/page.tsx`, `app/Home.tsx`, `app/layout.tsx`
- `data/seed/sources.json`, `SETUP_INSTRUCTIONS.md`
- `specs/001-valencia-events/spec.md` (SC-001..SC-008), `.specify/memory/constitution.md` (principles IV/V/VI)
- Shell probes: `claude --version` (2.1.177), `node -v` (24.14.0), `which docker` (absent), `which psql/pg_ctl` (present), tsx/pg absent in node_modules
- https://github.com/TimoWilhelm/local-neon-http-proxy (offline Neon HTTP proxy, fetchEndpoint config)
- https://neon.com/docs/local/neon-local (Neon Local requires NEON_API_KEY/PROJECT_ID, not offline)
- https://github.com/neondatabase/neon_local
- https://neon.com/guides/neon-local-docker-compose-javascript
