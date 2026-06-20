# Quickstart & Validation: Valencia Radar

How to run the app and validate the feature end-to-end. Implementation detail lives
in `tasks.md`; this is the run/verify guide.

## Prerequisites

- Node ≥ 20, npm.
- For cloud/prod: a Neon Postgres `DATABASE_URL` and a `CRON_SECRET` in `.env`.
- For live enrichment + eval: `ANTHROPIC_API_KEY` (the SDK path). Offline runs use
  the mocked client / `claude -p` fallback and need no key.
- For local offline DB (sub-area H): Docker Desktop.

## Setup — cloud / Neon

```bash
npm install
npm run db:setup        # apply db/schema.sql (additive), then load data/seed/*.json
npm run dev             # http://localhost:3000
```

## Setup — local offline (Docker Postgres + Neon HTTP proxy, sub-area H)

```bash
npm run db:local:up     # docker compose: postgres:15 + local-neon-http-proxy
# .env.local: DATABASE_URL=postgresql://postgres:postgres@db.localtest.me:5432/main
npm run db:setup        # schema + seed into local DB (shim routes via host substring)
npm run dev:local       # app against local DB, zero prod-path changes
npm run db:local:down   # tear down
```
Offline-capable pipeline stages (no network): normalize → dedup → score → tag.
Network/key stages: ingest, enrich, geo. Tier-B (no Docker): point `.env.local`
`DATABASE_URL` at a Neon dev branch — the shim no-ops on a cloud host.

## Run the pipeline

```bash
npm run pipeline:run    # offline .mjs path: ingest → normalize → dedup → score → tag → enrich → geo
# durable/scheduled paths (start Vercel Workflows, fire-and-forget):
curl -X POST "localhost:3000/api/cron/dispatch"               -H "Authorization: Bearer $CRON_SECRET"
curl -X POST "localhost:3000/api/cron/refresh"                -H "Authorization: Bearer $CRON_SECRET"
curl -X POST "localhost:3000/api/cron/enrich?limit=10"        -H "Authorization: Bearer $CRON_SECRET"
curl -X POST "localhost:3000/api/cron/digest?mode=weekly&dry=1" -H "Authorization: Bearer $CRON_SECRET"
```

## Validation scenarios (map to spec Success Criteria)

1. **Curated feed (SC-001)** — open `/`; the feed shows only real events/series/places,
   no navigation/category junk. Spot-check `normalized_status='ignored'` and
   `status='superseded'` rows never appear.
2. **Calendar defaults to current month (SC-005)** — opens on the current month
   regardless of old data.
3. **Recurring events (SC-009)** — Hemisfèric renders as 11 feed cards (one per film),
   each session on its calendar day, detail page lists the full schedule; re-run
   `pipeline:run` → 0 new occurrences, no `enriched_at` reset.
4. **Map coverage (SC-004)** — ≥80% of events with an address/venue/map link show a
   marker; geo ran after enrich filled clean venue/address.
5. **Dedup (SC-003)** — triple a known event (Слава Комиссаренко) with conflicting
   dates → exactly one survivor with the reliable date, `metadata_json.sources[]`, and
   3 `entity_sources` rows; the Madrid-centroid trio and pool/café trio do NOT merge.
6. **Grounded enrichment (SC-010)** — run `enrich` on the golden fixtures; no invented
   facts (gaps null, conflicts in `notes` with lowered confidence, added facts cited).
7. **Enrichment fail-soft (SC-006)** — force-fail one item; batch completes, `errors`
   counted, that event still renders (un-translated).
8. **Digest no-repeat + confidence-hold (SC-002/008)** — run `digest?mode=weekly`
   (without `dry`) twice → second run selects 0 previously-sent events/places; below-
   threshold-confidence cards withheld.
9. **Independent outputs (SC-007)** — break an event normalizer; `/places` catalog
   still renders.
10. **Offline bring-up (SC-011)** — from a clean checkout, `db:local:up` + `db:setup`
    + `dev:local` serves the app; `npm test` (mocked enrich) passes with no key/network.

## Gate before every commit

```bash
npm run build           # type/compile gate (Principle VI)
node --test tests/      # pure-logic units (scoring, dedup keys, series, digest, enrich mapping)
# optional, key-gated, NOT in CI:
npm run eval            # promptfoo live LLM quality eval (skipped when ANTHROPIC_API_KEY unset)
```
