# Quickstart & Validation: Valencia Radar

How to run the app and validate the feature end-to-end. Implementation detail lives
in `tasks.md`; this is the run/verify guide.

## Prerequisites

- Node ≥ 20, npm.
- A Neon Postgres `DATABASE_URL` and a `CRON_SECRET` in `.env` (see `.env.example`).
- `claude` CLI available on PATH for the enrichment stage.

## Setup

```bash
npm install
npm run db:setup        # apply db/schema.sql, then load data/seed/*.json
npm run dev             # http://localhost:3000
```

## Run the pipeline

```bash
npm run pipeline:run    # ingest → normalize → score → tag → geo (existing stages)
# new stages, once implemented, via the protected endpoints:
curl -X POST localhost:3000/api/cron/refresh  -H "Authorization: Bearer $CRON_SECRET"
curl -X POST "localhost:3000/api/cron/enrich?limit=10" -H "Authorization: Bearer $CRON_SECRET"
curl -X POST "localhost:3000/api/cron/digest?mode=weekly&dry=1" -H "Authorization: Bearer $CRON_SECRET"
```

## Validation scenarios (map to spec Success Criteria)

1. **Curated feed (SC-001)** — open `/`; the feed shows only real events/places, no
   navigation/category junk. Spot-check that `normalized_status='ignored'` raw items
   never appear.
2. **Calendar defaults to current month (SC-005)** — the calendar opens on the
   current month regardless of old data; Hemisfèric days are one collapsible
   color-coded card with session times.
3. **Map coverage (SC-004)** — ≥80% of events that have an address/venue/map link
   show a marker. Check the geo stage filled `lat/lng`.
4. **Dedup (SC-003)** — seed/triple a known event (e.g. Слава Комиссаренко) with
   conflicting dates; after `dedup`, exactly one event remains with the reliable
   date and `metadata_json.sources[]` listing all three.
5. **Digest no-repeat (SC-002)** — run `digest?mode=weekly` (without `dry`) twice;
   the second run selects 0 of the previously-sent events.
6. **Enrichment fail-soft (SC-006)** — run `enrich` with a forced-failing item; batch
   completes, `errors` counted, that event still renders (un-translated).
7. **Independent outputs (SC-007)** — break an event normalizer; `/places` catalog
   still renders.

## Gate before every commit

```bash
npm run build           # type/compile gate (Principle VI)
node --test tests/      # pure-logic units (scoring, dedup keys, digest filter)
```
