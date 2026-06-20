---
spec: pipeline
phase: research
created: 2026-06-20T15:40:00Z
role: umbrella (coordinates 001-valencia-events + dedup + card-enrich + repeateable-events + vercel-workflow + local-run)
---

# Research: pipeline — multi-source, per-source-adaptive, parallel ingest → staged processing

## Executive Summary

This is the **umbrella architecture** for the whole data pipeline. The repo already has a
working but **rigid** pipeline: `runPipeline()` runs `ingest → normalize → score → tag → geo`
**sequentially**, and `ingestAll()` fetches **all 22 sources every run, one-at-a-time, in a
`for` loop**, on a **single daily Vercel cron**. The goal asks for four things the current
design lacks: (1) **per-source adaptive cadence** (poll a 10-min Telegram channel often, a
weekly site rarely, *driven by each source's observed change rate*), (2) **parallel**
ingestion with **per-source failure isolation**, (3) an **extensible "add a source" registry**,
and (4) a **clearly-explained staged raw→processing flow** (ingest → raw `source_items` →
normalize → dedup → enrich → tag → score → geo → entities). All four are achievable with
**additive schema** (cadence columns on `sources` + a `next_due_at` cursor) and a **small code
reorg** (a `dispatcher` that selects only due sources, bounded-parallel ingest via
`Promise.allSettled`, and conditional-GET via ETag/Last-Modified). The one hard external
constraint — **Vercel Hobby = 1 cron/day and the Workflow SDK has no scheduler** — is solved by
an **external tick** (GitHub Actions cron, already decided in 001-D1) that hits a thin
dispatcher route every ~10 min; the dispatcher, not the clock, decides which sources are due.

**Bottom line:** the existing stages are reusable as-is; what changes is **who runs, when, in
what order, and in parallel**. Most of the design is `sources`-table columns + a `dispatcher.ts`
+ swapping the ingest `for`-loop for a bounded `Promise.allSettled` pool.

---

## The architecture, explained clearly (the part you asked for)

### Plain-language walkthrough

Think of the pipeline as a **factory with two halves**: a **collection floor** (many independent
machines, each pulling from one source at its own rhythm) and a **processing line** (a fixed
conveyor that cleans, de-duplicates, enriches, tags, scores, and places everything that the
collection floor drops into a shared **raw bin**).

1. **A heartbeat ticks every ~10 minutes** (an external GitHub Actions cron, because Vercel's
   free plan only allows one real cron *per day*). The tick calls one endpoint: the
   **dispatcher**.

2. **The dispatcher is the brain of cadence.** It does *not* fetch everything. It asks the DB:
   *"which sources are due right now?"* — i.e. `WHERE enabled AND next_due_at <= now()`. A
   Telegram channel that updates every 10 minutes has a small interval, so it comes due almost
   every tick. A sleepy website that changes monthly has a large interval, so it's skipped on
   almost every tick. **Each source carries its own schedule.**

3. **Due sources are fetched in parallel, but politely.** Instead of the current one-at-a-time
   loop, the dispatcher runs a **bounded pool** (e.g. 4–6 at a time) using
   `Promise.allSettled`, so one slow or broken source **cannot fail the run** — each source
   succeeds or fails on its own and is logged to `source_runs`.

4. **Each fetch is a conditional GET.** We send the `ETag`/`Last-Modified` we saved last time. If
   the source replies `304 Not Modified`, we did almost no work, we learned "no change", and we
   **lengthen** that source's interval (back off). If it replies `200` with new content, we
   **shorten** its interval (speed up) and write the raw items.

5. **Raw items land in the append-only `source_items` bin.** Every fetched post/card/page is a
   **raw object** — we never edit or delete it (constitution I). This is the "Все полученные
   данные это сырые объекты" requirement, already satisfied by the existing
   `upsertSourceItem` + `dedup_hash`.

6. **The processing line then runs on the raw bin**, in a fixed order, each stage idempotent
   (re-running touches only what changed):
   - **normalize** — turn a messy raw item into a clean `events`/`places`/`series` draft
     (per-source normalizer from the registry).
   - **dedup** — collapse the same real-world event/place coming from multiple sources into one
     survivor, *keeping a link to every source* (the `entity_sources` table from the dedup spec).
   - **enrich** — the LLM "приводит в порядок, дополняет, гуглит": RU title/body, fills gaps,
     cites sources, flags conflicts — runs **once per survivor**, fail-soft.
   - **tag** — keyword/structured tags (`family`, `music`, `expat`, …).
   - **score** — curation rank (weight + language + category + recency).
   - **geo** — geocode the cleaned venue/address (Nominatim, ≥1.1s pacing).
   - → final **entities**: `events`, `event_series` + `event_occurrences`, `places`, all read by
     the site and the digest.

The key mental model: **collection is per-source and adaptive and parallel; processing is one
shared, ordered, idempotent conveyor.** Adding a new source means registering a row + a parser +
a normalizer — it plugs into both halves without touching the conveyor.

### ASCII architecture diagram

```
                      ┌──────────────────────────────────────────────────────┐
   EVERY ~10 MIN      │  EXTERNAL TICK  (GitHub Actions cron — Hobby = 1/day)  │
   (the heartbeat) ─▶ │  POST /api/cron/dispatch   (Bearer CRON_SECRET)        │
                      └───────────────────────────┬──────────────────────────┘
                                                  │
                                  ┌───────────────▼────────────────┐
                                  │   DISPATCHER  (cadence brain)    │
                                  │  SELECT * FROM sources           │
                                  │   WHERE enabled                  │
                                  │     AND next_due_at <= now()     │   ← per-source schedule
                                  │  ORDER BY next_due_at            │
                                  └───────────────┬────────────────┘
                                                  │ due sources only (0..22)
                       BOUNDED PARALLEL POOL (Promise.allSettled, concurrency≈4–6)
        ┌───────────────┬───────────────┬───────────────┬───────────────┐
        ▼               ▼               ▼               ▼      (failure-isolated)
   ┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐
   │ingestSrc│     │ingestSrc│     │ingestSrc│     │ingestSrc│   each: conditional GET
   │ (tg A)  │     │ (web B) │     │ (api C) │     │ (web D) │   (ETag/If-Modified-Since)
   └────┬────┘     └────┬────┘     └────┬────┘     └────┬────┘
        │ 200 new   304 │ unchanged  200 │           err │ (one bad source
        │ →speed-up      →back-off        │               │  ≠ run failure)
        ▼               ▼               ▼               ▼
   [write raw]    [no write]      [write raw]     [log error]
        │   update sources: last_fetched,last_changed,etag,last_modified,
        │   observed-rate, poll_interval_sec, next_due_at ; log source_runs
        ▼
 ╔═══════════════════════════════════════════════════════════════════════════╗
 ║   RAW BIN  ──  source_items   (APPEND-ONLY, constitution I)                ║  ← "сырые объекты"
 ║   dedup_hash UNIQUE · source_key · external_id · url · raw_text/html/json  ║
 ╚═══════════════════════════════════╤═══════════════════════════════════════╝
                                     │  (a separate stage / workflow, idempotent)
   PROCESSING CONVEYOR  ─────────────▼───────────────────────────────────────────
   normalize ─▶ dedup ─▶ enrich ─▶ tag ─▶ score ─▶ geo ─▶ ENTITIES
   (per-source  (source-  (LLM,    (kw)   (rank)  (Nominatim)  events
    registry)    grounded  once/                              event_series + occurrences
                 +entity_  survivor,                          places
                 sources)  fail-soft)                         (entity_sources links)
                                     │
                                     ▼
                         SITE (static reads)  +  DIGEST / ALERTS (opt-in)
```

> Note the **order correction** vs current code: dedup moves to **right after normalize**, and
> enrich runs **after dedup** (so we enrich survivors only). See Decision E.

---

## Key Findings (grounded in code)

### F1 — Ingestion today: all sources, sequential, fixed 6h floor, single daily cron

`ingestAll()` (`lib/pipeline/ingest.ts:241-254`) loads **every enabled source** and awaits each
in a serial `for` loop:

```ts
export async function ingestAll(): Promise<{ total; ok; error; items; results }> {
  const sources = (await sql`SELECT * FROM sources WHERE enabled = 1 ORDER BY weight, key`) as any[];
  const results: any[] = [];
  for (const source of sources) {
    results.push(await ingestSource(source));   // ← SEQUENTIAL, one at a time
  }
  return { total: results.length, ok: …, error: …, items: …, results };
}
```

`ingestSource(source, minIntervalHours = 6)` has a **single global freshness floor** — *not*
per-source, *not* adaptive (`ingest.ts:206-209`):

```ts
if (source.last_fetched && minIntervalHours > 0 && source.last_fetched >= isoAgo(minIntervalHours)) {
  return { source: source.key, status: "skipped", reason: "fresh_enough" };
}
```

So *every* source is treated identically (skip if fetched <6h ago) and *all* are attempted on
*every* run. The only schedule driver is **one Vercel cron** `15 7 * * *` (`vercel.json`) →
`GET /api/cron/refresh` → `runPipeline()`. **Gap:** no per-source interval, no adaptiveness, no
parallelism, no conditional GET.

### F2 — `sources` table has `last_fetched` only; no cadence/conditional-GET state

`db/schema.sql:5-16`: `sources(id,key,name,type,url,lang,enabled,weight,last_fetched,notes)`.
There is **no** `poll_interval_sec`, `next_due_at`, `last_changed`, `etag`, or `last_modified`.
`ingestSource` writes `last_fetched` but nothing about *whether content changed* or *when to
come back*. The 22 sources (`data/seed/sources.json`) span exactly the cadence spread the goal
describes: `telegram` channels (`tg:vidacultural_Valencia` … 6 of them), `web` pages (12),
`ticketing` (Fever/Ticketmaster/Songkick), and one `api` (`api:hemisferic`). Telegram previews
update many times a day; CAC/Palau official pages change rarely.

### F3 — Raw layer + raw-identity dedup already satisfy "сырые объекты"

`upsertSourceItem` (`ingest.ts:188-204`) writes/updates `source_items` keyed on
`sourceItemHash = sha1short(source_key|external_id|norm(url)|norm(title)|norm(raw_text))`
(`util.ts:33-48`), UNIQUE. Re-seeing the same raw item bumps `last_seen`; it never duplicates.
This is **raw append-only + within/across-run raw dedup, already built** — the umbrella keeps it.
`normalized_status` (`pending`/`normalized`/`ignored`/`error`) is the per-item processing cursor.

### F4 — Normalizer registry exists (the extension seam is already half-built)

`normalize.ts:16-26` is a **`Map<source_key, SourceNormalizer>`** (`NORMALIZER_REGISTRY`) with a
dispatcher (`normalizeAll`) that runs each registered normalizer over its pending rows and marks
unknown-source rows `ignored` (append-only). Today only `api:hemisferic` is registered. **The
"add a source normalizer" contract already exists**; the umbrella extends the *same registry
idea* to the **ingest/parser side** (which is currently a hardcoded `if (source.type === …)`
branch in `ingestSource`, `ingest.ts:214-225`).

### F5 — Parser selection is a hardcoded branch, not a registry

`ingestSource` chooses a parser by `if (source.key === "api:hemisferic") … else if (type ===
"telegram" || url.includes("t.me/s/")) parseTelegram … else parseGeneric` (`ingest.ts:214-225`).
Adding a bespoke parser (e.g. a JSON API source) means editing this branch. The umbrella should
mirror the normalizer registry: a **`PARSER_REGISTRY`** keyed by `type` (or `key`) so "add a
source" is data + a registered function, no edits to the dispatcher core.

### F6 — Processing stages are reusable; only order + wiring change

`run.ts` calls `ingestAll → normalizeAll → scoreAll → tagAll → geoEnrich`. The stages are clean
DB+CPU functions (normalize/score/tag pure; geo needs network + 1.1s Nominatim pacing,
`geo.ts:73,96`). `dedup.ts` exists but is **not wired** (`run.ts` has no `dedup` call; 001 T025
unchecked) and **enrich does not exist yet** (`run.ts` has no enrich; card-enrich spec builds it).
So inserting dedup/enrich and reordering is **low-friction** (matches repeateable-events F13).

### F7 — Vercel scheduling reality (decisive constraint, verified across two specs)

- **Hobby = 1 cron/day** (constitution "Cron cadence reality"; vercel-workflow D-WF2; 001 D1).
- **Vercel Workflow SDK has NO scheduler** — workflows start only via `start()` from code
  (vercel-workflow F "Does NOT solve" + D-WF2). The "Schedules/cron: No limit" line in Workflow
  pricing is a platform-resource note, **not** a relaxation of the project-cron limit.
- **001 D1 already chose the fix:** a **GitHub Actions cron** (free, repo-adjacent) that POSTs to
  `CRON_SECRET`-gated routes for the 2nd daily ingest + Friday digest. The umbrella **reuses this
  exact mechanism** but points it at a new **dispatcher** route and runs it at a **fine tick**
  (e.g. `*/10 * * * *`) so per-source 10-min cadence is achievable.

### F8 — Adaptive-polling + conditional-GET best practice (external, cited)

Verified canonical pattern for "poll based on how often a source actually changes":

| Mechanism | Rule (concrete) | Source |
|-----------|-----------------|--------|
| **Adaptive interval from observed rate** | `interval ≈ avgGap × 0.33` (check ~3× per average post gap); clamp to `[minInterval, maxInterval]`; a brand-new source uses a middle default. Thresholds: `>1 post/h → minInterval (10 min)`, `<0.01 post/h → maxInterval (6 h)`. | [Intelligent RSS fetcher](https://nikolajjsj.medium.com/building-an-intelligent-rss-feed-fetcher-how-i-optimized-my-rss-reader-app-1a21e040d6bf) |
| **Conditional GET** | Save `ETag` + `Last-Modified`; next fetch sends `If-None-Match` / `If-Modified-Since`; `304 Not Modified` = empty body, no reparse, cheap. "Non-negotiable when supported." | [s9y conditional GET](https://docs.s9y.org/docs/developers/conditional-get.html), [Pete Freitag](https://www.petefreitag.com/blog/save-bandwidth-rss-feeds/), [GitHub polling best practices](https://github.com/orgs/community/discussions/156480) |
| **Back-off when unchanged** | On `304`/no-change, **lengthen** interval (exponential, capped); on failure, exponential backoff `base × 2^failures` capped ~24h **with jitter** (avoid thundering herd). | [Merge API polling](https://www.merge.dev/blog/api-polling-best-practices), [TaskJuice](https://taskjuice.ai/blog/api-polling-best-practices) |
| **Speed-up on change** | Reset-on-change: when new content appears, **shorten** interval (toward min) for responsive follow-up. | [Reactive polling (DEV)](https://dev.to/alex-nguyen-duy-anh/reactive-polling-efficient-data-monitoring-3ed) |
| **Publisher hints** | Respect RSS `<ttl>` / `Cache-Control: max-age` / `Retry-After` as a *suggestion*, still bounded by min/max. | [Ctrl.blog feed caching](https://www.ctrl.blog/entry/feed-caching.html) |

**Caveat for our sources:** Telegram `t.me/s/<channel>` web previews and most scraped HTML pages
**may not send strong ETags** and the page HTML changes on every request (ads, tokens). So
"changed?" must also be detected by a **content hash of the parsed items** (we already compute
`sourceItemHash` per item) — i.e. *did this fetch produce any new `source_items`?* That is our
reliable change signal even when HTTP conditional GET is unavailable. Use HTTP conditional GET
when the server honors it (APIs, well-behaved RSS), fall back to **item-hash delta** otherwise.

### F9 — Bounded parallelism + failure isolation (external, cited)

`Promise.allSettled` returns per-task `{status:'fulfilled'|'rejected'}` so **one rejection never
fails the batch** — exactly the per-source isolation needed
([MDN allSettled](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/allSettled)).
For politeness/rate-limit safety, cap concurrency with a small pool (`p-limit`/`p-map` pattern, or
a ~15-line hand-rolled pool to avoid a dep — the house style is dependency-light)
([p-limit](https://medium.com/@sonishubham65/controlled-concurrency-with-retries-in-node-js-using-p-limit-063159ab8478),
[David Walsh promise pool](https://davidwalsh.name/promise-pool)). `ingestSource` **already**
try/catches and logs an error `source_runs` row (`ingest.ts:233-238`), so it is *already
isolation-friendly*; we only need to run them concurrently and `allSettled` the results.

---

## Decisions

### Decision A — Per-source adaptive cadence: additive `sources` columns + observed-change tracking

**Decision.** Add cadence + conditional-GET state to `sources` (additive, `IF NOT EXISTS`):

```sql
ALTER TABLE sources ADD COLUMN IF NOT EXISTS poll_interval_sec  INTEGER;      -- current effective interval
ALTER TABLE sources ADD COLUMN IF NOT EXISTS min_interval_sec   INTEGER;      -- floor (per type default)
ALTER TABLE sources ADD COLUMN IF NOT EXISTS max_interval_sec   INTEGER;      -- ceiling
ALTER TABLE sources ADD COLUMN IF NOT EXISTS next_due_at        TEXT;         -- dispatcher cursor (ISO)
ALTER TABLE sources ADD COLUMN IF NOT EXISTS last_changed_at    TEXT;         -- last fetch that produced new items
ALTER TABLE sources ADD COLUMN IF NOT EXISTS etag               TEXT;         -- conditional GET
ALTER TABLE sources ADD COLUMN IF NOT EXISTS last_modified      TEXT;         -- conditional GET
ALTER TABLE sources ADD COLUMN IF NOT EXISTS consecutive_unchanged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS observed_gap_sec   INTEGER;      -- EWMA of inter-change gaps
ALTER TABLE sources ADD COLUMN IF NOT EXISTS fail_count         INTEGER NOT NULL DEFAULT 0;
```
(`last_fetched` already exists.) Per-type **defaults** (set at seed time): telegram
`min=600s (10m), max=3h`; web `min=1h, max=24h`; ticketing `min=2h, max=24h`; api `min=2h,
max=24h`. Each source may override.

**Effective-frequency computation** (per `ingestSource` result), following F8:
- Maintain `observed_gap_sec` as an **EWMA** of the time between *content changes* (a fetch that
  produced ≥1 new `source_items`): `gap_new = now - last_changed_at`;
  `observed_gap_sec = α·gap_new + (1-α)·observed_gap_sec` (α≈0.3).
- Target `poll_interval_sec = clamp(round(observed_gap_sec × 0.33), min, max)`.
- **On change (new items):** also reset toward min (`consecutive_unchanged=0`), set
  `last_changed_at=now`.
- **On no change (`304` or zero new items):** `consecutive_unchanged++`; **back off**
  `poll_interval_sec = clamp(poll_interval_sec × 1.5, min, max)` (capped, exponential-ish).
- **On error:** `fail_count++`; backoff `min(base × 2^fail_count, max)` + jitter.
- Always set `next_due_at = now + poll_interval_sec` (+small jitter to de-sync sources).

**Change detection** (F8 caveat): prefer HTTP `304`; otherwise "changed" = the fetch produced any
**new** `source_items` (we already know this — `upsertSourceItem` can return inserted-vs-updated).

**Rationale.** Directly realizes "частота … базируясь на том как часто где-либо появляются
обновления": a 10-min Telegram channel's `observed_gap_sec` shrinks → interval hits the 10-min
floor; a monthly site's grows → interval hits the ceiling. Matches the cited canon
(avgGap×0.33, conditional GET, back-off/speed-up). Additive columns honor constitution VI.

**Alternatives.** *(a) Fixed per-source interval column only* (no adaptiveness) — simpler, but
fails "adaptive to observed rate"; keep as the *fallback* when `observed_gap_sec` is null.
*(b) WebSub/PubSubHubbub push* — eliminates polling for feeds that support it
([WebSub](https://en.wikipedia.org/wiki/WebSub)), but our sources are Telegram previews + scraped
HTML that mostly **don't** offer hubs; not viable now, note as future. *(c) Per-source cron
entries* — impossible on Hobby (1 cron/day) and doesn't scale to 22+.

### Decision B — Scheduling: external fine-grained tick + DB-driven dispatcher (achievable cadence is explicit)

**Decision.** A new **dispatcher** route `app/api/cron/dispatch/route.ts` (CRON_SECRET-gated) is
driven by a **GitHub Actions cron at `*/10 * * * *`** (reuses 001-D1's scheduler). The dispatcher:
1. `SELECT * FROM sources WHERE enabled = 1 AND (next_due_at IS NULL OR next_due_at <= now()) ORDER BY next_due_at`
2. Runs those (and only those) through the **bounded-parallel ingest pool** (Decision C).
3. Updates each source's cadence state (Decision A).
4. Optionally enqueues the **processing conveyor** (normalize→…→geo) — see Decision E (run it on
   the same tick after ingest, or on a coarser cadence).

The Vercel daily cron (`15 7 * * *`) stays as a **safety-net full run**.

**Achievable cadence — be explicit:**

| Plan | Tick mechanism | Finest real cadence | Notes |
|------|----------------|---------------------|-------|
| **Hobby (current)** | GitHub Actions `*/10` → dispatch route | **~10 min** for the fastest sources | GH Actions cron is best-effort (can drift several min under load); fine for "every ~10 min". Vercel's own cron stays 1/day as a fallback. |
| **Hobby, conservative** | GitHub Actions `*/15` or `*/30` | 15–30 min | Lower GH-minute usage; still far better than 1/day. |
| **Pro** | Vercel native crons (multiple) | Down to per-minute Vercel cron; could retire GH Actions | Costs money; deferred (matches 001-D1, vercel-workflow Q6). |

**Rationale.** The clock is dumb (fixed tick); the **dispatcher is smart** (per-source due-check).
This decouples "how often we *look*" from "how often each source is *polled*", which is the only
way to get 10-min Telegram + monthly-site cadences from a single coarse external trigger under the
Hobby 1-cron limit. Verified: Workflow SDK can't schedule (F7); GH Actions is the standing
decision (001-D1, vercel-workflow D-WF2).

**Alternatives.** *Vercel Pro multi-cron* (clean, paid — defer). *Inngest/Trigger.dev/QStash*
(have built-in schedulers, would subsume GH Actions, but add a vendor — vercel-workflow weighed
and deferred them). *cron-job.org* (extra account, no edge over GH Actions — 001-D1 rejected).

### Decision C — Parallel + isolated ingestion: bounded `Promise.allSettled` pool, per-source `source_runs`

**Decision.** Replace the serial `for` loop in `ingestAll` with a **bounded concurrency pool**
(concurrency `≈4–6`, env-tunable) over the due sources, using **`Promise.allSettled`** so a
rejection in one source never aborts the batch. Keep `ingestSource`'s existing try/catch +
error-`source_runs` logging (`ingest.ts:233-238`) as the per-source isolation boundary. Add
**per-source politeness**: respect each source's `min_interval_sec` (already enforced by
`next_due_at`), keep the `USER_AGENT`, add `Retry-After`/`429` handling → backoff.

```ts
// sketch (no new dep): bounded pool + allSettled
async function ingestDue(sources, { concurrency = 5 } = {}) {
  const queue = [...sources];
  const runOne = async () => {
    const out = [];
    while (queue.length) out.push(await ingestSource(queue.shift()!));  // ingestSource self-isolates
    return out;
  };
  const workers = Array.from({ length: Math.min(concurrency, sources.length) }, runOne);
  const settled = await Promise.allSettled(workers);   // worker rejection ≠ batch failure
  return settled.flatMap(s => s.status === 'fulfilled' ? s.value : []);
}
```

**Rationale.** Satisfies "Запуск должен быть параллельный" with **politeness** (bounded, not a
22-wide fan-out that could trip rate limits / Nominatim-style etiquette) and **isolation** (one
bad scraper — 308 redirect, HTML change — can't fail the run; constitution "scrapers MUST tolerate
… without crashing the whole run"). `allSettled` is the verified isolation primitive (F9).

**Alternatives.** *Unbounded `Promise.all`* — rejected (a single throw rejects everything;
no rate-limit safety). *Vercel Workflow fan-out* (`Promise.all` of per-source `'use step'`s) —
**compatible and recommended** once Workflow lands (vercel-workflow D-WF1): each source becomes a
durable, independently-retried step. Until then, the in-process bounded pool is the minimal change.

### Decision D — Extensible source registry: parser registry + normalizer registry + a 5-step "add a source" contract

**Decision.** Introduce a **`PARSER_REGISTRY`** (mirroring the existing `NORMALIZER_REGISTRY`):
`Map<type-or-key, (source, body|json) => RawItem[]>`. `ingestSource` resolves the parser from the
registry instead of the hardcoded `if/else` (F5). A source is then fully described by **data**
(its `sources` row + cadence config) + **two registered functions** (a parser, a normalizer).

**The "add a source" contract (end-to-end, N steps):**
1. **Add a row** to `data/seed/sources.json` (and DB): `key`, `name`, `type`
   (`telegram|web|ticketing|api`), `url`, `lang`, `weight`, `enabled`, and optional cadence
   overrides (`min_interval_sec`, `max_interval_sec`). Type-default cadence applies if omitted.
2. **Pick/register a parser**: reuse `parseTelegram`/`parseGeneric`/`parseHemisferic`, or add a
   new fn and register it in `PARSER_REGISTRY` keyed by `type` (or `key` for bespoke APIs).
3. **Register a normalizer** in `NORMALIZER_REGISTRY` (`normalize.ts:16`) keyed by `source_key`
   → returns clean `events`/`places`/`series` drafts. (Unregistered sources are safely `ignored`.)
4. **(Recurring only)** if the source emits series/sessions, return `{series, occurrences[]}` via
   the `upsertSeries` helper (repeateable-events D2) instead of flat events.
5. **Add a golden test** fixture (`tests/…`) for the parser+normalizer, run `npm run build` +
   `node --test tests/`. No edits to the dispatcher, pool, or conveyor core.

**Rationale.** Realizes "с возможностью расширения" with a closed, testable seam; reuses the
registry pattern the codebase already chose (F4, 001-D4). Each new source is one Ralph iteration
(constitution "one task per iteration").

**Alternatives.** *Keep the hardcoded parser branch* — rejected (edits to hot dispatcher per
source, poor isolation/testability). *Config-only generic scraper* (CSS selectors in DB) — nice
long-term, but our sources need bespoke logic (Hemisfèric API, Telegram block regex); defer.

### Decision E — Stage ordering & idempotency: ingest → normalize → dedup → enrich → tag → score → geo → entities

**Decision.** Adopt the **constitution V order** end-to-end and wire the missing stages:
`ingest → normalize → dedup → score → tag → geo → enrich` is the constitution's literal list, but
the sibling specs refine it to **enrich-after-dedup** (enrich survivors only, cost lever) and
**dedup-after-normalize**. Reconciled umbrella order:

```
ingest → normalize → dedup → enrich → tag → score → geo
```
- **dedup right after normalize** (dedup D5; fixes 001 T025 which wrongly said "between tag and
  geo"). Operates on `events`/`places` and (repeateable-events) **series/single-events, NOT
  occurrences**. Writes `entity_sources` link rows (every contributing `source_item_id`).
- **enrich after dedup** (card-enrich C/D5; repeateable-events D3): enrich the **survivor/series
  once**, fail-soft, idempotent (`enriched_at IS NULL`). 342→~252 events, 104→11 Hemisfèric.
- **tag/score** on the survivor/series.
- **geo last** (card-enrich C): enrich proposes clean `venue_name`/`address`/`maps_url`; the
  existing `geo.ts` geocodes them (more rows resolve). Keep the ≥1.1s Nominatim pacing.
- *(Note: constitution lists score before tag; current code runs score then tag; order between
  those two is immaterial — both pure, no interdependency. Flag for requirements to ratify the
  canonical sequence vs constitution wording.)*

**Idempotency / "don't reprocess unchanged" (the explicit goal):**
- normalize: only rows where `normalized_status='pending' OR normalized_at < last_seen`
  (`normalize.ts:53-58` already does this).
- dedup: skip already-merged losers; `entity_sources` UNIQUE on
  `(entity_type, entity_id, source_item_id)`; stable survivor id (dedup D5).
- enrich: `enriched_at IS NULL` (or `last_seen > enriched_at`) (card-enrich).
- series: unchanged schedule re-run = **0 INSERTs, 0 `enriched_at` resets**, only `last_seen`
  bumps (repeateable-events D3) — this *is* "don't re-process every time".

**Rationale.** Single coherent order resolves the three specs' refinements; each stage idempotent
so the fine-grained dispatcher can run the conveyor often without churn or cost. Matches
constitution V + I.

**Alternatives.** *Keep current `ingest→normalize→score→tag→geo` (no dedup/enrich)* — rejected,
omits the goal's "дедуплицирует и энричит". *Run conveyor only on the daily cron, dispatcher only
ingests* — viable simpler variant (Decision F sub-option); decide cadence of conveyor vs ingest in
requirements.

### Decision F — Minimal DB/code reorg (changes allowed: "так тому и быть")

**Schema (all additive, `db/schema.sql` + `IF NOT EXISTS`):**
- `sources`: the cadence/conditional-GET columns (Decision A).
- `source_runs`: add `changed INTEGER` (did this run produce new items?) + `http_status` already
  exists; optionally `bytes`/`not_modified` for observability.
- `entity_sources` link table (from dedup spec — the "из исходников" core).
- `event_series` + `event_occurrences` (from repeateable-events — what "an item" is for recurring
  sources).
- (enrich columns already exist on `events`/`places`.)

**Code reorg:**
- **NEW `lib/pipeline/dispatcher.ts`** — `selectDueSources()` + `dispatch({concurrency})`:
  due-select → bounded `allSettled` ingest pool → cadence update. Replaces the "all sources every
  run" behavior of `ingestAll` (keep `ingestAll` as a "force all" path for the daily safety-net /
  local runs).
- **NEW `app/api/cron/dispatch/route.ts`** — CRON_SECRET-gated; calls `dispatch()` (and optionally
  the conveyor). Driven by GH Actions `*/10`.
- **EDIT `lib/pipeline/ingest.ts`** — add `PARSER_REGISTRY`; `ingestSource` resolves parser from
  it; send `If-None-Match`/`If-Modified-Since` from `sources.etag`/`last_modified`; handle `304`;
  return inserted-count so the dispatcher can compute "changed"; per-source backoff on `429`/error.
- **EDIT `lib/pipeline/run.ts`** — insert `dedup` after `normalize`, `enrich` after `dedup`;
  becomes the conveyor (keep for local/script + daily safety-net). Under Workflow it becomes
  `refreshWorkflow` steps (vercel-workflow D-WF1).
- **EDIT `lib/pipeline/util.ts`** — `fetchText`/`fetchJson` to accept/return conditional-GET
  headers (`ETag`, `Last-Modified`, `304`).
- **SEED** — set per-type cadence defaults in `scripts/seed.mjs` / `sources.json`.

**What changes in `run.ts` specifically:** today it is *sequential, fixed order, all-sources-every-
run*. After: ingestion is **dispatcher-driven (due sources, parallel)**; the conveyor gains
**dedup + enrich** and the **dedup-after-normalize / enrich-after-dedup** order; stages stay
idempotent so it's safe to run on the fine tick.

**Rationale.** Smallest additive change that realizes all four goal pillars; every piece is
reversible + build-green (constitution VI). Reuses every existing stage body.

---

## Proposed schema (consolidated additive migration)

```sql
-- 1) Per-source adaptive cadence + conditional GET (Decision A)
ALTER TABLE sources ADD COLUMN IF NOT EXISTS poll_interval_sec     INTEGER;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS min_interval_sec      INTEGER;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS max_interval_sec      INTEGER;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS next_due_at           TEXT;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS last_changed_at       TEXT;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS observed_gap_sec      INTEGER;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS consecutive_unchanged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS fail_count            INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS etag                  TEXT;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS last_modified         TEXT;
CREATE INDEX IF NOT EXISTS idx_sources_due ON sources(enabled, next_due_at);

-- 2) Run observability (Decision F)
ALTER TABLE source_runs ADD COLUMN IF NOT EXISTS changed       INTEGER;   -- 1 if new items produced
ALTER TABLE source_runs ADD COLUMN IF NOT EXISTS not_modified  INTEGER;   -- 1 if HTTP 304

-- 3) entity_sources (owned by dedup spec — referenced here for the umbrella view)
-- 4) event_series / event_occurrences (owned by repeateable-events — referenced here)
```
(Tables 3–4 are defined in their owning specs; the umbrella only states they are part of the same
coherent flow and must be applied together for the conveyor to be complete.)

---

## Cross-spec reconciliation (umbrella vs each sibling)

| Sibling spec | Umbrella relation | What this umbrella settles / what 001 it updates |
|---|---|---|
| **001-valencia-events** | Umbrella **supersedes the ingestion/scheduling model**. | Replaces "all sources every run, 6h floor, sequential" with **dispatcher + per-source adaptive cadence + parallel pool**. **Updates 001 D1** (still GH Actions, but now a `*/10` tick → `/api/cron/dispatch`, not just a 2nd daily ingest). **Fixes 001 T025** (dedup placement → *after normalize*, not "between tag and geo"). Confirms 001-D4 normalizer registry; **adds a parallel parser registry**. |
| **dedup** | **Detail of the `dedup` stage.** | Umbrella adopts dedup D5 ordering (**dedup right after normalize**) and the **`entity_sources`** link table as the conveyor's dedup step. Umbrella owns *where* dedup sits + idempotency; dedup owns *how* it matches. `mayNeedUpdate: false` (aligned). |
| **card-enrich** | **Detail of the `enrich` stage.** | Umbrella places enrich **after dedup** (enrich survivors once) and **before geo** (enrich feeds clean venue/address to geo). Enrich is fail-soft/idempotent per its spec. `mayNeedUpdate: false`. |
| **repeateable-events** | **Defines what "an item" is** for recurring sources. | Umbrella's normalize step emits **series + occurrences** for recurring sources (via `upsertSeries`); dedup/enrich/score/tag operate on **series, not occurrences**; the dispatcher cadence applies per *source*, unaffected. `mayNeedUpdate: false`. |
| **vercel-workflow** | **Execution substrate** for the conveyor + (future) ingest fan-out. | Umbrella's dispatcher route can `start(refreshWorkflow)`; ingest pool maps to per-source `'use step'` fan-out; conveyor stages become steps. Workflow **does not** provide the scheduler — umbrella's GH-Actions tick stands. `mayNeedUpdate: maybe` (add a `dispatchWorkflow` / per-source ingest step when Workflow lands). |
| **local-run** | **How to run the whole thing locally.** | Dispatcher + conveyor run under `next dev` / the `tsx` script; due-select works offline against seeded `next_due_at`; ingest/geo still need network. Add `tsx` (already flagged). `mayNeedUpdate: low` (document the new dispatch route + cadence seed). |

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Telegram/HTML sources don't honor ETag/Last-Modified → conditional GET ineffective | **Med** | Fall back to **item-hash delta** (did the fetch produce new `source_items`?) as the change signal — we already compute `sourceItemHash`. Use HTTP conditional GET where honored (APIs/RSS). |
| GH Actions `*/10` cron drift / missed ticks (best-effort) | Med | Acceptable for "~10 min"; dispatcher is idempotent (due-select catches up on the next tick); Vercel daily cron is a safety-net full run. Pro/Vercel cron if tighter SLA needed. |
| Parallel fan-out trips source rate limits / etiquette (esp. multi-page sources) | Med | Bounded pool (concurrency 4–6), `next_due_at` jitter to de-sync, `429`/`Retry-After` backoff, keep `USER_AGENT`. |
| Adaptive interval oscillation (speed-up/back-off thrash) | Low | EWMA smoothing (α≈0.3), multiplicative back-off ×1.5 (not abrupt), min/max clamps, `consecutive_unchanged` gate before big back-off. |
| Cold-start: no `observed_gap_sec` for new sources | Low | Per-type default interval until first change observed; then EWMA takes over. |
| Conveyor running on the fine tick causes cost/churn (enrich $$, Nominatim) | Med | Idempotency markers (`enriched_at`, `normalized_at`, `next_due_at`); optionally run **ingest on the fine tick, conveyor on a coarser cadence** (Decision E alt). Dedup-before-enrich already cuts enrich targets. |
| Dispatcher route exceeds 300s if many sources due at once | Low–Med | Bounded pool + `next_due_at` jitter spreads load; under Workflow the 300s cap disappears (vercel-workflow). Cap due-batch size per tick. |
| Schema/order drift between this umbrella and sibling specs | Med | This reconciliation table is the source of truth; apply `entity_sources` + series tables together; ratify final stage order in requirements. |

---

## Feasibility / Risk / Effort

| Aspect | Assessment | Notes |
|---|---|---|
| **Technical Viability** | **High** | All stage bodies reusable; ingestion already self-isolates + logs `source_runs`; normalizer registry exists; schema changes are additive; cited adaptive-polling pattern is standard. |
| **Effort** | **M (–L)** | M for cadence columns + dispatcher + parallel pool + conditional GET + wiring dedup/enrich + reorder. Trends to **L** because it touches `ingest.ts`, `util.ts`, `run.ts`, schema, seed, a new route, and must land coherently with the dedup + series + (future) workflow specs. Decomposes into small, build-green, one-per-iteration tasks. |
| **Risk** | **Medium** | Driven by conditional-GET reliability on scraped sources (mitigated by item-hash delta) and cadence-tuning oscillation (mitigated by EWMA + clamps). No off-stack deps required (pure-TS pool + fetch headers). |

---

## Open Questions (for requirements)

1. **Tick cadence on Hobby:** GH Actions `*/10` (best ~10-min Telegram cadence, more GH minutes)
   vs `*/15`–`*/30` (cheaper, coarser)? Or move to **Pro** Vercel multi-cron and retire GH
   Actions (cost)? (Ties to vercel-workflow Q6, 001-D1.)
2. **Conveyor cadence:** run normalize→…→geo on **every dispatch tick** (freshest, more cost) or
   on a **coarser separate schedule** (cheaper, slight latency)? Enrich/geo are the cost levers.
3. **Conditional GET trust:** which sources actually honor ETag/Last-Modified (test the 22)?
   Default everyone to **item-hash delta** and use HTTP conditional GET as an optimization where
   it works?
4. **Concurrency + politeness knobs:** pool size (4? 6?), per-source min-interval floors per type,
   `429`/`Retry-After` policy, and whether multi-page sources (CAC ×4, Hemisfèric 14-day loop)
   need their own sub-throttle.
5. **Adaptive constants:** ratify `interval = observed_gap × 0.33`, back-off ×1.5, EWMA α=0.3, and
   the per-type `[min,max]` bounds (telegram 10m–3h; web 1h–24h; ticketing/api 2h–24h)?
6. **Canonical stage order:** ratify `ingest→normalize→dedup→enrich→tag→score→geo` (this umbrella)
   vs the constitution's literal `…→dedup→score→tag→geo→enrich`. The umbrella's enrich-before-geo
   is deliberate (enrich feeds geo) — should the constitution wording be amended (PATCH)?
7. **Dispatcher vs Workflow now:** build the in-process bounded pool first (minimal), or jump
   straight to Vercel Workflow per-source `'use step'` fan-out (vercel-workflow)? Recommend
   in-process pool first; Workflow when that spec lands.
8. **Force-all path:** keep `ingestAll()` (all sources, ignore `next_due_at`) for the daily
   safety-net + local runs, alongside the dispatcher's due-only path? (Recommend yes.)

---

## Sources

**Code (this repo):** `lib/pipeline/ingest.ts` (`ingestAll` serial loop l.241-254, `ingestSource`
6h floor l.206-209, hardcoded parser branch l.214-225, error isolation l.233-238, `upsertSourceItem`
l.188-204), `lib/pipeline/run.ts` (sequential fixed order), `lib/pipeline/util.ts` (`fetchText`/
`fetchJson` l.97-119, `sourceItemHash` l.33-48), `lib/pipeline/normalize.ts` (`NORMALIZER_REGISTRY`
l.16-26, idempotent pending-select l.53-58), `lib/pipeline/score.ts`/`tags.ts`/`geo.ts` (pure +
Nominatim pacing l.73,96), `db/schema.sql` (`sources` l.5-16 — only `last_fetched`; `source_runs`;
`source_items`), `data/seed/sources.json` (22 sources, types), `vercel.json` (single daily cron),
`app/api/cron/refresh/route.ts`, `scripts/run-pipeline.mjs` (needs `tsx`), `.specify/memory/
constitution.md` (I, V order, VI; "Cron cadence reality").

**Sibling specs:** `specs/001-valencia-events/{research.md (D1 GH-Actions scheduler, D4 normalizer
registry), tasks.md (T024-T027 dedup placement)}`, `specs/dedup/research.md` (D5 dedup-after-
normalize, `entity_sources`), `specs/card-enrich/research.md` (C enrich feeds geo, enrich-after-
dedup), `specs/repeateable-events/research.md` (D1/D2/D3 series+occurrences, `upsertSeries`),
`specs/vercel-workflow/research.md` (D-WF1 step fan-out, D-WF2 NO scheduler / Hobby 1-cron),
`specs/local-run/research.md` (offline stages, `tsx`).

**External (adaptive polling / conditional GET / concurrency):**
- [Building an Intelligent RSS Feed Fetcher — avgGap×0.33, 10min–6h bounds, ETag/Last-Modified, backoff+jitter](https://nikolajjsj.medium.com/building-an-intelligent-rss-feed-fetcher-how-i-optimized-my-rss-reader-app-1a21e040d6bf)
- [Conditional GET for RSS Feeds — s9y](https://docs.s9y.org/docs/developers/conditional-get.html)
- [Best practices for syndication feed caching — Ctrl.blog (per-feed freshness, ttl/max-age hints)](https://www.ctrl.blog/entry/feed-caching.html)
- [Save Bandwidth on your RSS Feed (304/ETag/Last-Modified) — Pete Freitag](https://www.petefreitag.com/blog/save-bandwidth-rss-feeds/)
- [GitHub polling best practices — conditional requests / 304 don't cost rate budget](https://github.com/orgs/community/discussions/156480)
- [7 best practices for polling API endpoints — Merge (exponential backoff)](https://www.merge.dev/blog/api-polling-best-practices)
- [API Polling Best Practices — TaskJuice (backoff + jitter)](https://taskjuice.ai/blog/api-polling-best-practices)
- [Reactive Polling: Efficient Data Monitoring — DEV (reset-on-change speed-up)](https://dev.to/alex-nguyen-duy-anh/reactive-polling-efficient-data-monitoring-3ed)
- [Promise.allSettled() — MDN (per-task failure isolation)](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/allSettled)
- [Controlled Concurrency with p-limit — Medium (bounded pool + retries + jitter)](https://medium.com/@sonishubham65/controlled-concurrency-with-retries-in-node-js-using-p-limit-063159ab8478)
- [Limit Promise Concurrency with a pool — David Walsh](https://davidwalsh.name/promise-pool)
- [WebSub (PubSubHubbub) — push alternative to polling (future, not viable for TG/HTML now)](https://en.wikipedia.org/wiki/WebSub)
