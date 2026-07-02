# Deploy — Valencia Radar → Vercel + Neon

**Status: PRODUCTION-READY, Hobby-compatible out of the box.** `next build` is green with no
env vars; the seed (`data/seed/*.json` — future-dated events, native Hemisfèric series through
the current schedule window, RU-enriched, geo'd, deduped) IS the prod content. All open
decisions are MADE (see "Decisions" below). Only external-account plumbing + one manual seed
command remain.

## Checklist

### Phase 1 — Database (REQUIRED)
1. Create a Neon project (free tier is plenty); copy the **pooled** connection string (`…?sslmode=require`).
2. From a repo checkout (`npm ci` done), seed prod **once** (idempotent — `ON CONFLICT DO NOTHING`):
   ```
   DATABASE_URL="postgres://…?sslmode=require" npm run db:setup
   ```
   (= apply `db/schema.sql` → load `data/seed/*.json` incl. **native `event_series` +
   `event_occurrences`** → `db:migrate:series` runs as a harmless no-op).
   `lib/db.ts` only routes to the local proxy on the `db.localtest.me` host — a real Neon URL is untouched.

### Phase 2 — Vercel project + env (REQUIRED)
3. Import the repo into Vercel (Next.js auto-detected; default `next build`; do **not** add `db:setup` to the build).
   **Hobby plan works** (T192): all cron routes are `maxDuration: 60`, and `vercel.json` ships ONE
   daily cron (Hobby's limit) pointing at the lightweight adaptive `/api/cron/dispatch`.
4. Production env vars:
   - `DATABASE_URL` = the Neon pooled URL — **REQUIRED** (the only var needed to boot/render).
   - `CRON_SECRET` = a long random string — **REQUIRED** (`/api/cron/dispatch` + `/digest` are 401 without it).
   - `ANTHROPIC_API_KEY` — **NOT SET** (decision: prod is AI-less, see below).
   - `NOTIFY_TRANSPORT=dry-run` — OPTIONAL (default; no delivery until you wire Telegram/webhook).
5. Deploy.

### Phase 3 — Verify (REQUIRED)
6. `APP_BASE_URL=https://<app>.vercel.app npm run smoke` → expect 3/3 PASS, `/api/health` `ok:true`.
   A freshly-seeded DB passes immediately (T143): "never ran" is an INFO note, not a hard fail.

### Phase 4 — Cron cadence (OPTIONAL upgrade)
7. Out of the box: Vercel's daily `/api/cron/dispatch` keeps sources fresh (adaptive — each tick
   polls only DUE sources; conditional-GET makes unchanged ones ~free).
8. For finer cadence (~15 min) + the Friday weekly digest, activate
   `.github/workflows/scheduler.yml` by adding repo secrets `APP_BASE_URL` + `CRON_SECRET`
   (GitHub-Actions cron is free and doesn't count against Vercel limits).

### Phase 5 — OPTIONAL later
9. Notifications: `NOTIFY_TRANSPORT=telegram` + `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` (or webhook) to deliver the weekly digest.

## Decisions (MADE — 2026-07-02)
1. **Enrich on prod (T162): option 1 — AI-less prod.** The seed ships pre-enriched (RU titles/
   descriptions via local `claude -p` on the owner's subscription, $0 marginal). Prod runs
   incremental ingest ONLY — new cards appear un-translated until the next local bake. The
   refresh loop is: locally run the pipeline + enrich + `node --import tsx scripts/rebake-seed.mjs --commit`
   → push → re-run `db:setup` against prod (idempotent). No `ANTHROPIC_API_KEY` on the server; $0 AI cost.
   (If live prod enrich is ever wanted: build the SDK EnrichClient + set the key — enrich.ts is engine-agnostic.)
2. **Plan (T192): Vercel HOBBY.** `vercel.json` = one daily `dispatch` cron; every cron route is
   ≤60s (`refresh` was lowered from 300 — a higher value fails a Hobby deploy). GH-Actions provides
   the fine-grained cadence when secrets are added. Note: Hobby is for non-commercial use.
3. **Cron strategy:** Vercel daily dispatch out of the box; GH-Actions `*/15` as the upgrade path.
4. **Notifications:** dry-run at launch; wire Telegram later.
5. **Data freshness model:** prod self-refreshes raw events via cron (dispatch → normalize →
   dedup → score/tag/geo happen on refresh runs); heavy AI enrichment stays a LOCAL periodic bake
   (see the T195 habit — re-ingest locally, enrich, re-bake, redeploy the seed).

_Audit 2026-07-02. Key files: `vercel.json`, `next.config.mjs`, `lib/db.ts`, `lib/pipeline/run.ts`,
`app/api/cron/*`, `app/api/health/route.ts`, `scripts/{apply-schema,seed,rebake-seed,migrate-hemisferic-series,smoke}.mjs`,
`.github/workflows/scheduler.yml`, `.env.example`, `data/seed/*.json`._
