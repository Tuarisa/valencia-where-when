# Research & Decisions: Valencia Radar (consolidated)

Phase 0 output. This file is the **single home for every technical decision** behind
the feature. It merges the original `001-valencia-events` research (D1–D6) with the
seven archived ralph-specum research specs, and records how the seven concrete
**contradictions** between them were resolved. Nothing from the archived specs was
dropped; provenance is in `specs/_archive/`.

Sub-area legend: **A** Ingestion · **B** Pipeline/Workflow · **C** Dedup ·
**D** Recurring · **E** Enrichment · **F** Outputs · **G** Notify ·
**H** Local dev · **I** LLM eval.

---

## Part 1 — Resolved contradictions (the reason for consolidation)

These were genuine, mutually-exclusive disagreements across specs. Each is now
settled; the spec/plan/data-model encode the resolution.

### R1. Pipeline stage order — enrich before or after geo? → **enrich BEFORE geo**
Constitution v1.0.0 + original 001 said `… tag → geo → enrich` (enrich last).
`pipeline` and `card-enrich` argued enrich must run **before** geo: enrich fills clean
`venue_name`/`address` so the geocoder resolves more rows (lifting SC-004 ≥80%).
**Decision**: canonical order = `ingest → normalize → dedup → score → tag → enrich →
geo`. Constitution V amended (v1.1.0, MINOR). `geo.ts` stays the only geocoder.

### R2. Dedup merge convention → **`status='duplicate'` + `merged_into`, AND `sources[]` on survivor**
The on-disk `dedup.ts` wrote `status='merged'` + `metadata_json.sources[]`; the 90
existing seed duplicate rows use `status='duplicate'` + `metadata_json.merged_into`.
Shipping both breaks render/dedup. **Decision**: standardize on
`status='duplicate'` + `metadata_json.merged_into=<survivor_id>` on losers (matches
seed + render, least migration), **and** keep `metadata_json.sources[]` on the
survivor for attribution (not mutually exclusive). Migrate the 90 seed rows first.
The new `entity_sources` table is the source-of-truth; `sources[]` is a convenience.

### R3. Enrichment engine — `claude -p` vs `@anthropic-ai/sdk`? → **`claude -p` (subscription) DEFAULT; SDK optional** *(revised 2026-06-20 per user)*
001 + constitution IV said `claude -p`; `card-enrich` + `llm-testing` argued for the
SDK (constrained-decoding schema guarantee + mockability). The first pass picked the
SDK as primary — but the **user owns a Claude subscription, and `claude -p` runs on
that OAuth session with NO API key and no extra billing**, so it is the pragmatic
default for this personal project.
**Decision (revised)**: `claude -p` (subscription/OAuth, no key) is the DEFAULT engine.
The `@anthropic-ai/sdk` (`ANTHROPIC_API_KEY`) is an OPTIONAL alternative, used only when
either of its two real advantages is needed: (a) grammar-level **constrained decoding**
(guaranteed JSON — with `claude -p` we parse its text output + Ajv-validate + retry on
malformed), or (b) running enrichment **inside the Vercel serverless runtime**, where
the Claude Code CLI is absent. Both engines sit behind the same injectable
`EnrichClient` interface (`enrich.ts` is engine-agnostic), and tests use a mock — so the
choice never blocks the build. Practical placement: enrichment is batch/best-effort, so
running it **locally / on the dev machine via `claude -p`** (where the CLI + subscription
live) is the default; the SDK path is only needed if enrichment must run on Vercel cron.
`ANTHROPIC_API_KEY` stays documented in `.env.example` but is **not required**.

### R4. Hemisfèric granularity — one card per DAY vs per FILM? → **per FILM (series + occurrences)**
001 FR-010 said one calendar card per day; `repeateable-events` supersedes that with
`event_series` + `event_occurrences` (11 films, 104 occurrences), so enrich/score/
notify run once per series (104→11 calls). **Decision**: adopt the series model;
FR-010 rewritten; original T009 superseded; calendar still buckets each session by
day. Occurrence granularity = **per session** (repeateable-events Q1 resolved).

### R5. Dispatcher tick cadence — `*/10` vs `*/15–30` vs Vercel Pro? → **Hobby + GH Actions `*/15`**
`pipeline` wanted GH Actions `*/10`; `vercel-workflow` raised Pro multi-cron.
**Decision**: stay on Hobby + GH Actions, tick default `*/15` (cost/freshness
compromise); per-source **adaptive** cadence (`next_due_at`) does the fine throttling
so the coarse tick rarely matters. Vercel daily cron stays as a force-all safety-net.
Pro upgrade is a named deferred option.

### R6. Confidence / quality thresholds unset → **ratified threshold table**
`card-enrich` and `llm-testing` both left thresholds open. **Decision** (in
`data-model.md` "Resolved threshold table"): confidence `<0.6` hold, `0.6–0.8` review,
escalate Haiku→Opus when `<0.8`/poster/conflict; eval RU-quality `≥0.7`, venue
Levenshtein `≥0.85`, date match `±0` days. Defaults to tune, but named in one place.

### R7. Dedup placement "between tag and geo" → **bug; dedup runs right after normalize**
001 T025 said dedup runs "between tag and geo"; `dedup` D5 + `pipeline` E both flag
this as wrong. **Decision**: dedup runs **immediately after normalize**. Not a real
disagreement — a 001 bug both research specs caught. Encoded everywhere.

---

## Part 2 — Decisions by sub-area

### A. Ingestion & Source Registry  *(absorbs `pipeline`)*
- **A1 Parser + normalizer registries**: `NORMALIZER_REGISTRY` (one module per source
  under `lib/pipeline/normalizers/`, keyed by `source_key`; Hemisfèric already
  registered) **plus** a new `PARSER_REGISTRY` (`Map<type|key, (source, body|json) =>
  RawItem[]>`) replacing the hardcoded parser if/else in `ingestSource`.
- **A2 "Add a source" 5-step contract**: (1) add row to `sources.json` + DB; (2)
  pick/register a parser; (3) register a normalizer keyed by `source_key`; (4) for
  recurring sources, return series+occurrences via `upsertSeries`; (5) add a golden
  fixture, run `npm run build` + `node --test`, no core edits.
- **A3 Adaptive per-source cadence**: additive `sources` columns + dispatcher (see
  `data-model.md` A). `poll_interval = clamp(observed_gap × 0.33, min, max)`; EWMA α
  0.3; back-off × 1.5 on no-change; exponential + jitter on error.
- **A4 Change detection**: prefer HTTP 304 (send `If-None-Match`/`If-Modified-Since`
  from `sources.etag`/`last_modified`); fall back to **item-hash delta** (did the
  fetch produce new `source_items` via the `dedup_hash` UNIQUE?) — Telegram/HTML
  sources rarely honor conditional GET, so item-hash is the primary signal.
- **A5 Bounded parallel pool**: concurrency 4–6 (env-tunable) via `Promise.allSettled`;
  no new dep (hand-rolled pool). `ingestSource` already try/catches + logs
  `source_runs` → per-source failure isolation (Constitution + FR-017). Add 429 /
  `Retry-After` backoff; keep the real `USER_AGENT`.
- **A6 Dispatcher**: new `lib/pipeline/dispatcher.ts` (`selectDueSources()` +
  `dispatch({concurrency})`) and `app/api/cron/dispatch/route.ts` (Bearer
  `CRON_SECRET`). Due-select: `WHERE enabled=1 AND (next_due_at IS NULL OR next_due_at
  <= now()) ORDER BY next_due_at`. Keep `ingestAll()` (ignore `next_due_at`) for the
  daily safety-net + local runs.

### B. Pipeline Architecture & Execution  *(absorbs `vercel-workflow` + ordering half of `pipeline`)*
- **B1 Canonical order** (R1/R7): `ingest → normalize → dedup → score → tag → enrich →
  geo`, every stage idempotent (skip already-processed rows by their marker column).
- **B2 Vercel Workflow substrate** (D-WF1/2/3): adopt the `workflow` SDK
  (`use workflow`/`use step`). Three durable jobs: `refreshWorkflow`
  (ingest→…→geo steps), `enrichWorkflow(limit)` (per-card fan-out), `digestWorkflow
  (mode)` (select→build→send→mark). Workflow bodies deterministic (no
  `Date.now()`/random outside steps); step args/returns JSON-serializable; trigger
  routes fire-and-forget return `{runId}`. Wrap `next.config.mjs` with
  `withWorkflow`; `npm i workflow`; remove `functions.maxDuration` from
  `vercel.json`. Keep `lib/pipeline/run.ts` + `scripts/run-pipeline.mjs` as the
  offline `.mjs` path. Workflow has **no scheduler** → GH Actions still drives cron.
  Constitution stack amended (v1.1.0).

### C. Deduplication  *(absorbs `dedup`)*
- **C1 Two layers**: deterministic source-identity strong-match (url / external_id /
  resolved maps_url / person-URL) → then fuzzy entity-resolution (block by key,
  Jaro-Winkler ≥ τ + ≥2 signals + date-window). LLM tie-break is **optional, flag-
  gated, off by default**, never in the deterministic path.
- **C2 Places dedup path** (new): `placeKey = nameSignature|area|category`; strong
  match on `maps_url`/`external_id`; fuzzy on name + category + (address overlap OR
  geo within R, geo-guarded). `recommended_by` becomes the union of all contributors.
- **C3 Geo guard** (mandatory): proximity never merges alone; only
  `geo_source='map_url'` votes; centroid blacklist (Madrid Sol `40.4168,-3.7035`);
  R = 75–120 m via haversine.
- **C4 Pure-TS only**: inline Jaro-Winkler (~30–40 lines) + haversine (~8 lines); NO
  libpostal / dedupe.io / `pg_trgm`.
- **C5 Idempotency**: stable survivor `id`; skip already-`duplicate` losers on re-run;
  `entity_sources` UNIQUE `(entity_type, entity_id, source_item_id)`.
- Status convention + survivor-id strategy + backfill of the 90 seed rows: see R2.

### D. Recurring Events  *(absorbs `repeateable-events`)*
- **D1 Parent series + child occurrences** (not RRULE-only, not `series_id`-on-events).
  Hybrid RFC-5545: optional `rrule` text for display, but materialized occurrences are
  the truth (calendar-app pattern). See `data-model.md` D for the full schema.
- **D2 Normalizer**: `normalizeHemisferic()` rewritten to emit one series + its
  occurrences via a shared `upsertSeries(series, occurrences[])` helper in
  `lib/pipeline/series.ts` (reusable by future recurring-aware normalizers).
- **D3 Series-level enrich/score/notify** (104→11). Idempotent: unchanged schedule =
  0 INSERTs, 0 `enriched_at` resets, only `last_seen` bumps.
- **D4 Surfaces**: feed lists `event_series`; calendar buckets `event_occurrences` by
  date; `is_hemisferic` special-case → generic `is_series`/`occurrence_count`; detail
  page shows the full schedule.
- **D5 Scope**: single-shot events stay in `events` (~228 untouched); only
  recurring/multi-session sources populate series (small blast radius, reversible).
  Old Hemisfèric event rows marked `status='superseded'`, not deleted.
- **D6 Dedup interplay**: dedup scans only `events`/`places`, never occurrences.
  Series identity is per-source (title+venue+source); cross-source series dedup is
  **deferred** (see Part 4).

### E. Card Enrichment  *(absorbs `card-enrich`; merges `llm-testing`'s schema/SDK half)*
- **E1 Engine**: `@anthropic-ai/sdk` `messages` with constrained-decoding structured
  output (`output_config.format`, `additionalProperties:false`, no min/max in schema,
  `effort: low`, no temperature). `claude -p` fallback behind the same interface (R3).
- **E2 Functions**: `enrichOne(row, {client, web, exec})` + `enrichCards(limit, {dry,
  client, exec})`, injectable client (mirrors `dedup({exec})`). Selection: `WHERE
  enriched_at IS NULL ORDER BY score DESC NULLS LAST LIMIT $limit`; per-item try/catch;
  on error leave row un-enriched.
- **E3 Canonical schema**: the superset in `data-model.md` E (event-106 shape verbatim
  + `confidence`/`notes`/`citations`/`ocr_text`). `llm-testing`'s narrower schema is a
  strict subset — fixtures point at the superset.
- **E4 OCR + translate + extract in one call**: poster image as an `image` content
  block; one call does OCR + RU translation + field extraction (avoids the old
  180s/60s single-call timeout).
- **E5 Web augmentation** (optional, `{web}` flag): Anthropic `web_search` +
  `web_fetch` server tools, two-turn shape (tool turn loops on `pause_turn`, then a
  constrained parse turn) because structured-output + server-tools can't compose in
  one turn. `web_fetch` can only read URLs already in context (seed `source_url`/
  `links_json`). `max_uses: 3` (~$0.03/card worst case). Offline fallback: app-side
  `fetchText` of `source_url` into the prompt.
- **E6 Anti-hallucination "ground-or-flag"** (Constitution I/IV): never invent;
  conflicts → `notes` + higher-authority pick + lowered confidence; every added fact
  cited; translation preserves names/dates/numbers/venue verbatim.
- **E7 Model tiering & cost**: Haiku 4.5 default; escalate to Opus 4.8 for
  poster-only/heavy-OCR/low-confidence/conflict. Web search billed separately
  ($10/1k). `COALESCE` guards on promote-to-column writes. Enrich does not geocode.
- **E8 events maps_url**: store as a `links_json` entry (no migration); `places` use
  existing `places.maps_url` (see `data-model.md` facts).
- **E9 Re-enrichment**: `enriched_at IS NULL` OR `last_seen > enriched_at` OR force.

### F. Outputs & Surfaces  *(from 001 D6; gap-filled)*
- **F1 Events afisha**: existing `app/page.tsx` + `Home.tsx` (feed + current-month
  calendar + Leaflet map) + `events/[id]`; extend feed to UNION single-shot `events`
  and `event_series` (JS sort by score across the two), calendar to query occurrences.
- **F2 Places catalog** (Constitution III independent output): new
  `app/places/page.tsx` with facet filters (cuisine/category, district/area, occasion,
  `price_level`, `recommended_by`); reuse `places/[id]`. Mine places during
  normalization of place-rich channels (`rutatuta_vlc`, `logunespa`, `gosvetlanada`,
  Fever gastro). Must render even when the events pipeline has gaps.

### G. Notifications  *(gap-filled; named everywhere, specced nowhere before)*
- **G1 `lib/pipeline/notify.ts`**: `selectDigest({horizonDays, threshold})` pure
  selector (family-fit tags + `notified=0` + date window + `score ≥ threshold` +
  `confidence ≥ holdThreshold`) returning events/series + new places;
  `selectAlerts({alertThreshold})` (higher bar). On send: set `notified`/`notified_at`
  + insert `notifications` row; series render the card + next upcoming occurrence.
- **G2 Transport** (resolved gap): default **dry-run text output** behind a pluggable
  `sendDigest(payload)`; a real transport (single private chat/webhook or email)
  behind an env flag. Start dry.
- **G3 Endpoint**: `app/api/cron/digest/route.ts` (Bearer), `?mode=weekly|alert`,
  `?dry=1`. Weekly trigger `0 7 * * 5` UTC (~Fri 09:00 Europe/Madrid, DST in-handler).

### H. Local Dev *(tooling — absorbs `local-run`)*
- **H1 DB strategy**: Dockerized Postgres 15 + local Neon HTTP proxy
  (`ghcr.io/timowilhelm/local-neon-http-proxy:main`, port 4444,
  `useSecureWebSocket=false`, `poolQueryViaFetch=true`). **Not** a `pg` driver
  abstraction — preserves both `@neondatabase/serverless` call shapes (tagged-template
  `sql\`...\`` and `sql.query(text, values)`) with zero query-site rewrites.
- **H2 Neon shim**: gate `neonConfig.fetchEndpoint` on the host substring
  `db.localtest.me` (NEVER on `NODE_ENV`, to avoid accidental prod activation). Local
  `DATABASE_URL = postgresql://postgres:postgres@db.localtest.me:5432/main`.
- **H3 Scripts/deps**: add `tsx` devDep (`run-pipeline.mjs` needs
  `register('tsx/esm')`); npm scripts `db:local:up`/`db:local:down`/`db:setup`/
  `dev:local`. `LOCAL_RUN.md` checklist mapping to SC-001..SC-011 (digest/alert/enrich
  rows marked "pending implementation" until built).
- **H4 Offline vs network**: normalize/dedup/score/tag are pure DB+CPU (offline on
  seed); ingest/geo/enrich need network/key. Tier-B fallback: a Neon dev-branch URL
  (shim no-ops on cloud host).

### I. LLM Evaluation *(tooling — absorbs `llm-testing`'s eval half)*
- **I1 Two layers**: mocked offline `npm test` (`node --test`, stubbed client, no
  key/network, deterministic) vs key-gated `npm run eval` (real calls, excluded from
  CI default, skipped when `ANTHROPIC_API_KEY` unset).
- **I2 Tooling**: `promptfoo` (dev-only dep) wrapping the real `enrichOne` via a
  custom-script provider; `node:test` for pure-logic units (date parser, venue
  normalizer, link extractor, schema-shape, fail-soft, `COALESCE`).
- **I3 Fixtures**: `tests/fixtures/enrich/*.json` (10–25 cases) keyed on **series**
  (not duplicated rows); seed from real backlog (Komissarenko 3-source, RU Telegram
  posts, an ES poster for OCR).
- **I4 Assertions**: `is-json` + Ajv (100% pass), fuzzy date (±0 days), venue
  Levenshtein ≥0.85, `llm-rubric` RU-quality (Haiku grader, ≥0.7). Bounds live in
  test assertions, not the JSON-schema.

---

## Part 3 — Original 001 decisions (preserved for traceability)

- **D1 Scheduler** → folded into A6/B2/R5: Vercel daily cron + GH Actions for finer
  cadence + Friday digest. Hobby tier, no paid plan.
- **D2 Dedup strategy** → folded into C (now two-layer, with `entity_sources`).
- **D3 Batched enrichment** → folded into E (engine now SDK per R3, but the
  per-item-cap, fail-soft, not-on-hot-path principles are unchanged).
- **D4 Normalizer registry** → folded into A1/A2 (kept; parser registry added).
- **D5 Testing (`node:test`)** → folded into I (kept as the deterministic layer;
  promptfoo added for live eval).
- **D6 Places catalog** → folded into F2 (kept; enrichment + dedup for places added).

---

## Part 4 — Explicitly deferred (named placeholders, not silent drops)

- **Cross-source series dedup**: series identity stays `title+venue+source`; two
  sources listing the same recurring show yield two series for now.
- **LLM dedup tie-break**: optional, flag-gated, off by default; ambiguity trigger
  and harness not scoped now.
- **Per-source conditional-GET trust matrix**: which of the 22 sources honor
  ETag/Last-Modified is untested — one-time empirical task; item-hash delta is the
  safe default until then.
- **Vercel Pro multi-cron upgrade**: stay Hobby + GH Actions; revisit if Pro adopted.
- **End-to-end run observability dashboard**: `source_runs` + Workflow run-traces
  (1-day Hobby retention) exist; a single "is the whole run green" operational view is
  not yet specced beyond `LOCAL_RUN.md`.

## Open items (non-blocking)

- Notification **transport** choice (dry-run default until a real channel is picked).
- Whether to also fan-out per-source normalizers as parallel Workflow steps now or
  keep `normalizeAll` as one step initially (recommend: one step first).
