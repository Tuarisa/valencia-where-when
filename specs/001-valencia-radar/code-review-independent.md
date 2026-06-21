# Valencia Radar — Independent Architecture Review

**Reviewer:** senior-architect fresh-eyes pass (read the code, not the docs)
**Date:** 2026-06-21
**Scope:** `lib/pipeline/**`, `lib/{db,queries,util,format}.ts`, `app/**`, `db/schema.sql`, `scripts/**`, the seed/bake strategy, test seams.
**Method:** read the correctness-critical modules (dedup, geo, enrich, ingest, normalize, queries) directly; fanned out two read-only sub-surveys for the ~18 normalizers and the build/seed scripts; cross-checked claims against the actual source. This is a judgment of the code on its own merits.

---

## 1. Executive summary

The pipeline has a genuinely good *micro*-architecture and a weak *macro*-architecture. At the function level the team has internalized two patterns very well and applied them consistently: (a) **pure core + injectable `exec`** — almost every stage splits a DB-free, unit-testable pure layer (`buildXEvents`, `dedupKey`, `scoreEvent`, `selectDigest`, `sourceStale`, the whole `cadence.ts`) from a thin DB orchestrator that takes an injectable `sql` executor; and (b) **idempotent upsert keyed on a content `dedup_hash`** with `ON CONFLICT DO UPDATE` that deliberately preserves downstream state (`enriched_at`, `score`, `notified`). That discipline is the project's biggest asset and is rare to see sustained across 30+ modules.

The biggest structural risk is the **absence of any shared module boundary among the ~18 normalizers**, which is the bulk of the code and the part that grows. There is no `normalizers/shared`; instead `worldafisha.ts` (a *source* normalizer) has silently become the de-facto core utility module — 15 sibling normalizers `import { parseEventDate, upsertPlainEvent, EventInsert } from "./worldafisha"`, while `fever.ts` forked its own *second* copy of the events `INSERT … ON CONFLICT` SQL. The events-table column set is independently re-declared in at least five hand-maintained places (DDL, two+ normalizer INSERTs, `export-seed.mjs`'s 44-col SELECT, the migration's SELECT, the `SiteEvent` TS interface), so a single `ALTER TABLE` silently desyncs the seed round-trip. Secondary risks: pervasive N+1 write loops over a *serverless HTTP* SQL driver (no transactions, no batching), a wired-but-broken series no-repeat path in the digest route, and a `types.ts` whose declared `Normalizer`/`NormalizedOut` contract no description implements (dead, misleading API). None of these are emergencies — the system builds, tests, and renders — but they are exactly the kind of structural debt that makes the *next* twenty sources expensive.

---

## 2. Strengths (keep these)

- **Pure-core / injectable-`exec` seam, applied uniformly.** `dedup.ts` is the model: every decision (`titleSignature`, `strongMatchKey`, `isMergeableGroup`, `mergeGroup`, `geoCorroborates`, `haversineMeters`, `jaroWinkler`) is a pure, exported, individually-testable function, and `dedup({ exec = sql })` is the only DB-aware shell. `cadence.ts` and `health.ts` are 100% pure with the clock passed in. This is the right shape and is *why* the project can claim ~290 tests without a database.
- **Idempotent content-hash upserts that protect downstream state.** `upsertPlainEvent` / `upsertSeries` `ON CONFLICT (dedup_hash) DO UPDATE` lists deliberately omit `score`, `enriched_at`, `enrichment_json`, `title_ru`, `notified` (`lib/pipeline/series.ts:104`, `worldafisha.ts:321`). A re-ingest cannot clobber an enrichment. This is the single most important correctness property for a re-running pipeline and it is honored consistently.
- **The dedup over-merge guards are well-reasoned.** The `isMergeableGroup` ≥2-distinct-source rule + `untitled`-signature guard + the `isStrongCollapsible` gate on the strong pre-pass (`dedup.ts:174`, `:331`) encode real, hard-won invariants ("recurring occurrences are not duplicates", "geo never merges alone"), and the comments explain *why*, not just *what*. The `CENTROID_BLACKLIST` / `isCentroid` defense against geocoder-fallback pile-up (`dedup.ts:638`) is a genuinely subtle correctness fix.
- **Registry dispatch for parsers and normalizers** (`ingest.ts:199` `PARSER_REGISTRY` + `resolveParserKey`; `normalize.ts:33` `NORMALIZER_REGISTRY`). "Add a source = add a registry entry" is the correct extensibility contract, and the unregistered-source fall-through to `ignored` (never delete — `normalize.ts:86`) respects the append-only raw layer.
- **Fail-soft batch semantics.** `enrichCards`, `normalizeWorldafisha`, and `dispatch` all wrap per-item work in try/catch so one bad row never aborts a run. `dispatch` uses `Promise.allSettled` with a bounded pool (`dispatcher.ts:102`).
- **`sanitizeText` at the DB boundary** (`util.ts:47`) — stripping lone surrogates / control bytes that the Neon HTTP driver rejects, while computing `dedup_hash` from the *raw* item so identity is unaffected. Exactly the right layering.

---

## 3. Structural findings

### F1 — `worldafisha.ts` is a hidden god-module; there is no neutral normalizer-core. **(High)**

**Location:** `lib/pipeline/normalizers/worldafisha.ts` (exports `parseEventDate`, `dateFromUrl`, `inferYear`, `EventInsert`, `upsertPlainEvent`); imported by ~15 siblings, e.g. `valenciarusa.ts:3`, `palau.ts:3`, `eventbrite.ts:3`, `lacotorra.ts:4`.

**What's wrong:** the genuinely-shared core of the normalizer layer — the canonical date parser, the events `INSERT … ON CONFLICT` persistence, and the `EventInsert` type — physically lives inside one *peer source normalizer*. Every event normalizer transitively depends on `worldafisha.ts`. Two more files act as accidental utility hubs: `valenciarusa.ts` owns `parsePrice`/`parseVenue`/`parseAddress`/`isJunkCard` (imported by ~7–13 siblings) and `vidacultural.ts` owns `postTitle`/`looksLikeEvent`. So the shared layer is scattered across three source modules with no declared boundary.

**Why it bites:** (1) import cycles waiting to happen — touch worldafisha's parsing and you can break 15 modules; (2) you cannot reason about or delete worldafisha without auditing the whole directory; (3) worse, `fever.ts` did *not* reuse the upsert and forked a **second copy** of the events `INSERT … ON CONFLICT` SQL (`fever.ts:~274`), so the persistence contract now has two divergent sources of truth — a schema/column change must be applied in both or the seed silently diverges.

**Concrete fix — extract a neutral core:**
```
lib/pipeline/normalizers/
  shared/
    dates.ts      // parseEventDate, dateFromUrl, inferYear, pad, ES_MONTHS, EN_MONTHS
    persist.ts    // EventInsert (single source), upsertPlainEvent  ← fever uses THIS
    fields.ts     // parsePrice, parseVenue, parseAddress, isJunkCard, postTitle, looksLikeEvent
    raw.ts        // parseRaw<T>(item), RawWeb / RawTelegram shapes
  worldafisha.ts  // now just buildWorldafishaEvents + normalizeWorldafisha
```
Net effect: worldafisha becomes a leaf again, `fever.ts`'s forked SQL is deleted, and there is exactly one place a column change lands.

---

### F2 — The `normalizeX` orchestrator body is copy-pasted ~17× verbatim. **(High)**

**Location:** the tail of every event normalizer, e.g. `worldafisha.ts:345-374`, mirrored byte-for-byte in `valenciarusa`, `palau`, `ticketmaster`, `eventbrite`, `lacotorra`, etc.

**What's wrong:** every normalizer repeats the identical four steps — *select pending rows for this source key → `build*` → loop upsert counting created/updated → loop mark `source_items` normalized*. The pending-row SELECT predicate (`normalized_status IS NULL OR … OR normalized_at < last_seen`) is duplicated ~17×; a fix to that predicate (a real correctness concern) requires 17 synchronized edits. Two spellings of the mark step coexist (helper `markRawItem(...)` vs an inline `exec\`UPDATE source_items …\``) — same SQL, never unified.

**Why it bites:** the largest copy-paste surface in the repo; every new source re-pastes ~30 lines of orchestration that has nothing source-specific in it. Divergence is inevitable (it already happened with the mark step).

**Concrete fix — a higher-order runner:**
```ts
// shared/run-normalizer.ts
export async function runPlainNormalizer(
  sourceKey: string,
  build: (rows: RawItem[]) => Array<{ draft: EventInsert; sourceItemId: number }>,
  { exec = sql }: { exec?: typeof sql } = {},
) {
  const rows = await exec`SELECT * FROM source_items WHERE source_key = ${sourceKey}
    AND (normalized_status IS NULL OR normalized_status='pending'
         OR normalized_at IS NULL OR normalized_at < last_seen)`;
  let created = 0, updated = 0;
  for (const { draft, sourceItemId } of build(rows as RawItem[])) {
    try { (await upsertPlainEvent(draft, sourceItemId, exec)).inserted ? created++ : updated++; }
    catch { /* fail-soft */ }
  }
  for (const r of rows) await markRawItem(r.id, "normalized", null, exec);
  return { created, updated, processed: rows.length };
}
// each normalizer collapses to one line:
export const normalizeWorldafisha = (o = {}) =>
  runPlainNormalizer(WORLDAFISHA_SOURCE_KEY, buildWorldafishaEvents, o);
```
Collapses ~17×30 lines to a single tested helper; the `build*` purity (the part that *is* source-specific) is untouched.

---

### F3 — Events-table column knowledge is re-declared in ≥5 hand-maintained places; the seed round-trip silently drifts. **(High)**

**Locations:** `db/schema.sql:54-99` (44-col DDL) · `scripts/export-seed.mjs:72-81` (explicit 44-col SELECT, comment literally says "all 44 event columns") · `worldafisha.ts:304` + `fever.ts` (`INSERT INTO events (...)` subsets) · `scripts/migrate-hemisferic-series.mjs:107` (25-col SELECT) · `lib/queries.ts:17` (`SiteEvent` interface).

**What's wrong:** there is no single source of truth for "what columns an event has." `seed.mjs` escapes this (it derives columns at runtime via `Object.keys(rows[0])` and `INSERT … ON CONFLICT (id) DO NOTHING`), but `export-seed.mjs` hardcodes the column list. So the bake strategy's *loader* is schema-agnostic while its *exporter* is schema-pinned.

**Why it bites:** the moment someone `ALTER TABLE events ADD COLUMN …`, `export-seed.mjs` keeps SELECTing its frozen 44 columns, the new column never reaches `events.json`, and the *next* local bake silently loses that data — **no error, no test failure.** This is the live-data risk behind the "bake locally → ship seed" strategy: the round-trip is only correct by manual list-maintenance.

**Concrete fix:** make the exporter schema-driven (`SELECT column_name FROM information_schema.columns WHERE table_name=$1`), or have it `SELECT *` and dump `Object.keys` like the loader. Either makes the round-trip column-complete by construction. Longer term, declare each table's column set once (a `TABLE_COLUMNS` map) and import it into seed/export/migration.

---

### F4 — Pervasive N+1 writes over a per-statement HTTP SQL driver; no transactions. **(High)**

**Locations:** `score.ts:85` (one `UPDATE` per event), `tags.ts:80-87` (one `UPDATE` per event *and* per place), `notify.ts:315-319` / `:329` / `:347` (two round-trips — UPDATE + INSERT — per id, in a JS loop), `geo.ts` loops, `dedup.ts` per-loser `UPDATE`, `migrate-hemisferic-series.mjs`.

**What's wrong:** `lib/db.ts` uses `neon()` HTTP mode (`poolQueryViaFetch`), where **each tagged-template call is its own HTTP request** and there is no surrounding transaction. `scoreAll` on 400 events issues 400 sequential HTTPS POSTs; `markEventsNotified` issues `2 × N`. None of the multi-write stages (dedup survivor + losers, notify update + log) is atomic — a mid-loop failure leaves the DB half-updated (e.g. survivor's `metadata_json` written but some losers not yet collapsed), and these stages run inside a Vercel function with a hard wall-clock budget.

**Why it bites:** latency scales linearly with row count against a network round-trip, not a local socket; the refresh route is the thing most likely to time out as the corpus grows; and the lack of atomicity means a partial dedup/notify can leave inconsistent state that the *next* run must be idempotent enough to repair (it mostly is, by design — but that's load-bearing luck, not a guarantee).

**Concrete fix:** batch the set-shaped updates. `scoreAll`/`tagAll` → one `UPDATE … FROM (VALUES …)` per chunk, or `unnest($ids, $scores)`. `markEventsNotified` → a single `UPDATE events SET notified=1 WHERE id = ANY($ids)` + a single multi-row `INSERT INTO notifications SELECT * FROM unnest(...)`. Wrap each multi-write stage in `BEGIN/COMMIT` (Neon supports transactions via `transaction()` / a pooled client). This is the highest latency/robustness payoff for modest effort.

---

### F5 — Series no-repeat is wired but broken in the digest route. **(High, latent)**

**Locations:** `notify.ts` *builds* `payload.series` and *provides* `markSeriesNotified` (`:340`), but `app/api/cron/digest/route.ts:44-46` only calls `markEventsNotified` + `markPlacesNotified` — **never `markSeriesNotified`**, and never reads `payload.series.length` for the response either.

**What's wrong:** the constitution's "notifications de-duplicated for events AND places" (and the T073 series no-repeat) is implemented in the library but not invoked by the only caller. `selectSeriesDigest` filters on `s.notified`, but nothing ever sets `event_series.notified = 1`, so **every weekly digest re-sends every qualifying series card forever** once a real transport is wired.

**Why it bites:** it's invisible today only because the default sender is `dryRunSender` (`delivered:false` → nothing marked). The day a real Telegram/webhook transport is configured, series spam ships. This is a wired-wrong contract, not missing work.

**Concrete fix:** in the route's `if (send.delivered)` block, add `await markSeriesNotified(payload.series.map(s => s.id), { channel: send.transport })` and include `series: payload.series.length` in the JSON. (Note `markSeriesNotified` takes the real `event_series.id`; ensure `payload.series[].id` is that id, not a synthetic render id.)

---

### F6 — `queries.ts` `buildPayload` ships the entire DB to the client and re-implements sorting/merging in three places. **(Medium)**

**Locations:** `lib/queries.ts:339` `buildPayload` (Promise.all of `getEvents`/`getSeriesEvents`/`getPlaces` → full arrays) → `app/page.tsx` (`force-dynamic`) → `Home.tsx` receives the whole `SitePayload` as a client prop.

**What's wrong:** three concerns are entangled. (1) Every page load `SELECT *`s all upcoming events + all series + all occurrences + all places and serializes the lot into the client bundle (no pagination, no projection — `getEvents` is `SELECT *`). (2) The deterministic ordering rule "score DESC, then date, then title" is hand-re-implemented in `buildPayload` (`:350`), `getEvents` SQL (`:187`), and `seriesToSiteEvents` (`:208`) — three copies that can drift. (3) `seriesToSiteEvents` mints **synthetic ids** by numeric offset (`1_000_000_000 + id`, `2_000_000_000 + id`, `:243`/`:256`) as React keys — a fragile encoding that collides if `event_series.id` ever exceeds 1e9 and leaks "id math" into the render layer.

**Why it bites:** payload size grows unbounded with the corpus (this is the page users hit); the triplicated sort is a latent inconsistency; the synthetic-id scheme is an implicit, undocumented contract between `queries.ts` and React reconciliation.

**Concrete fix:** add a server-side projection + limit (the feed doesn't need `metadata_json`/`raw_excerpt` on every card); centralize the comparator as one exported `compareSiteEvents` used by all three; replace synthetic-id math with explicit stable keys like `` `series-${id}` `` / `` `occ-${id}` `` (the React key type is `string`, so the numeric collision risk just disappears).

---

### F7 — `db.ts` constructs a real client at module load with a fake fallback URL; failure mode is a confusing runtime error, not a clear one. **(Medium)**

**Location:** `lib/db.ts:20` — `export const sql = neon(url || "postgresql://user:password@localhost/placeholder")`, with only a `console.warn` if `DATABASE_URL` is missing.

**What's wrong:** the module silently swallows a missing connection string so the build can construct the client, then queries fail later with a driver-level error against `localhost/placeholder` that doesn't name the real cause. The local-proxy shim (`db.ts:7-11`) is *also* duplicated in `scripts/_neon-local.mjs:9-15` because the `.mjs` scripts can't import the `.ts` — so the gating logic ("route to `db.localtest.me:4444`") has two copies that can drift (e.g. the T137 `fetchConnectionCache` removal touched `db.ts` only).

**Why it bites:** misconfiguration surfaces far from its source; the duplicated shim is a quiet drift hazard between app and scripts.

**Concrete fix:** keep the build-time-constructable client, but wrap query execution so the first real query with no `DATABASE_URL` throws a single clear error ("DATABASE_URL unset — refusing to query placeholder DB"). Extract the proxy-gating into one tiny `.mjs` that both `db.ts` (via a thin re-export) and the scripts consume, so there is one definition of "is this the local stack."

---

### F8 — `types.ts` declares a normalizer contract that nothing implements; the real contract is implicit. **(Medium)**

**Location:** `lib/pipeline/normalizers/types.ts:82-93` — `NormalizedStatus`, `NormalizedOut`, `Normalizer = (item) => Promise<NormalizedOut>`, plus `EventDraft`/`PlaceDraft`.

**What's wrong:** the *actual* normalizers return `{ created, updated, processed }` (the `SourceNormalizer` type in `normalize.ts:29`), persist via `upsertPlainEvent`, and use the `EventInsert` type from `worldafisha.ts` — **none** of them implement `Normalizer` or return `NormalizedOut`, and `EventDraft` is a near-twin of `EventInsert` that no live path uses. So the file that *looks* like the canonical interface is aspirational/dead, and the real contract is spread across `normalize.ts` (the registry value type) + `worldafisha.ts` (the insert type) + each module's convention.

**Why it bites:** a new contributor reads `types.ts`, implements `Normalizer`/`NormalizedOut`, and is wrong. Two competing "draft" types (`EventDraft` vs `EventInsert`) is exactly the kind of ambiguity that produces subtly different rows.

**Concrete fix:** delete `NormalizedOut`/`Normalizer`/`EventDraft`/`PlaceDraft` (or make them the *real* contract and migrate to them). Keep `RawItem` + `markRawItem` (those are live). Re-export the single `EventInsert` from the new `shared/persist.ts` so there is one draft type.

---

### F9 — `entity_sources` schema/code contract mismatch. **(Low)**

**Location:** `db/schema.sql:198` defines `role TEXT NOT NULL DEFAULT 'merged'` with comment `-- primary | merged` and `match_method` comment `-- url | external_id | maps_url | fuzzy-title | …`; but `dedup.ts:447`/`:415` write `role` ∈ `{'primary','duplicate'}` and `match_method` ∈ `{'self','strong','fuzzy'}`.

**What's wrong:** three vocabularies (`'merged'` default, `'primary|merged'` comment, `'primary|duplicate'` code) for the same column; the `match_method` comment enumerates values the code never produces. Anyone querying `WHERE role='merged'` gets nothing.

**Why it bites:** silent semantic drift in a provenance table that exists specifically to be queried for "every source that fed this survivor." The default `'merged'` is dead (every insert supplies `role` explicitly).

**Concrete fix:** pick one vocabulary and align the DDL default + comment + code. (`role` ∈ `{primary, duplicate}`, `match_method` ∈ `{self, strong, fuzzy}` matches the code — change the DDL to suit.)

---

### F10 — Small but real duplications that signal the missing seams. **(Low)**

- `pluralSeans(n)` (RU pluralization) is copy-pasted verbatim in `app/Home.tsx:13` and `app/events/[id]/page.tsx:143`. Move to `lib/format.ts`.
- The "score DESC, date, title" comparator (F6) and the ISO-date regex/parse (`/^(\d{4})-(\d{2})-(\d{2})/` in `dedup.ts:108`, `score.ts:26`, `notify.ts:64`, `format.ts:11`, `health.ts`). One `parseIsoDate`/`epochDay` util already exists in `format.ts` — consolidate.
- `parseRaw(item)` (try/JSON.parse of `raw_json`) and the `RawWeb`/`RawTelegram` shapes are re-declared in *every* normalizer (~19 copies, per the sub-survey). One generic `parseRaw<T>` belongs in `shared/raw.ts`.
- `app/api/cron/refresh/route.ts:6` sets `maxDuration = 300` (Vercel Pro/Enterprise ceiling); the dispatch/digest routes cap at 60. Given the N+1 write profile (F4) and that the refresh route runs the *whole* synchronous pipeline, this is the most timeout-exposed surface — worth confirming the plan tier actually allows 300 and/or moving the heavy path to the cadence dispatcher.

---

## 4. Cross-cutting concerns

- **Error handling.** Consistent and sensible at the *stage* level: per-item try/catch + fail-soft, `Promise.allSettled` in the pool, `source_runs` rows recorded for both ok and error paths (`ingest.ts:325`). The gap is *atomicity* (F4): multi-row stages are not transactional, so "fail-soft" at the item level can still leave a stage half-applied at the DB level. Idempotency papers over this on re-run, but that's an implicit dependency, not a stated guarantee.
- **Testing seams.** Excellent. The pure-core + injectable-`exec` split means the decision logic is all testable without a DB, and the test suite (~290 `node --test` files, one per normalizer + per stage) reflects that. The weakness is that tests largely exercise the *pure* `build*`/`select*` functions; the DB orchestration glue (the copy-pasted F2 bodies, the route wiring in F5) is under-covered — which is exactly where the F5 series-notify bug hides.
- **Type safety.** Mixed. The domain types (`EnrichmentResult`, `SiteEvent`, `DedupEvent`) are well-modeled, and `normalizeEnrichment` is a proper runtime gate between untrusted model output and the DB (`enrich.ts:155`). But the DB boundary is pervasively `as any[]` / `as unknown as T[]` (every `sql\`…\`` cast), so the schema↔TS contract is unchecked — a renamed column compiles fine and fails at runtime. `types.ts` actively misleads (F8). No generated types from the schema.
- **DB-access pattern.** Single tagged-template `sql` client, injectable per stage — good. But HTTP-per-statement with no connection reuse for batches and no transactions (F4), plus a duplicated proxy shim (F7).
- **Idempotency.** The strongest cross-cutting property. Content-`dedup_hash` + `ON CONFLICT DO UPDATE` lists that preserve downstream state, `seed.mjs`'s `ON CONFLICT (id) DO NOTHING` + `setval`, the hemisfèric migration's `WHERE score IS NULL` guard — all genuinely idempotent and re-run-safe. The one place it *isn't* self-evident is multi-stage atomicity (F4).
- **Local-vs-prod split.** Clean gating on `db.localtest.me` (never on `NODE_ENV`) is the right call. The cost is the duplicated shim (F7) and a `db:setup` chain (`apply-schema && seed && db:migrate:series`) whose hemisfèric migration *fails open* — if the seed lacks `api:hemisferic` rows it produces 0 series with no error (the Tick L regression noted in CLAUDE.md is exactly this). The seed *loader* is schema-agnostic; the *exporter* is not (F3).
- **Observability.** Good bones: `source_runs` is a real run-log, `/api/health` delegates to pure `sourceStale`/`pipelineWarnings`, `smoke.mjs` exists. Missing: structured logs (stages return result objects but the cron routes just `NextResponse.json` them — no persisted pipeline-run record tying ingest→normalize→…→geo counts together for a given tick), and the `enrichment_json` audit blob is written but nothing surfaces held/ungrounded cards for review.

---

## 5. Recommended refactors, ranked (effort × payoff)

1. **Extract `normalizers/shared/{dates,persist,fields,raw}.ts` and a `runPlainNormalizer` HOF (F1 + F2).** *Effort: M. Payoff: very high.* Kills the largest copy-paste surface, removes the worldafisha god-module, deletes fever's forked INSERT, and makes "add a source" a `build*` function + one registry line. Do this first — it unblocks everything else and the pure `build*` cores stay untouched, so test risk is low.
2. **Make `export-seed.mjs` schema-driven; pick one events-column source of truth (F3).** *Effort: S. Payoff: high.* Directly protects the bake-and-ship data strategy from silent column loss on the next `ALTER`. One-file change with immediate correctness value.
3. **Fix the series no-repeat wiring in the digest route (F5).** *Effort: XS. Payoff: high (latent-bug prevention).* One missing call; ship before any real notification transport is configured.
4. **Batch the N+1 write stages + add transactions to multi-write stages (F4).** *Effort: M. Payoff: high.* `scoreAll`/`tagAll`/`markEventsNotified` → set-based `UPDATE … WHERE id = ANY($ids)` / `unnest`; wrap dedup + notify in `BEGIN/COMMIT`. Biggest latency + robustness win; also de-risks the refresh-route timeout (F10).
5. **Project + paginate `buildPayload`; centralize the comparator; drop synthetic-id math (F6).** *Effort: M. Payoff: medium-high* and rising with corpus size — this is the user-facing page.
6. **Reconcile `types.ts` to the real contract and consolidate `db.ts`/`_neon-local.mjs` shim + the ISO-date/`pluralSeans` dupes (F7, F8, F10).** *Effort: S. Payoff: medium (clarity / drift-prevention).*
7. **Align the `entity_sources` DDL/comment/code vocabulary (F9).** *Effort: XS. Payoff: low but free.*

**Bottom line:** the function-level engineering is strong and the idempotency discipline is genuinely good — keep both. The work to do is *promotion*: lift the three accidental utility hubs into a declared shared layer, give the events-column shape one home, make the batch writes set-based and atomic, and wire the one notification path that's built-but-unconnected. None of it is a rewrite; all of it is paying down the structural debt before the source count doubles.
