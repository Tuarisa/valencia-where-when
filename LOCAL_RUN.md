# Local offline run (sub-area H)

Run the whole app + DB locally with **zero production code-path changes**. The
`@neondatabase/serverless` driver is pointed at a local Postgres via the Neon HTTP
proxy; the shim activates only on the `db.localtest.me` host substring
(`lib/db.ts`, `scripts/_neon-local.mjs`), never on `NODE_ENV`.

## Prerequisites
- Docker Desktop **running** (`docker info` must succeed).
- Node ≥ 20, `npm install` done (brings in `tsx` for `pipeline:run`).

## Bring it up
```bash
npm run db:local:up       # docker compose: postgres:15 + local-neon-http-proxy (:4444)
npm run db:local:setup    # apply db/schema.sql + load data/seed/*.json into the local DB
npm run dev:local         # next dev against the local DB → http://localhost:3000
# offline pipeline stages (normalize/dedup/score/tag are network-free):
DATABASE_URL=postgresql://postgres:postgres@db.localtest.me:5432/main npm run pipeline:run
npm run db:local:down     # stop (data persists in the valencia_pgdata volume)
```

Tier-B (no Docker): put a Neon **dev-branch** URL in `.env.local` — the shim no-ops
on a cloud host, so everything works unchanged.

## Expected seed counts (db:local:setup)
- sources **23** (22 original + `web:feriadejuliovlc`)
- events **385** (342 original + 43 Feria de Julio 2026 highlights)
- places **14**
- media_assets **216**

## Verification checklist (maps to spec Success Criteria)

| # | SC | Check | Status |
|---|----|-------|--------|
| 1 | SC-001 | `/` feed shows only real events/places, no junk; no `ignored`/`superseded` rows | offline-capable |
| 2 | SC-005 | calendar opens on the current month | offline-capable |
| 3 | SC-009 | recurring events render as one card/series, sessions per day; re-run adds 0 occurrences | **pending implementation** (sub-area D) |
| 4 | SC-004 | ≥80% of located events on the map | needs geo (network) |
| 5 | SC-003 | dedup collapses duplicates, keeps all sources; no fallback-geo merges | **pending implementation** (sub-area C wiring) |
| 6 | SC-010 | enrichment grounds-or-flags, no invented facts | **pending implementation** (sub-area E) |
| 7 | SC-006 | enrich batch fail-soft | **pending implementation** (sub-area E) |
| 8 | SC-002/008 | digest no-repeat + confidence-hold | **pending implementation** (sub-area G) |
| 9 | SC-007 | deterministic render; places catalog renders with events gaps | offline-capable |
| 10 | SC-011 | clean offline bring-up; `npm test` passes with no key/network | ✅ harness green (8/8) |

Rows marked "pending implementation" are tracked in `specs/001-valencia-radar/tasks.md`.
