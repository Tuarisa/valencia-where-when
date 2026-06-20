# Contracts: pipeline stages, cron endpoints & workflows

Phase 1 output. The app's "interfaces" are (a) `CRON_SECRET`-protected HTTP
endpoints triggered by schedulers (which now `start()` durable Vercel Workflows
fire-and-forget), (b) the durable workflow definitions, and (c) the internal
pipeline-stage function signatures. Contracts are behavioural, not REST schemas.

## HTTP endpoints (all require `Authorization: Bearer ${CRON_SECRET}`, fail-closed → 401)

### POST `/api/cron/dispatch`  *(new — sub-area A)*
- **Does**: `selectDueSources()` (where `enabled=1 AND (next_due_at IS NULL OR
  next_due_at <= now())`) → bounded `Promise.allSettled` ingest pool (4–6) → updates
  each source's cadence state.
- **Returns**: `{ ok, due, ingested, changed, not_modified, errors }`.
- **Trigger**: GitHub Actions `*/15` tick.

### POST `/api/cron/refresh`  *(existing — now starts a workflow)*
- **Does**: `start(refreshWorkflow)` = ingest → normalize → **dedup** → score → tag →
  **enrich** → geo, as durable steps. Force-all ingest (ignores `next_due_at`).
- **Returns**: `{ ok, runId }` immediately (fire-and-forget).
- **Trigger**: Vercel daily cron (safety-net) + optional GH Actions second ingest.

### POST `/api/cron/enrich`  *(new — sub-area E)*
- **Does**: `start(enrichWorkflow(limit))` — per-card fan-out of un-enriched
  events/series/places (`enriched_at IS NULL`), Anthropic SDK constrained decoding.
- **Query**: `?limit=<int, default capped>`, `?dry=1` (no writes).
- **Returns**: `{ ok, runId }` (or, when run synchronously/locally,
  `{ attempted, enriched, skipped, errors }`).
- **Guarantee**: a per-item failure does not abort the batch or corrupt the record;
  facts are grounded or flagged, never invented.

### POST `/api/cron/digest`  *(new — sub-area G)*
- **Does**: `start(digestWorkflow(mode))` — select family-fit candidates in horizon
  (above score + confidence thresholds, `notified=0`), build digest + "new places"
  block (+ rare-alert list when `mode=alert`), send, mark notified.
- **Query**: `?dry=1` (build but don't send/mark), `?mode=weekly|alert`.
- **Returns**: `{ ok, runId }` (or `{ mode, selected, places, marked }` when synchronous/dry).
- **Guarantee**: with `dry=1`, DB unchanged. Without it, sent **events, series, and
  places** get `notified=1` + a `notifications` row; already-notified items excluded.
- **Trigger**: GitHub Actions `0 7 * * 5` UTC (~Fri 09:00 Europe/Madrid, DST in-handler).

## Durable workflows (`app/workflows/`, Vercel Workflow SDK)

```text
refreshWorkflow()        'use workflow' — steps: ingestAll → normalizeAll → dedup
                          → scoreAll → tagAll → enrichCards(cap) → geoEnrich
enrichWorkflow(limit)    'use workflow' — select batch → per-card 'use step' fan-out
digestWorkflow(mode)     'use workflow' — selectCandidates → buildDigest → send → markNotified
```
Rules: workflow bodies are deterministic (no `Date.now()`/random outside steps);
all IO lives in `use step` functions; step args/returns are JSON-serializable;
trigger routes never await completion (return `{runId}`).

## Internal pipeline-stage contracts (`lib/pipeline/`)

```text
selectDueSources(): Promise<Source[]>                 // NEW — adaptive due-check
dispatch({concurrency}): Promise<DispatchResult>      // NEW — bounded ingest pool
ingestAll(): Promise<IngestResult>                    // existing — append-only; conditional GET
normalizeAll(): Promise<NormalizeResult>              // registry dispatch (done)
  - NORMALIZER_REGISTRY: Map<sourceKey|itemType, (item) => NormalizedOut>
  - NormalizedOut = { events?: EventDraft[], places?: PlaceDraft[],
                      series?: SeriesDraft, occurrences?: OccurrenceDraft[], status }
upsertSeries(series, occurrences[]): Promise<void>    // NEW — idempotent recurring
dedup(): Promise<DedupResult>                         // EXTEND — events+places, entity_sources, geo guard
scoreAll(): Promise<ScoreResult>                      // existing
tagAll(): Promise<TagResult>                          // existing
enrichOne(row, {client, web, exec}): Promise<Enrichment>      // NEW — injectable client
enrichCards(limit, {dry, client, exec}): Promise<EnrichResult> // NEW — per-item try/catch
geoEnrich(limit): Promise<GeoResult>                  // existing — Nominatim ≥1.1s, real UA
selectDigest({horizonDays, threshold}): DigestSelection // NEW — pure selector
selectAlerts({alertThreshold}): AlertSelection          // NEW — pure selector
sendDigest(payload): Promise<SendResult>                // NEW — pluggable; default dry-run
```

### Stage invariants (constitution gates)
- **Append-only**: no stage deletes/overwrites `source_items`; only sets
  `normalized_*` / bumps `last_seen`.
- **Order**: dedup immediately after normalize; enrich before geo (v1.1.0).
- **Dedup keeps links**: every contributor recorded in `entity_sources`; survivor
  `metadata_json.sources[]` mirrors it; losers `status='duplicate'` + `merged_into`.
  Geo proximity never merges alone (fallback/centroid coords ignored).
- **Recurring idempotent**: unchanged schedule → 0 new occurrences, no `enriched_at`
  reset; enrich/score/notify target the series, not occurrences.
- **Enrichment fail-soft + grounded**: one item throws → caught, counted, base record
  valid & renderable; no invented facts; conflicts in `notes` with lowered confidence.
- **Notify opt-in + no-repeat**: dispatch only on explicit non-`dry` call; `notified=1`
  rows (events/series/places) never re-selected; low-confidence held.
- **Deterministic site**: route handlers under `app/` read DB only; no scraping at
  request time.

## Scheduler contract (`.github/workflows/scheduler.yml`)
- Dispatcher tick: POST `/api/cron/dispatch` every `*/15`.
- Second daily ingest (optional): POST `/api/cron/refresh`.
- Enrichment batch: POST `/api/cron/enrich` after ingest.
- Weekly digest: POST `/api/cron/digest?mode=weekly` Fridays `0 7 * * 5` UTC.
- Secret passed as `Authorization: Bearer` from a GitHub Actions secret.
