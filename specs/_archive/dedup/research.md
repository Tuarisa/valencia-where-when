---
spec: dedup
phase: research
created: 2026-06-20T15:30:00Z
---

# Research: dedup — deduplication "из исходников" (events AND places)

## Executive Summary

`lib/pipeline/dedup.ts` exists (spec 001 T024) but is **post-normalization, events-only,
and NOT wired into the pipeline** (T025 unchecked; absent from `run.ts` and the cron
route). It satisfies a *fuzzy entity-resolution* layer but does NOT satisfy "из
исходников" (grounded in raw `source_items`): it never reads raw signals, never links a
survivor to contributing `source_item_id`s, and has no places path. Recommendation: keep
the good pure helpers, **extend** (not rewrite) into a two-layer design — a deterministic
**source-identity** layer keyed on raw `url`/`external_id`/`dedup_hash`, plus an entity-
resolution layer that records EVERY contributing `source_item_id` in an additive
`entity_sources` link table — and add a **places** resolver (name + address + geo, with
hard guards against the Madrid-centroid false-merge found in seed data).

## Key Findings

### F1 — Existing `dedup.ts`: honest gap assessment

| Dimension | Current state (`lib/pipeline/dedup.ts`) | "Из исходников" requires |
|-----------|------------------------------------------|--------------------------|
| Input level | Reads **normalized `events`** (`SELECT e.* FROM events`) | Also reason over raw `source_items` (url/external_id/dedup_hash/published_at/images) |
| Entities | **Events only** | Events **and places** |
| Source links | `metadata_json.sources[] = {source, source_url}` (strings, normalized) | Link to every contributing **`source_item_id`** (FK to raw layer) |
| Strong signals | None — only fuzzy title-sig + city + ±3d date window | Exact `url`/`external_id` match = deterministic strong-match |
| Wired? | **NO** — not in `run.ts`, not in `/api/cron/refresh` (T025 ☐) | Must run as the `dedup` stage (constitution V order) |
| Idempotent identity | Survivor = a *normal* event row; losers `status='merged'` | Stable canonical id so enrich/notify/score attach once |

What is **good** and must be kept: pure, DB-free, unit-tested helpers
(`titleSignature` token-sort signature, `dedupKey` = `sig|city`, `groupByKey` with
date-window sub-splitting, `chooseSurvivor` by `(weight rank, score)`, `mergeGroup`
source accumulation, injectable `exec`). The blocking + survivor + accumulate skeleton is
sound ER; the gap is *what it reads/links*, not *how it groups*.

### F2 — The real Слава Комиссаренко 3→1 case (seed, `data/seed/events.json`)

```
id 2   | "Слава Комиссаренко"                   | 2026-06-21 | web:worldafisha | .../slava-komissarenko-stendap... | status=upcoming
id 106 | "Слава Комиссаренко с новой программой"| 2026-07-21 | tg:concerten    | t.me/concerten/1263               | status=duplicate
id 110 | "Слава Комиссаренко"                   | null       | web:worldafisha | worldafisha.com/persons/slava-... | status=duplicate
```

Two findings:
- The seed already encodes the *answer* with the **Python prototype's convention**:
  `status='duplicate'` + `metadata_json={"merged_into":2,"normalized_from":"<src>"}`
  (90 such rows). The TS code uses a **different** convention: `status='merged'` +
  `metadata.sources[]`. **Conventions diverge** → must be reconciled (pick one; migrate).
- Dates conflict by a **month** (06-21 vs 07-21), and id 110 has `start_date=null`.
  The ±3-day window in `groupByKey` would **NOT** merge id 2 and id 106 (30 days apart) —
  it would split them into separate occurrences. id 110 (null date) anchors with the
  earliest. So the *current fuzzy layer fails this exact case*: it needs the deterministic
  signal that all three are the same **person/series** (same artist slug + `worldafisha`
  shares the same `persons/slava-komissarenko` URL between id 2 & 110). This is precisely
  why "из исходников" / strong-match on url/person is required, not just date-window.

### F3 — Places: forward-looking, with a severe false-merge trap (seed, `data/seed/places.json`)

- Only **14 places** from 3 sources (`rutatuta` ×1, `vidacultural` ×5, `logunespa` ×8);
  **zero** name-collisions today → no actual cross-source place dup yet. Places dedup is
  *preventive design* for when rutatuta/logunespa/gosvetlanada/Fever overlap.
- **`recommended_by` is a single string** today (e.g. `"rutatuta"`, `"tg:logunespa"`) —
  the multi-source equivalent of events' `sources[]` does not exist for places yet.
- **FALSE-MERGE TRAP (verified):** several places share **identical coords**:
  - `39.4697065,-0.3763353` → ids **4, 7, 8** (Parc de l'Oest pool + two `logunespa`
    cafés). This coord is geo.ts's geocode of an *area*, not the venue.
  - `40.416782,-3.703507` → ids **10, 11, 12** = **Madrid's Puerta del Sol centroid** — a
    Nominatim fallback for un-resolvable `maps.app.goo.gl` short links.
  6 place pairs sit `<150 m` apart purely from placeholder/fallback coords. **A naive
  geo-distance place matcher would catastrophically merge distinct venues.** Geo proximity
  must be a *corroborating* signal gated behind name/category agreement and `geo_source`
  trust — never a standalone merge key.
- Places 7–14 have **`name` = the raw `maps.app.goo.gl` URL** (un-normalized; geo.ts /
  enrich hasn't run). Name-based matching is unreliable until enrich names them → another
  reason places dedup should run **after** enrich for the hard cases, or use `maps_url`
  identity as the strong key.

### F4 — Raw layer already carries the "из исходников" signals

`source_items` (`db/schema.sql`) has exactly what a source-grounded layer needs:
`dedup_hash` (UNIQUE), `source_key`, `external_id`, `url`, `published_at`, `raw_text`,
`raw_html`, `raw_json`, `item_type`. Ingest already **deduplicates raw items** within/
across runs via `sourceItemHash` (`util.ts`: `source_key|external_id|norm(url)|
norm(title)|norm(raw_text)` → sha1short, UNIQUE upsert in `ingest.ts:upsertSourceItem`).
So **raw-item identity dedup already exists** — the missing piece is propagating
`source_item_id` into the *entity* merge and matching entities on raw `url`/`external_id`.
`events`/`places` each have a single `source_item_id` column (one raw item only) →
insufficient to record *every* contributing source after a merge.

### F5 — Constitution constraints (`.specify/memory/constitution.md`)

- **I. Data Integrity First** — raw `source_items` append-only; dedup may **mark** but
  never delete; "surviving entity MUST retain a link to **every** contributing source";
  conflicts resolve by **weight + score**. (Directly mandates the link table + survivor rule.)
- **V. Static-First** — canonical pipeline order is **`ingest → normalize → dedup → score
  → tag → geo → enrich`**. Dedup runs **right after normalize**. (Current 001 T025 said
  "between tag and geo" — *contradicts the constitution order*; flag.)
- **III. Two Independent Outputs** — events afisha and places catalog must not block each
  other → events dedup and places dedup must be **independently runnable / fail-soft**.
- **VI. Reversible Automation** — schema changes via `db/schema.sql` migration; build green.

### F6 — No fuzzy-matching deps; pure-TS is the house style

`package.json`: deps = neon/next/react only; devDeps = types/typescript. No
Jaro-Winkler/trigram lib, no test framework (`node --test`), no Makefile, no CI, no
Docker. House pattern = **pure TS helper + `.mjs` logic mirror + injectable `exec`**
(see `dedup.test.mjs`, confirmed across llm-testing/local-run learnings). Adding heavy ER
deps (libpostal C lib, dedupe.io Python) is **off-stack** — keep a small pure-TS
Jaro-Winkler/trigram (~30 lines) over a dependency.

## Decisions

### D1 — "Из исходников" architecture = deterministic source-identity layer + fuzzy entity-resolution layer, recording every `source_item_id`

**Decision:** Two layers, both source-grounded:
1. **Source-identity (deterministic, strong-match):** before/within entity merge, treat
   two entities as the *same* when their raw items share `external_id` (per source) or a
   normalized `url`, OR when one survivor's person/series URL (`worldafisha/persons/...`)
   equals another's. Signals come **straight from `source_items`** (`url`, `external_id`)
   carried onto the entity at normalize time. This is high-precision, testable, cheap.
2. **Entity-resolution (fuzzy, weak-match):** the existing `groupByKey` blocking
   (title-sig + city) + date-window for events; name + address + gated-geo for places.
   Confirms candidates the deterministic layer didn't catch (transliteration, reordering).
3. **Record EVERY source:** on merge, write one row per contributing raw item into a new
   additive **`entity_sources`** link table (see Schema). The survivor keeps a stable id;
   `metadata_json.sources[]` stays as a denormalized convenience for render.

**Rationale:** Matches the verified incremental-ER best practice — *strong deterministic
rules first, fuzzy only for the residue*, with a **stable canonical id** so re-runs don't
thrash ([OpenSanctions](https://www.opensanctions.org/docs/identifiers/),
[RudderStack](https://www.rudderstack.com/blog/what-is-entity-resolution/)). Satisfies
constitution I (link to every source) literally via FK rows, not just string blobs.

**Alternatives considered:**
- *(a) Raw-only dedup (merge `source_items` before normalize).* Rejected as the *sole*
  mechanism: violates append-only spirit if it collapsed raw rows, and raw text is too
  noisy to entity-resolve reliably (a Telegram post ≠ a clean event). Raw-item identity
  *already* exists (`sourceItemHash`); we reuse it, we don't redo it.
- *(b) Entity-only (today's dedup.ts).* Rejected as the *sole* mechanism: loses the
  source-item link and the strong url/external_id signal → fails the Komissarenko case.
- **(c) Hybrid (chosen).** Deterministic source-identity + fuzzy entity layer + link table.

### D2 — Places entity resolution (NEW)

**Decision:** New pure helpers mirroring events:
- **Block key** `placeKey` = `nameSignature(name) | area-or-district-slug | category`.
  Reuse `titleSignature`-style token-sort over `slugify(name)`; fall back to `city` when
  area null.
- **Strong-match (deterministic):** identical `maps_url` (after short-link resolution) OR
  identical `external_id` per source → same place, regardless of name noise. (Handles the
  "name is a raw goo.gl URL" rows.)
- **Fuzzy-match:** name Jaro-Winkler ≥ τ **AND** category compatible **AND** (address
  token overlap **OR** geo within R metres) → same place. **Geo is corroborating only.**
- **Geo guard (critical):** ignore proximity when `geo_source ∈ {nominatim-area-fallback}`
  or when coords equal a known centroid (Madrid Sol `40.4168,-3.7035`); require
  `geo_source='map_url'` (resolved venue pin) for geo to *vote*. Distance via haversine
  (pure, ~8 lines) or geohash bucket; **R small (~75–120 m)** and never alone.
- **Survivor/merge:** same `(weight rank, score?)` rule; places have no score today → use
  `(weight rank, has-coords, first_seen)`. **`recommended_by` becomes the union** of all
  contributors (mirrors events `sources[]`); accumulate into `entity_sources` + a
  `recommended_by[]` in `metadata_json`.

**Rationale:** Mirrors the verified place-dedup canon — name + address + geohash, with
ML/embeddings as the *heavy* option Facebook/OpenVenues use at scale
([Deduplicating a places database, WWW'14](https://dl.acm.org/doi/10.1145/2566486.2568034);
[libpostal/OpenVenues](https://github.com/openvenues/libpostal)). At 14 places we do **not**
need libpostal/embeddings; a normalize-then-match string + gated-geo rule is sufficient and
on-stack. The geo guard is forced by the seed's Madrid-centroid trap (F3).

**Alternatives:** geohash-prefix blocking (overkill at this scale, revisit at 1k+ places);
libpostal address parsing (off-stack C dep — defer); embeddings on names (cost/determinism
— defer, possible future LLM tie-break only).

### D3 — Events dedup hardening (source-grounded)

**Decision:** Add a **strong-match pre-pass** before the fuzzy `groupByKey`:
- Same normalized `url` OR same `(source, external_id)` across rows → merge immediately
  (deterministic), independent of date window. Fixes Komissarenko id 2↔110 (shared
  `worldafisha/persons/slava-komissarenko` person URL).
- Add a **person/series slug** signal (artist name) so id 106 (different date, different
  title suffix, different channel) joins via person identity even though it's 30 days from
  id 2 → but **guard against over-merge**: only collapse different-date same-person rows
  when they are *not* a legitimate recurring series (defer the series call to
  `repeateable-events`; for now, same-person + far date = keep separate occurrences but
  **link as related**, don't hard-merge). Keep date-window for same-occurrence conflicts.
- Conflicting dates within window still resolve by weight+score (already correct).

**Rationale:** The fuzzy-only layer demonstrably fails the headline case; the deterministic
url/external_id signal is exactly the "из исходников" grounding the goal asks for.

**Alternatives:** widen the date window (rejected — explodes false-merges across a series);
LLM judge for every pair (rejected — cost/determinism; reserve for tie-breaks only, D4).

### D4 — Matching technique = deterministic-first + small pure-TS fuzzy; LLM/embeddings optional tie-break only

**Decision:**
1. **Deterministic** (exact `url`/`external_id`/`maps_url`, normalized-key blocking) — the
   high-precision core, fully unit-tested, no deps.
2. **Fuzzy within blocks** — pure-TS **Jaro-Winkler** (names/titles) + token/trigram
   overlap + date window (events) + gated haversine (places). ~40 lines, no dep.
3. **LLM tie-break (optional, off by default):** only for *ambiguous* pairs the rules
   can't settle, behind a flag, never in the deterministic path — keeps the core testable
   and cheap (aligns with `llm-testing`/`card-enrich` posture: LLM is decoration, not core).

**Rationale:** Verified ER canon — *deterministic rules first, Jaro-Winkler for names,
blocking to avoid O(n²), delegate only hard cases to LLM/human*
([Data Ladder Fuzzy Matching 101](https://dataladder.com/fuzzy-matching-101/),
[Neo4j Agent Memory ER](https://neo4j.com/labs/agent-memory/explanation/resolution-deduplication/)).
Keeps determinism/testability (constitution VI) and no new heavy deps (F6).

**Alternatives:** embeddings/`dedupe.io` ML (off-stack Python, defer); pg_trgm in Postgres
(possible future blocking accelerator — DB-side, defer until volume warrants).

### D5 — Pipeline placement + idempotency + stable identity

**Decision:**
- Run **`dedup` immediately after `normalize`** (constitution V order), before score/tag/
  geo/enrich — so scoring/geo/enrich operate on **survivors only** (saves enrich $; see
  `card-enrich`). Wire into `run.ts` and `/api/cron/refresh` (closes 001 T025).
- **Idempotent:** survivor selection is deterministic given the same rows; re-running must
  not re-merge already-merged losers (filter `status` ≠ merged/duplicate on load) and must
  not thrash survivor identity. The survivor's `events.id` / `places.id` is the **stable
  canonical id**; enrich/notify/score key off it. `entity_sources` upserts are idempotent
  on `(entity_type, entity_id, source_item_id)`.
- **Never delete** `source_items` (constitution I) — only mark entity losers
  (`status='duplicate'`, `merged_into=<id>`) and append link rows.

**Rationale:** Incremental ER best practice = stable canonical id + idempotent re-match of
new/changed rows only ([OpenSanctions](https://www.opensanctions.org/docs/identifiers/)).
Running before enrich is the cost lever (`card-enrich`: 1/342 enriched, enrich is $$).

## Proposed schema / keys (additive — migration in `db/schema.sql`)

**New link table — the "из исходников" core (records every contributing raw item):**
```sql
CREATE TABLE IF NOT EXISTS entity_sources (
    id             SERIAL PRIMARY KEY,
    entity_type    TEXT NOT NULL,          -- 'event' | 'place'
    entity_id      INTEGER NOT NULL,       -- survivor events.id / places.id (stable canonical id)
    source_item_id INTEGER,                -- FK → source_items.id (the raw item)
    source_key     TEXT,                   -- denormalized for fast filtering
    source_url     TEXT,
    role           TEXT DEFAULT 'merged',  -- 'primary' (survivor's own) | 'merged'
    match_method   TEXT,                   -- 'url' | 'external_id' | 'maps_url' | 'fuzzy-title' | 'fuzzy-name-geo'
    match_score    DOUBLE PRECISION,       -- confidence (1.0 deterministic; <1 fuzzy)
    created_at     TEXT NOT NULL,
    UNIQUE(entity_type, entity_id, source_item_id)   -- idempotent re-runs
);
CREATE INDEX IF NOT EXISTS idx_entity_sources_entity ON entity_sources(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_sources_item   ON entity_sources(source_item_id);
```

**Keys / signatures (pure helpers, in `lib/pipeline/dedup.ts` + new places path):**
- Events block key (exists): `dedupKey = titleSignature(title) | slugify(city)`.
- Events strong key (NEW): `norm(url)` and `(source, external_id)` and person-URL.
- Places block key (NEW): `placeKey = nameSignature(name) | (area|district|city) | category`.
- Places strong key (NEW): resolved `maps_url`, `(source, external_id)`.

**Convention reconciliation (pick ONE, migrate seed):** standardize on
`status='duplicate'` + `metadata_json.merged_into=<id>` (matches the 90 existing seed rows
+ render expectations) and **deprecate** the code's `status='merged'`; ALSO populate
`metadata.sources[]` + `entity_sources` rows. (Or vice-versa — requirements must decide; do
NOT ship both conventions.)

**Additive columns (optional):** `places.recommended_by` → keep string for back-compat but
treat `metadata_json.recommended_by[]` as canonical multi-value. Consider
`events.canonical_id` only if a separate "merge group" id is wanted over reusing
survivor.id (recommend reusing survivor.id — simpler, stable).

## Migration / repro plan

1. **Repro the gap (BEFORE):** unit test that loads the 3 Komissarenko seed rows → assert
   current `groupByKey` does **NOT** merge id 2 + id 106 (30-day gap) and drops the
   `source_item_id` links → documents the failure (`reality-verification` posture).
2. Add `entity_sources` table to `db/schema.sql`; `scripts/apply-schema.mjs` is idempotent
   (`CREATE TABLE IF NOT EXISTS`).
3. Extend `dedup.ts`: deterministic strong-match pre-pass (url/external_id/person), emit
   `entity_sources` rows on every merge, reconcile status convention.
4. New `dedupPlaces` path (pure helpers + orchestrator) with the geo guard.
5. Wire `dedup` into `run.ts` after `normalize` and into `/api/cron/refresh` (T025).
6. **Verify (AFTER):** Komissarenko → 1 survivor (id 2) with 3 `entity_sources` rows;
   places test asserts Madrid-centroid trio (10/11/12) and pool/café trio (4/7/8) are
   **NOT** merged despite identical coords. `npm run build` green; `node --test tests/`.
7. Backfill: one-time pass to create `entity_sources` for the 90 existing seed duplicates
   from their `merged_into` + `source_item_id`.

## Cross-spec impact

| Spec | Impact | Needed update |
|------|--------|---------------|
| **001-valencia-events** | This spec **supersedes/extends T024–T026**. T024 built events-only post-norm dedup; this adds source-grounding, places, link table. | Mark T024 extended; **fix T025** placement to *after normalize* (matches constitution V), not "between tag and geo". |
| **repeateable-events** | **High / mutual constraint.** Dedup must NOT collapse distinct occurrences of a series (Hemisfèric: 104 rows = 11 films × 14 days). Their decided model = `event_series` + `event_occurrences`. Dedup operates on **series/occurrence identity**, not raw occurrences. | Coordinate: dedup's date-window already *splits* far dates (won't collapse a series); the Komissarenko person-link must produce **related/series**, not a hard merge. Define the series-id vs survivor-id boundary jointly. `mayNeedUpdate: true`. |
| **card-enrich** | **High.** Enrich the **survivor once** → dedup MUST run before enrich (D5) so 342→~252 (and series→11) enrich targets. Enrich proposes clean `name`/`maps_url` that *improve* later place dedup. | Note ordering dependency; enrich keys off stable survivor id. `mayNeedUpdate: true` (ordering). |
| **vercel-workflow** | **Medium.** `dedup` becomes a `'use step'` in the workflow DAG, after the normalize step, before score/geo/enrich. Idempotent step = safe retry. | Add dedup as an explicit step; ensure its writes are idempotent for step-retry. `mayNeedUpdate: true`. |
| **local-run** | **Low.** Dedup is offline-capable (pure DB+CPU, no network) — already listed as offline stage. | None. `mayNeedUpdate: false`. |
| **llm-testing** | **Low/Medium.** If D4's optional LLM tie-break lands, it becomes an LLM call to eval. | FYI; covered by their harness if used. `mayNeedUpdate: false` now. |

## Risks

| Risk | Severity | Mitigation |
|------|----------|-----------|
| **False merge of distinct venues via placeholder/centroid coords (Madrid Sol, area-fallback)** — VERIFIED in seed | **High** | Geo is corroborating only, gated on `geo_source='map_url'`; small R; never merge on geo alone; centroid blacklist. |
| Person-link over-merge collapses a legitimate series into one card | High | Don't hard-merge far-date same-person; link as related; defer series to `repeateable-events`. |
| Convention split (`status='merged'` vs `'duplicate'`) leaves render/dedup inconsistent | Medium | Reconcile to ONE convention + migrate seed before wiring. |
| Idempotency thrash (survivor id flips across runs → enrich/notify re-fire) | Medium | Deterministic survivor; `entity_sources` UNIQUE; skip already-merged rows on load. |
| Fuzzy threshold τ too loose merges different artists/venues | Medium | Conservative τ; require ≥2 signals (name+geo / title+date); golden tests. |
| Adding heavy ER deps (libpostal/dedupe) | Low | Pure-TS Jaro-Winkler/haversine; defer deps to a justified future volume. |

## Feasibility / Risk / Effort

| Aspect | Assessment | Notes |
|--------|------------|-------|
| Technical Viability | **High** | Solid pure-helper skeleton exists; extension is additive; raw signals already present. |
| Effort Estimate | **M (–L)** | M for events hardening + link table + wiring; +S–M for the new places path & geo guard. |
| Risk Level | **Medium** | Driven almost entirely by **false merges** (places geo trap, series over-merge) — controllable with golden tests + conservative rules. |

## Quality Commands

| Type | Command | Source |
|------|---------|--------|
| Lint | `npm run lint` | package.json scripts.lint (next lint) |
| TypeCheck | Not found (covered by `next build`) | no standalone tsc script |
| Unit Test | `node --test tests/` / `npm test` | package.json scripts.test |
| Build | `npm run build` | package.json scripts.build (compile gate, constitution VI) |
| Pipeline | `npm run pipeline:run` | package.json scripts.pipeline:run (needs DATABASE_URL; broken locally per local-run — needs `tsx`) |

**Local CI**: `npm run lint && npm run build && node --test tests/`

## Verification Tooling

No automated E2E/browser tooling. Project is a pipeline + Next.js site; dedup is a backend
pure-logic stage verified by unit tests over seed fixtures.

| Tool | Command | Detected From |
|------|---------|---------------|
| Unit (logic mirror) | `node --test tests/dedup.test.mjs` | tests/ house pattern |
| Build gate | `npm run build` | constitution VI |
| Pipeline (DB) | `npm run pipeline:run` | scripts/run-pipeline.mjs (DATABASE_URL gated; `tsx` missing locally) |
| Health endpoint | `/api/cron/refresh` | app/api/cron/refresh/route.ts |

**Project Type**: Data pipeline + Next.js site (no browser E2E).
**Verification Strategy**: Golden-fixture unit tests over `data/seed/*.json` (Komissarenko
3→1 with link rows; places NON-merge of identical-coord trios), then `npm run build` green.

## Open Questions (for requirements)

1. **Convention:** standardize on `status='duplicate'`+`merged_into` (seed/render) or the
   code's `status='merged'`+`sources[]`? (Must pick one; affects migration of 90 rows.)
2. **Series vs dedup boundary:** for same-person, far-date events (Komissarenko 06-21 vs
   07-21) — keep as separate occurrences *linked as related*, or defer entirely to
   `repeateable-events`? Where does the series-id live vs survivor-id?
3. **Places geo trust:** acceptable R (75 m? 120 m?) and the exact `geo_source` whitelist
   that lets geo *vote*? Maintain a centroid blacklist (Madrid Sol etc.)?
4. **LLM tie-break:** in scope now (flag-gated) or explicitly deferred to a later spec?
5. **Backfill scope:** generate `entity_sources` for the 90 existing seed duplicates, or
   only forward-fill on the next pipeline run?
6. **Survivor id strategy:** reuse `survivor.events.id`/`places.id` as canonical (simpler),
   or introduce a separate `canonical_id`/merge-group id?

## Sources

- `lib/pipeline/dedup.ts`, `tests/dedup.test.mjs`, `lib/pipeline/normalize.ts`,
  `lib/pipeline/normalizers/{types,hemisferic}.ts`, `lib/pipeline/ingest.ts`,
  `lib/pipeline/util.ts`, `lib/pipeline/geo.ts`, `lib/pipeline/run.ts`, `lib/format.ts`,
  `lib/db.ts`
- `db/schema.sql`; `data/seed/{events,places,sources}.json`
- `.specify/memory/constitution.md`; `specs/001-valencia-events/{data-model.md,tasks.md}`
- Cross-spec `.progress.md`: repeateable-events, card-enrich, vercel-workflow, local-run, llm-testing
- [Entity Resolution best practices — RudderStack](https://www.rudderstack.com/blog/what-is-entity-resolution/)
- [Fuzzy Matching 101 — Data Ladder](https://dataladder.com/fuzzy-matching-101/)
- [Deduplicating a places database — WWW'14 (Facebook)](https://dl.acm.org/doi/10.1145/2566486.2568034)
- [libpostal / OpenVenues](https://github.com/openvenues/libpostal)
- [Identifiers & deduplication — OpenSanctions](https://www.opensanctions.org/docs/identifiers/)
- [Entity Resolution & Deduplication — Neo4j Agent Memory](https://neo4j.com/labs/agent-memory/explanation/resolution-deduplication/)
