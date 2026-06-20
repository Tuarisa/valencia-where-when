# Research & Decisions: Valencia Radar

Phase 0 output. Resolves the open technical choices behind the plan.

## D1 — Scheduler for 12h ingest + weekly Friday digest

- **Decision**: Keep the single Vercel cron (`15 7 * * *`) as the daily ingest
  driver. Add a **GitHub Actions cron** workflow (`.github/workflows/scheduler.yml`)
  that POSTs to the `CRON_SECRET`-protected endpoints for (a) a second daily ingest
  (~`15 19 * * *`) and (b) the weekly digest (`0 7 * * 5`, Europe/Madrid ≈ 09:00
  with DST handled by scheduling in UTC and checking local time in-handler).
- **Rationale**: Vercel Hobby allows only one cron/day; GitHub Actions cron is free,
  already adjacent to the repo, and keeps the app on the Hobby tier. Endpoints stay
  the single source of truth; the scheduler is just a trigger.
- **Alternatives**: Vercel Pro (multiple crons) — costs money, deferred;
  third-party cron (cron-job.org) — extra account, no advantage over GH Actions.

## D2 — Cross-source dedup strategy

- **Decision**: A dedicated `lib/pipeline/dedup.ts` stage that groups candidate
  `events` by a normalized match key (person/title-slug + city + date-window) and
  merges a group into one survivor. Survivor = highest `(source_weight, score)`.
  Conflicting dates resolve to the survivor's; all contributing `source`/`source_url`
  values are accumulated into the survivor's `metadata_json.sources[]`. Losers are
  collapsed (soft-merge), never used to delete `source_items`.
- **Rationale**: Matches the concrete failure in the backlog (Слава Комиссаренко: 3
  records, one wrong Telegram date) and honors Principle I (keep all source links).
- **Alternatives**: Pure `dedup_hash` equality — already insufficient (different
  titles/dates don't collide); LLM-judged merge — overkill, non-deterministic,
  violates batched-resilience for a hot stage.

## D3 — Batched, resilient card enrichment

- **Decision**: `lib/pipeline/enrich.ts` + `app/api/cron/enrich/route.ts`. Selects a
  capped batch (e.g. ≤ N events where `enriched_at IS NULL`, ordered by score), and
  for each calls `claude -p` to: OCR poster image text, translate title+description
  to Russian (`title_ru`, `description_ru`), extract clickable links (`links_json`),
  and split a short headline from the body. Writes per-item; wraps each in try/catch
  so a failure marks the item skipped and moves on. NOT part of synchronous
  `runPipeline()`.
- **Rationale**: Principle IV — prior single long calls timed out (180s/60s). A
  per-item cap + independent invocations keep each call short and the base record
  valid on failure.
- **Alternatives**: One big multi-event prompt — times out; inline during ingest —
  couples a slow best-effort step to the hot path.

## D4 — Multi-source normalizer architecture

- **Decision**: Turn `normalize.ts` into a **registry/dispatch** keyed by
  `source_key`/`item_type`, with one module per source family under
  `lib/pipeline/normalizers/` (telegram-afisha, worldafisha, valenciarusa,
  vidacultural, concerten, palau, cac, visitvalencia, lacotorra, fever, ticketmaster,
  songkick, valenciabonita, hoyvalencia, laganzua). Each takes a `source_item` and
  returns 0..n normalized `events`/`places` + a status (`normalized`/`ignored`/`error`).
  Hemisfèric's existing deterministic path becomes one registry entry.
- **Rationale**: Ports the prototype's 979-line normalizer incrementally, one source
  per Ralph iteration; isolated modules keep each task small and testable.
- **Alternatives**: One monolithic normalizer — hard to test, large diffs, poor fit
  for one-task-per-iteration automation.

## D5 — Testing approach

- **Decision**: `node:test` (`node --test tests/`) for pure logic — scoring, dedup
  match-key + merge resolution, date/title parsing, digest selection filter, tag
  inference. `npm run build` is the type/compile gate. A dry-run harness
  (`npm run pipeline:run`, digest route with `?dry=1`) validates against a DB.
- **Rationale**: Zero new deps, fast, matches "lightweight"; pure functions are where
  bugs hide (scoring/dedup), so unit-test those, not the DB plumbing.
- **Alternatives**: Vitest/Jest — heavier, new toolchain; full E2E — disproportionate
  for a single-household app.

## D6 — Places/restaurants catalog

- **Decision**: Mine places during normalization of the place-rich channels
  (rutatuta_vlc, logunespa, gosvetlanada + Fever gastro) into the existing `places`
  table (`category`, `area`/`district`, `occasion`, `price_level`, `recommended_by`).
  Add `app/places/page.tsx` catalog with facet filters; reuse `places/[id]` detail.
- **Rationale**: Schema already supports it (Principle III — independent output);
  only the mining rules + a list surface are missing.
- **Alternatives**: Separate places DB/service — needless split of one DB.

## Open items

- None blocking. The notification **transport** (Telegram bot vs email vs a single
  chat webhook) is an implementation choice; start with dry-run digest output and a
  pluggable sender — captured as a task, not a blocker.
