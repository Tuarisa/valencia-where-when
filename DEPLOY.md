# Deploy — Valencia Radar → Vercel + Neon

**Status: SHIP-READY.** `next build` is green with no env vars; the deferred Workflow SDK is
absent (the offline `run.ts` path is live); the seed (`data/seed/*.json`, ~400 dated events,
100% RU, geo, deduped) IS the prod content. No code blockers — only external-account plumbing
+ a one-time manual seed.

## Checklist

### Phase 1 — Database (REQUIRED)
1. Create a Neon project; copy the **pooled** connection string (`…?sslmode=require`).
2. From a repo checkout (`npm ci` done), seed prod **once** (idempotent — `ON CONFLICT DO NOTHING`):
   ```
   DATABASE_URL="postgres://…?sslmode=require" npm run db:setup
   ```
   (= apply `db/schema.sql` → load `data/seed/*.json` → migrate Hemisfèric → 11 series).
   `lib/db.ts` only routes to the local proxy on the `db.localtest.me` host — a real Neon URL is untouched.

### Phase 2 — Vercel project + env (REQUIRED)
3. Import the repo into Vercel (Next.js auto-detected; default `next build`; do **not** add `db:setup` to the build).
4. Production env vars:
   - `DATABASE_URL` = the Neon pooled URL — **REQUIRED** (the only var needed to boot/render).
   - `CRON_SECRET` = a long random string — **REQUIRED** (`/api/cron/dispatch` + `/digest` are 401 without it).
   - `ANTHROPIC_API_KEY` — **SKIP** (enrich is disabled on prod; the seed is pre-enriched; `claude -p` is absent on serverless).
   - `NOTIFY_TRANSPORT=dry-run` — OPTIONAL (default; no delivery until you wire Telegram/webhook).
5. Deploy.

### Phase 3 — Verify (REQUIRED)
6. `APP_BASE_URL=https://<app>.vercel.app npm run smoke` → expect 3/3 PASS, `/api/health` `ok:true`.
   **A freshly-seeded DB now passes immediately (T143):** "never ran" is an INFO note
   (`"no pipeline run yet (info)"`), not a hard fail — health is `ok:true` as long as the seed has
   upcoming events. (Optional: fire one pipeline run to clear even the info note — GH-Actions
   `scheduler.yml` → Run workflow → `refresh`, OR
   `curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/cron/refresh`.)

### Phase 4 — Cron (REQUIRED — pick one)
8. **Either** `vercel.json`'s daily `/api/cron/refresh` (Hobby-friendly, 1×/day) **or** activate
   `.github/workflows/scheduler.yml` (`*/15` → `/api/cron/dispatch` adaptive + Friday weekly digest) by
   adding repo secrets `APP_BASE_URL` + `CRON_SECRET`. **On Hobby, prefer GH-Actions dispatch** (60s
   functions) over a heavy daily full-refresh (the `maxDuration:300` on `refresh` needs Vercel **Pro**).

### Phase 5 — OPTIONAL later
9. Notifications: `NOTIFY_TRANSPORT=telegram` + `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` (or webhook) to deliver the weekly digest.
10. Live enrich on prod: needs `ANTHROPIC_API_KEY` + the SDK enrich path (defer; the seed is pre-enriched).

## Decisions needed from you
1. **Accounts:** a Vercel account + a Neon project. **Hobby vs Pro** — Hobby caps functions at 60s + 1 cron/day.
2. **Cron strategy:** Vercel daily `refresh` only, or GH-Actions `*/15` dispatch + weekly digest? (recommend GH-Actions on Hobby).
3. **Manual seed:** confirm you'll run `npm run db:setup` against the prod Neon URL once.
4. **Enrich on prod:** leave OFF (recommended — pre-enriched seed). Confirm.
5. **Notifications:** dry-run for launch, or wire Telegram now (needs bot token + chat id)?
6. **Fresh-deploy health:** seed-only is now `ok:true` (T143); no pre-smoke `refresh` needed.

_Audit 2026-06-21. Key files: `vercel.json`, `next.config.mjs`, `lib/db.ts`, `lib/pipeline/run.ts`,
`app/api/cron/*`, `app/api/health/route.ts`, `scripts/{apply-schema,seed,migrate-hemisferic-series,smoke}.mjs`,
`.github/workflows/scheduler.yml`, `.env.example`, `data/seed/*.json`._
