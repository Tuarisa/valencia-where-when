# Workboard

> Human-facing snapshot. Source of truth is `specs/001-valencia-radar/tasks.md`
> (the `[x]`/`[~]`/`[ ]` markers) — this board summarises it, not replaces it.
> Pipeline order (constitution v1.1.0): **ingest → normalize → dedup → score → tag → enrich → geo**.

## Done

**Foundation & tooling**
- [x] T001–T003 — `node:test` harness, `scheduler.yml` skeleton (`*/15` tick + Friday digest), `.env.example`
- [x] T004 — all additive schema applied (`entity_sources`, `event_series`/`event_occurrences`,
      sources cadence cols, `source_runs.changed/not_modified`, places enrich cols, `notifications.series_id/place_id`)
- [x] T005–T007 — normalizer registry/dispatch (`normalizeAll`, `normalizers/`, `markRawItem` append-only)
- [x] T080–T083 (H) — local Docker+Neon-proxy stack wired; seed 385 events / 23 sources / 14 places / 216 media
- [x] T090–T092 (I) — `promptfoo` eval harness (key-gated, out of CI), golden fixtures, `npm run eval`

**Ingestion (A)**
- [~] T010 — `PARSER_REGISTRY` + `resolveParser` done; conditional-GET return/inserted-count folded into T011
- [x] T011–T015 — conditional GET (ETag/304), `dispatcher.ts` (due-select + bounded pool), `/api/cron/dispatch`
      (fail-closed), per-type cadence seeds, `cadence.ts` pure logic + tests

**Pipeline order (B)**
- [x] T020 — `run.ts` reordered to canonical order; enrich slot gated on injected client (before geo)
- [x] T023 — offline `run.ts` + `run-pipeline.mjs` path is the live path, determinism verified

**Dedup (C)**
- [x] T030–T032 — first-pass events dedup, Komissarenko test, merge convention (`status='duplicate'` + `merged_into`)
- [x] T035 — over-merge FIXED (Cyrillic→Latin translit, ≥2-distinct-source guard, untitled guard) + strong-match
      pre-pass; live 11 false groups → 0, idempotent
- [x] T036 — places dedup matching (`placeKey`, `arePlacesDuplicate` strong+fuzzy) *(DB orchestrator deferred → T064)*
- [x] T037 — geo guard (`haversineMeters`/`isCentroid`/centroid blacklist/`geoCorroborates`; nominatim never votes)
- [x] T038 — dedup wired into `run.ts` after normalize (occurrences never scanned; idempotent)
- [x] T039 — places/centroid trios MUST-NOT-merge tests; Jaro-Winkler + haversine units

**Recurring events (D)**
- [x] T040, T042–T044 — `series.ts` idempotent `upsertSeries`; seed migration 104 events → 11 series +
      104 occurrences; feed/calendar/detail cutover (`is_series`/`occurrence_count`)
- [~] T041 — Hemisfèric normalizer emits series (live-verified; tasks.md keeps it partial)

**Enrichment (E)**
- [x] T052/T053/T054/T056 — `enrich.ts` ground-or-flag + confidence, `{web}` augmentation,
      series-once enrich, mocked-client tests
- [~] T050/T051 — enrich skeleton + canonical `enrichment_json` schema (engine done; `@anthropic-ai/sdk`
      install + poster-image OCR still open)
- [x] `claude -p` EnrichClient (`enrich-client.ts`) — DEFAULT key-free engine; `{web}` WebFetches source links to ground
- [x] T139 — `claude -p` model tiering (haiku=translation / sonnet=grounded); `--allowedTools WebFetch` fix

**Outputs & surfaces (F)**
- [x] T060–T063, T065 — curated feed (events ∪ series), current-month calendar + per-session occurrences,
      Leaflet map, **places catalog** (`/places` with facets), feed/categorize tests
- [x] T133 — special-event colour categorization (gold feria/festival accent)
- [~] T135 — informative map popups: PART 2 (readable popup template) done; PART 1 geo BAKED — 46/51 logunespa
      places mapped (deterministic maps-redirect → address geocode, no LLM)

**Notifications (G)**
- [x] T072–T074 — pluggable `sendDigest` (dry default); `markEvents/PlacesNotified` no-repeat (SC-002);
      series-aware digest; digest-select/alert-select tests; digest route (`/api/cron/digest`, fail-closed)
- [~] T070/T071 — `selectDigest`/`selectAlerts`/`isFamilyFit`/`cardConfidence` + `buildDigest`/`renderDigestText`
      logic done; `digestWorkflow` substrate pending (Workflow SDK)

**Normalizers & sources**
- [x] T101 — spec-named sources added (`elcontacto`, `russpain`, `eventbrite` enabled; `spainnewsonline` off)
- [x] T110/T111 — worldafisha (Spain pre-filter), valenciarusa normalizers
- [x] T112 — vidacultural_Valencia normalizer (+place posts)
- [x] **concerten normalizer** (`tg:concerten`) — pure `buildConcertenEvents` + mandatory Spain pre-filter +
      `spainCity`, `normalizeConcerten` mirrors vidacultural, registered in `NORMALIZER_REGISTRY`; 9/9 offline
      tests — **landed this tick** (fulfils T131)
- [x] T131 — concerten Spain-only filter wired into the concerten normalizer (symmetric to worldafisha)
- [~] T136 — worldafisha≈concerten pair-dedup test landed; live dedup waits on real `source_items`

**Polish / backlog**
- [~] T100 — fail-closed `CRON_SECRET` done for `/api/cron/digest`; apply to dispatch/enrich routes as they land
- [x] T132 — Fever extractor (drone show / Harry Potter event pages)
- [x] T137 — dropped deprecated `fetchConnectionCache`
- [x] T138 — `/api/health` + `health.ts` (`sourceStale`/`pipelineWarnings`) + `scripts/smoke.mjs`

## Next (genuinely unblocked)

- [ ] **T021 → T022 → T055** — Vercel Workflow substrate *(see Blocked — local-build incompat; do on a real Vercel preview)*
- [ ] **More source normalizers** — Palau, CAC, visitvalencia, lacotorra, Ticketmaster, Songkick,
      Valencia Bonita, Hoy Valencia, laganzua — one per iteration, prime loop fodder (no discrete task IDs yet)
- [ ] **T064 (F)** — place-mining normalizers (`rutatuta_vlc`, `gosvetlanada`, Fever gastro) → `places`;
      also lands the place-dedup DB orchestrator deferred from T036 *(logunespa half paused — see Blocked)*
- [ ] **T134 (F)** — design polish via design MCP (Vercel/Figma) — dedicated visual iteration beyond prototype CSS
- [ ] **T135 PART 1 taglines** — short "why-go" taglines via haiku enrich; nudge a couple of mis-geocoded outliers
- [ ] **T140** — standing "JS before LLM" rule; audit crawler/enrich for de-LLM-able rule/keyword extraction
- [ ] **T103 (this task)** — dead-code tidy half (deferred — premature while tasks remain; do at final polish)

## Blocked

- **T021 / T022 / T055** — Vercel **Workflow SDK** (`workflow@4.5.0`) does NOT build with next@14.2.15 locally
  (auto `/.well-known/workflow/*` routes crash page-data collection on Vercel-OIDC with no linked project).
  Unblock: build on a real Vercel deploy/preview (skip local gate), or pin/upgrade Next. (T055 also needs T021.)
- **T033 / T034** — `entity_sources` writes + 90-row backfill: seed loads NO `source_items`
  (FK `source_item_id REFERENCES source_items(id)` can't be satisfied). Unblock: a real ingest run that
  populates `source_items`, or add a one-time `source_items` export to the seed.
- **T064 / T130** — logunespa historical place crawl **PAUSED by user** at ~51 places (catalog ~59, 46 mapped).
  Do NOT auto-resume; resume the backward crawl later. T064 place-mining proceeds for the non-logunespa sources.
- **T102** — run `quickstart.md` scenarios end-to-end: needs the local stack UP (`db:local:up` → seed → `dev:local`).

## Notes
- Vercel Hobby cron = once/day; every-12h needs Pro (`"15 7,19 * * *"`).
- Nominatim needs a paced delay (1.1s in `geo.ts`) + a real User-Agent; geo follows `maps.app.goo.gl` redirects
  and geocodes the bare street address (the maps `q=` venue-name leads to the city-centre centroid).
- `claude -p` enrich engine is subscription/OAuth (no API key) — ABSENT on Vercel serverless; prod enrich needs
  the SDK path or runs off-prod. Model tiering: haiku (translation) / sonnet (grounded WebFetch).
- Concurrency: never run `npm run build` / `npm i` concurrently (corrupts `.next` / `node_modules`).
