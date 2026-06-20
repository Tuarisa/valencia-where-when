# Contracts: pipeline stages & cron endpoints

Phase 1 output. The app's "interfaces" are (a) `CRON_SECRET`-protected HTTP
endpoints triggered by schedulers, and (b) the internal pipeline-stage function
signatures. Contracts are behavioural, not REST schemas.

## HTTP endpoints (all require `Authorization: Bearer ${CRON_SECRET}`)

### POST `/api/cron/refresh`  *(existing)*
- **Does**: `runPipeline()` = ingest → normalize → score → tag → geo.
- **Returns**: `{ ok, took_ms, ingest, normalize, score, tag, geo }`.
- **Auth fail**: 401. **On stage error**: still returns per-stage results; never
  throws away `source_items`.

### POST `/api/cron/enrich`  *(new)*
- **Does**: enrich up to `limit` un-enriched events (`enriched_at IS NULL`), batched
  `claude -p` per item.
- **Query**: `?limit=<int, default capped>` , `?dry=1` (no writes).
- **Returns**: `{ ok, attempted, enriched, skipped, errors }`.
- **Guarantee**: a per-item failure does not abort the batch or corrupt the record.

### POST `/api/cron/digest`  *(new)*
- **Does**: select family-fit candidates in horizon, build digest + "new places"
  block + rare-alert list.
- **Query**: `?dry=1` (build but don't send/mark), `?mode=weekly|alert`.
- **Returns**: `{ ok, mode, selected: Event[], places: Place[], marked }`.
- **Guarantee**: with `dry=1`, DB unchanged. Without it, sent items get `notified=1`
  + a `notifications` row; already-notified items are excluded.

## Internal pipeline-stage contracts (`lib/pipeline/`)

```text
ingestAll(): Promise<IngestResult>              // existing — append-only to source_items
normalizeAll(): Promise<NormalizeResult>        // EXTEND: dispatch by source via normalizers/
  - registry: Map<sourceKey|itemType, (item) => NormalizedOut>
  - NormalizedOut = { events?: EventDraft[], places?: PlaceDraft[], status }
scoreAll(): Promise<ScoreResult>                // existing
tagAll(): Promise<TagResult>                    // existing
geoEnrich(limit): Promise<GeoResult>            // existing — Nominatim paced ≥1.1s, real UA
dedup(): Promise<DedupResult>                   // NEW — { groups, merged, survivorsUpdated }
enrichCards(limit, {dry}): Promise<EnrichResult> // NEW — per-item try/catch, idempotent
notify({mode, dry}): Promise<NotifyResult>       // NEW — selection + mark-notified
```

### Stage invariants (constitution gates)
- **Append-only**: no stage deletes/overwrites `source_items` content; only sets
  `normalized_*`.
- **Dedup keeps links**: survivor `metadata_json.sources[]` contains every merged
  source.
- **Enrichment fail-soft**: throw inside one item → caught, counted in `errors`,
  base record still valid & renderable.
- **Notify opt-in + no-repeat**: dispatch only on explicit call without `dry`;
  `notified=1` rows never re-selected.
- **Deterministic site**: route handlers under `app/` read DB only; no scraping at
  request time.

## Scheduler contract (`.github/workflows/scheduler.yml`)
- Second daily ingest: POST `/api/cron/refresh` (~19:15 UTC).
- Enrichment batch: POST `/api/cron/enrich` (after each ingest).
- Weekly digest: POST `/api/cron/digest?mode=weekly` Fridays ≈ 09:00 Europe/Madrid.
- Secret passed as `Authorization: Bearer` from a GitHub Actions secret.
