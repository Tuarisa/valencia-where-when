<!-- SPECKIT START -->
# Valencia Radar — agent context

**Active feature**: `001-valencia-radar`
**Spec**: `specs/001-valencia-radar/spec.md`
**Plan**: `specs/001-valencia-radar/plan.md`
**Tasks**: `specs/001-valencia-radar/tasks.md`
**Research (all decisions)**: `specs/001-valencia-radar/research.md`
**Data model**: `specs/001-valencia-radar/data-model.md`
**Constitution**: `.specify/memory/constitution.md` (v1.1.0)

> Consolidated 2026-06-20: the original `001-valencia-events` feature and seven
> research-only ralph specs (pipeline, dedup, card-enrich, repeateable-events,
> llm-testing, local-run, vercel-workflow) were merged into this single feature
> (sub-areas A–I). The originals are preserved under `specs/_archive/`. The project
> now uses **speckit only**; the active feature is resolved via `.specify/feature.json`.

**Stack**: Next.js 14 (App Router) + React 18, Neon serverless Postgres
(`@neondatabase/serverless`), Vercel cron + **Vercel Workflow SDK** (`workflow`),
**Anthropic SDK** (`@anthropic-ai/sdk`, enrichment; `claude -p` fallback), TypeScript
pipeline in `lib/pipeline/`.

**Pipeline (canonical order, v1.1.0)**: ingest → normalize → **dedup** → score → tag
→ **enrich** → geo. Existing in `run.ts`: ingest/normalize(registry)/score/tag/geo +
a first dedup pass. TO BUILD: two-layer **dedup** for events+places (`entity_sources`,
geo guard, convention fix + 90-row seed migration), **recurring** model
(`event_series`+`event_occurrences`, Hemisfèric 104→11), SDK **enrich** (grounded,
confidence), **notify** (weekly digest + rare alert, events+places), adaptive
multi-source **ingestion** + dispatcher, **Vercel Workflow** substrate,
**places catalog** surface, **local-dev** (Docker+Neon proxy) + **LLM eval** tooling.

**Key commands**: `npm run build` (compile gate — must be green before commit),
`npm run dev`, `npm run db:setup`, `npm run pipeline:run`, `npm test` (`node --test`);
local dev (sub-area H, wired): `npm run db:local:up` → `npm run db:local:setup` →
`npm run dev:local` → `npm run db:local:down` (Docker Postgres + Neon HTTP proxy;
shim gated on `db.localtest.me`, see `LOCAL_RUN.md`); eval (key-gated): `npm run eval`.
**RULE (user, REQUIRED): the local DB MUST PERSIST across ticks — do NOT run `db:local:down`
/ teardown between iterations. It accumulates real ingested + normalized (+ later enriched) data
that gets BAKED into the seed (T144 local-first baking); only overwrite deliberately when
re-testing. We don't throw data away. ("база данных локальная должна жить, не убиваться между
циклами".) Background Workflows/agents that bring the stack up must LEAVE it up.**

**Loop execution — ULTRACODE BY DEFAULT (user, REQUIRED).** This project runs autonomously
via `/loop /speckit-implement` ticks. On each tick the main loop must DELEGATE the substantive
task work to subagents instead of doing reads/edits/builds inline — otherwise it all piles into
the persistent loop context, which is wasteful and bloats fast. The main loop's job per tick:
(1) pick the next unblocked task, (2) delegate execution to a subagent (Agent tool) — or a
**Workflow** for multi-part / parallelizable / file-disjoint work — (3) integrate the returned
result, run the compile/test gate, and **commit + push**. Keep the loop context lean: subagents
do the heavy lifting and return conclusions, not file dumps. Background long/slow or independent
work and let it notify on completion. (Established by the user: "отправляй всё в сабагентов,
контекст слишком длинный, используй ultracode". Trivial mechanical edits may stay inline.)

**Progress**: Phase 0 done (T001 harness 8/8, T002 GH-Actions scheduler skeleton,
T003 `.env.example`). **T004 additive schema applied** to the live local DB
(`entity_sources`, `event_series`/`event_occurrences`, sources cadence cols,
`source_runs` changed/not_modified, places enrich cols, `notifications.series_id/place_id`).
Sub-area H local stack wired + running (T080–T083; `db:local:up` → seeded
385 events / 23 sources / 14 places / 216 media). One-off **Feria de Julio 2026**
source seeded (`web:feriadejuliovlc`, +43 events). **T032 dedup convention fixed**
(losers → `status='duplicate'`+`merged_into`, verified on local DB). Commit + push
per task (branch `main`; `origin` = HTTPS — SSH agent isn't available to the
non-interactive shell; workflow-file commits need `gh auth refresh -s workflow` or a
manual SSH push). **dedup over-merge FIXED** (T035 partial: Cyrillic→Latin translit in
`titleSignature` + `isMergeableGroup` requiring ≥2 distinct sources + untitled-guard;
live 11→0 false merges, idempotent). Also fixed `register("tsx/esm")` → `node --import
tsx` in `run-pipeline.mjs` (was broken on Node 24). **Dedup matching complete**:
events (translit + cross-source + untitled guard) + places (T036 partial:
`arePlacesDuplicate` strong+fuzzy) + geo guard (T037: `geoCorroborates`/`isCentroid`/
`haversineMeters`/`jaroWinkler`, 15/15 tests). Events dedup over-merge is fixed +
idempotent, so wiring it into `run.ts` (T038) is now SAFE. Still deferred: place dedup
DB orchestrator → T064 (place mining; needs places.status + render filter);
`entity_sources` writes (T033/T034) → need `source_items` (seed has none). **Events dedup wired into `run.ts`** (T038, offline path): order now
`ingest → normalize → dedup → score → tag → geo` (enrich slots in at T050;
`refreshWorkflow` exposure is T022). **Series helper done** (T040): `lib/pipeline/
series.ts` `upsertSeries` + `seriesHash`/`occurrenceHash`, idempotent (live-verified:
re-run = 0 new rows, preserves enriched_at/score/notified). **Hemisfèric normalizer
emits series** (T041): `buildHemisfericSeries` + `upsertSeries`, live-verified
(3 raw → 2 series + 5 occurrences, idempotent). Remaining for recurring: T042 migrate
the 104 existing seed events → series + T043 feed/calendar cutover — must land TOGETHER
(else Hemisfèric vanishes from the feed). **Enrich skeleton done** (T050/T056):
`lib/pipeline/enrich.ts` — injectable `EnrichClient`, `EnrichmentResult` schema,
`enrichOne` (COALESCE promote, maps→links_json), `enrichCards` (selection + fail-soft +
dry); SDK-free/mockable, live-verified COALESCE; 23/23 tests. **Notify done** (T070/T072 + T071 logic): `lib/pipeline/notify.ts` — pure
`selectDigest`/`selectAlerts`/`isFamilyFit`/`cardConfidence`/`withinHorizon` +
`buildDigest`/`renderDigestText` + pluggable `sendDigest` (dry default) +
`markEventsNotified`/`markPlacesNotified` (live-verified no-repeat = SC-002); 29/29.
**Enrich engine (revised per user): `claude -p` (Claude subscription/OAuth, NO API key)
is the DEFAULT** — the Anthropic SDK (`ANTHROPIC_API_KEY`) is OPTIONAL (constrained
decoding / Vercel serverless runtime, where the CLI is absent). enrich.ts is
engine-agnostic (injectable client), so T051 = build a `claude -p` client (no key).
**Digest route done** (T071); **PARSER_REGISTRY done** (T010, `resolveParser` in
ingest.ts). **Ad-hoc user requests go to the "Backlog — user inbox" section of
tasks.md** (the loop reads tasks.md) — no special command; user may prefix `бэклог:`.
**RULE (user, REQUIRED): a message prefixed `backlog:` / `бэклог:` goes STRAIGHT into the
spec backlog (the "Backlog — user inbox" section of `tasks.md`) as a new item — IMMEDIATELY,
record-only: do NOT deliberate about how/whether to do it, do NOT drop the current task,
just append it (even if nothing about it exists there yet) and keep working. Flesh it out
later when the loop picks it up.**
**T130 logunespa crawl — IN PROGRESS** (user priority). `scripts/crawl-telegram.mjs`
(via `node --import tsx`) + `lib/pipeline/telegram-post.ts` parser: public
`t.me/<ch>/<n>?embed=1`, **HTML fetch-cache** in `data/.cache/` (gitignored — no
re-fetch on re-runs), `claude -p` extraction routes `place`→`data/seed/places-<ch>.json`
/ dated `event`→`data/seed/events-<ch>.json` (captures date/place/category/price). 4
records so far (3 places + 1 dated event). Resumable (continues from lowest crawled id);
run slowly to backfill ~1800 posts. **Link-following enrichment DONE**: `claude -p` WebFetches the post's source
links and reads them (validated — Titanic exhibition got exact address/price/venue from
bombasgens.com; Las Fallas from visitvalencia). **Crawl mode (user): PLACES-ONLY, 20/batch** —
`node --import tsx scripts/crawl-telegram.mjs logunespa 0 20 1500 places` (the 6th arg `places`
skips dated events; resumable from lowest crawled id). ~13 places + 19 events so far. Run as
a BACKGROUND command if 20 posts may exceed the 10-min foreground cap. Backlog: T132 Fever
drone-show extractor, T133 done, T053/T022/T042+T043, T134 design MCP, T135 part-1 names,
T136 worldafisha≈concerten dedup, T137 drop deprecated `fetchConnectionCache` in `lib/db.ts`.
**Ultracode fan-out round 1 DONE** (user enabled ultracode): a background Workflow ran 4
file-disjoint bundles in parallel + a verify phase, integrated by the main loop (tsc=0,
76/76 tests). **Bundle A (T011–T015)**: adaptive ingest — pure `lib/pipeline/cadence.ts`
(clamp/computePollInterval gap×0.33/backoffUnchanged ×1.5/backoffError ×2/selectDue),
`dispatcher.ts` (selectDueSources + bounded dispatch pool, persists cadence state per
outcome), conditional GET in `util.ts`/`ingest.ts` (ETag/If-Modified-Since → 304 →
`source_runs.not_modified`), `/api/cron/dispatch` fail-closed route (scheduler.yml `*/15`
tick was already wired), per-type cadence seed defaults. **Bundle E (T051~/T052/T053~/T054)**:
`enrich.ts` — `normalizeEnrichment` (drop unknown keys, clamp confidence, shape
links/citations), `groundReport`/`applyGroundOrFlag` (flag uncited facts, hold <0.6),
opt-in `{web}` EnrichClient capability (default off), `needsEnrich` + series-once
enrich (COALESCE preserve). T051/T053 are `[~]`: schema + `{web}` interface done, but the
OCR-extract CALL + web execution wait on the concrete **`claude -p` EnrichClient** (still
the open engine task). T055 (enrich workflow/cron) deferred → needs sub-area B `workflow`
pkg. **Bundle G (T073/T074)**: `notify.ts` series-aware digest (one card + next occurrence,
`markSeriesNotified` no-repeat on series_id); wiring it into the digest route = T071
follow-up. **Bundle N (T110/T111/T112)**: worldafisha (spain-filter pre-gate per T136),
valenciarusa, vidacultural normalizers, registered + fail-soft (run end-to-end once live
`source_items` exist). NEXT (serial, can't parallelize — fight over run.ts/queries.ts/
Home.tsx + need `npm i workflow`): round-2 bundles **B** (pipeline order: enrich before geo
in run.ts; `withWorkflow`; T022/T055 workflows) then **D+F** (Hemisfèric→series cutover
T042–T044; places catalog + map T060–T065).
**Round-2 started (inline, safe parts)**: **T020 done** — enrich slot wired into
`run.ts` BEFORE geo, gated on an injected `enrichClient` (off the default fast/key-free
path; the workflow or a local keyed run passes one). **`claude -p` EnrichClient built**
(`lib/pipeline/enrich-client.ts`, `createClaudeEnrichClient`) — the DEFAULT key-free
engine (subscription/OAuth, shells out like the crawler), `{web}` flag → WebFetches the
card's source links to GROUND facts + cite them; pure helpers `enrichSourceLinks`/
`buildEnrichPrompt`/`extractJsonObject` + 6 tests (82/82, tsc=0). This completes **T053**
([x]) and the engine half of **T051** (still `[~]`: poster-image OCR remains). STILL
DEFERRED (touch `next dev`/package.json — do carefully): T021 `npm i workflow` +
`withWorkflow` in `next.config.mjs` + drop `vercel.json` maxDuration; then T022/T055
workflows.
**Round-2 (workflow `wjkuqd3dz`, ultracode) — D DONE, B DEFERRED.** Sub-area D landed
(T042–T044 ✅): `scripts/migrate-hemisferic-series.mjs` (now chained into `db:setup` via
`db:migrate:series`) converts the 104 `api:hemisferic` events → 11 `event_series` + 104
`event_occurrences`, marks the 104 raw events `status='duplicate'`+`metadata.merged_into_series`
(idempotent, live-verified 11/104/0-in-feed). `lib/queries.ts` UNIONs events ∪ series
(`getSeriesEvents`/`seriesToSiteEvents`/`getSeriesDetail`; SiteEvent gains `is_series`/
`occurrence_count`/`series_id`/`calendar_only`); `Home.tsx` feed shows ONE card per series,
calendar buckets occurrences into `.day-hemis`, map skips `calendar_only`; series detail at
`/events/series-<id>-…`. build green, 99/99 tests. **B DEFERRED (T021/T022/T055 reverted
clean):** `workflow@4.5.0` IS the real Vercel Workflow SDK but does NOT build with
next@14.2.15 LOCALLY — its auto `/.well-known/workflow/v1/*` routes crash page-data
collection on Vercel-OIDC resolution (`path.parse(undefined)`) with no linked Vercel project.
Options: build it only on a real Vercel deploy/preview (skip local gate), or pin compatible
versions / upgrade Next. T023 ✅ (offline run.ts/.mjs path is the live path, verified).
**OPS:** the logunespa crawler hit the **Claude subscription monthly spend limit** — so
`claude -p` (crawler AND the default enrich engine) is unavailable until the limit is raised
(claude.ai/settings/usage); enrich on Vercel needs the SDK path regardless. *(spend limit
later lifted — crawler resumed, then **PAUSED by user at 51 places** — catalog has ~59
logunespa places, 14 mapped; resume the historical crawl LATER, after other tasks; do NOT
auto-restart it. ~8 places still have a raw maps-URL as the name → T135 cleanup + geo resolve.)*
**T137 DONE** (dropped deprecated `fetchConnectionCache`). **T138 DONE** (`/api/health` + `lib/pipeline/health.ts`
`sourceStale`/`pipelineWarnings` + `scripts/smoke.mjs`/`npm run smoke` + test; 117/117).
**T139 DONE — `claude -p` model tiering (cost opt, user).** Both `claude -p` callsites ran with
NO `--model` (inherited session default, likely opus). A background eval (opus/sonnet/haiku ×
translation/grounded) found: **haiku safe for RU translation** (PATH A), **sonnet is the floor for
grounded WebFetch extraction** (PATH B — haiku gives up on dead links; opus not worth the cost).
`enrich-client.ts` now picks per-path via `pickEnrichModel(web)` (haiku/sonnet; `opts.model` pins
both; env `ENRICH_MODEL`/`ENRICH_MODEL_WEB`); audit `model` records the ACTUAL per-call model;
crawler default `sonnet` (`CRAWL_MODEL`). **CRITICAL FIX the eval surfaced**: in `-p` mode WebFetch
is BLOCKED without `--allowedTools WebFetch` → model asks permission, returns no JSON → T053
web-grounding + crawler link-following were SILENTLY broken; both now pass the flag when grounding
(pure `buildClaudeArgs`). 120/120, tsc=0. **T136 verify-half DONE** (focused worldafisha≈concerten
PAIR dedup test — both source links kept; live wiring waits on T112 concerten normalizer).
**T135 PART 1 GEO DONE — DETERMINISTIC (no LLM), per the user's "JS before LLM" rule (T140).**
`scripts/bake-place-geo.mjs` + `lib/pipeline/geo.ts` `resolvePlaceGeo`/`mapsAddressQuery`: follow
`maps.app.goo.gl` redirect → geocode the STREET ADDRESS (the maps `q=` leads with the venue NAME,
which fooled Nominatim into the València city-centre fallback centroid; bare address → exact venue),
`isCentroid` guard rejects fallback hits (null > fake pin). **46/51 logunespa places mapped (was 14)**,
coords BAKED into `data/seed/places-logunespa.json` → prod map renders without a slow geocode at
db:setup; same fix repairs the LIVE geo stage (it was also producing centroids). 124/124. **T140
(standing rule): prefer deterministic JS over `claude`/LLM wherever rule/keyword extraction works;
haiku for specific tasks (translation), sonnet only for grounding.** *(loop PAUSED by user after this
tick — will restart manually; do NOT auto-resume.)*
**LOCAL prod-build glitch — RESOLVED.** After the workflow churn a local `next start` 500'd
("Cannot find module './vendor-chunks/next.js'") from a corrupted `.next` (overlapping /
truncated builds + dirty `node_modules`). Fixed with `npm ci` + `rm -rf .next && npm run
build`: HOME and /places both 200. (Note: in Next 14.2.15 `.next/server/vendor-chunks/`
may legitimately be absent — its absence is NOT the problem; a clean build is the fix.)
`package-lock.json` is clean; if a local `npm start` ever 500s again, `npm ci` + clean
rebuild resolves it. Vercel (clean install per deploy) is unaffected.
**Loop restarted (user `/loop /speckit-implement`).** Tick A: **T101 DONE** (4 spec-named
sources added to `data/seed/sources.json` — elcontacto/russpain/eventbrite enabled,
spainnewsonline off; routed via existing `parseGeneric`, raw stays `ignored` until
normalizers exist). Tick B (ultracode Workflow `wzu3tktls`, 3 file-disjoint bundles +
adversarial verify): **dedup finalized** — **T035 DONE** (the real gap: deterministic
`strongMatchKey`/`strongMatchPrePass` in `dedup.ts` collapse exact `url` / source-scoped
`external_ref` BEFORE the fuzzy pass, +4 tests; over-merge guards intact, idempotent);
**T036/T038 confirmed done** (places `arePlacesDuplicate` logic + tests solid, DB
orchestrator still deferred to T064; dedup wired in `run.ts` offline order). **Eval
harness DONE** — **T090** (`promptfooconfig.yaml` + `providers/promptfoo-enrich.mjs` custom
provider driving the REAL `enrich-client.ts` + Haiku RU-rubric grader), **T092**
(`npm run eval` via `scripts/eval.mjs`, KEY-GATED → no key/CLI = skip + exit 0, never
gates CI; runs `promptfoo` via `npx --yes` at runtime, NO new dep), **T091** (12 golden
fixtures in `tests/fixtures/enrich/` from real seed: 7 PATH A / 3 PATH B w/ citations /
2 Hemisfèric series; `generate.mjs` threads per-case asserts incl. link-survival).
Verifier flagged non-canonical `links_json` in 3 B-fixture `expected` blocks → main loop
stripped it (canonical `links`/`citations` kept; generator falls back to `links`). Clean
`rm -rf .next && npm run build` green, **128/128** tests, eval key-gate verified exit 0.
**Tick C (ultracode Workflow `w2ejd5p3b`, concerten + WORKBOARD).** **concerten normalizer built**
(`lib/pipeline/normalizers/concerten.ts`): pure `buildConcertenEvents` + mandatory Spain pre-filter
(`isSpainEvent`/`hasNonSpainSignal`, symmetric to worldafisha — drops Europe-wide tours + location-less
posts) + `spainCity` (picks the actual matched ES city, not blanket Valencia); `normalizeConcerten`
mirrors `normalizeVidacultural` (append-only `markRawItem` on every processed row, idempotent
`upsertPlainEvent`), registered in `NORMALIZER_REGISTRY`. This **fulfils T131** (concerten-side Spain
filter wiring → **T131 [x]**); T136 live worldafisha≈concerten dedup still waits on real `source_items`.
NOTE: T112 was already done (= vidacultural, not concerten — scout mislabel corrected). **T103 [~]**:
WORKBOARD.md reconciled vs real tasks.md markers; the multi-lens verifier caught WORKBOARD over-claims
(it had collapsed `[~]` T041/T050/T070/T071 into `[x]` ranges) → main loop corrected them. **TEST-HARNESS
FIX**: `npm test` now runs `node --import tsx --test …` — under Node 24's native TS strip (no tsx), an
extensionless `../../db` imported (transitively) from a statically-imported pipeline `.ts` does NOT
resolve, so concerten (the FIRST test to import a real normalizer module) failed with ERR_MODULE_NOT_FOUND
while passing under the agents' tsx self-check; adding `--import tsx` resolves `.ts` like the rest of the
toolchain (build/run-pipeline). Build green, **137/137** tests (128 + 9 concerten).
**Tick D (ultracode Workflow `w1h4o8rxw`, E2E + normalizer).** **T102 DONE [x]** — full E2E on
the LIVE local stack (Docker Postgres + Neon HTTP proxy, prod `next start` on :3939): seed clean
(406 events / 11 series / 104 occurrences / 65 places / 27 sources / 216 media; series migration
idempotent, 0 hemis rows leaked), ALL core routes **200 + non-empty** (`/` feed+calendar+Leaflet map
w/ real coords, `/places` 65 venues, TWO series detail pages = recurring cutover renders a per-day
session schedule, an individual event detail), server log clean (0 errors/500s), cleanup done. This
verifies the constitution's "site renders deterministically from the DB". Only non-200 = `/api/health`
503 BY DESIGN on a seed-only DB (no `source_runs` run on record) → filed **T143** (health/smoke
ergonomics; likely auto-resolves once T141 live-ingest populates `source_runs`); geo coverage 14/65
places → T135. **valenciabonitatelegram normalizer built** (`lib/pipeline/normalizers/valenciabonita-telegram.ts`):
pure `buildValenciabonitaTgEvents` REUSES sibling helpers (looksLikeEvent/postTitle/parseEventDate/
parsePrice/parseVenue/parseAddress — DRY) + deterministic `detectLang`/`deriveCategory` (no LLM, T140),
`normalizeValenciabonitaTg` mirrors vidacultural (append-only, idempotent), registered; wires the
enabled-but-ignored `tg:valenciabonitatelegram` source into the pipeline (FR-001). 7 tests, both verify
lenses `ok`. **USER DIRECTIVES (2026-06-21, committed `abfe122`):** live internet ingest → `source_items`
PERMITTED (backlog **T141**; unblocks T033/T034/T136, de-speculates normalizers — see [[valencia-radar-db-gap]]);
rutatuta_vlc excursions → distinct colour (**T142**, extends T133); `backlog:`-prefixed messages go
STRAIGHT into the tasks.md backlog (record-only, no deliberation). Build green, **144/144** tests.
**Tick E (T141 live ingest — DONE [x]; first REAL data in the persistent local DB).** Ran
`ingestAll()` one polite live pass → **890 `source_items`** (20 sources ok; 5 err: `tg:rutatuta_vlc`
Neon "unexpected end of hex escape" on insert → T147, `web:cac_*`×4 `fetch failed` → T148), then
`normalizeAll()` → **42 events from REAL data** (valenciarusa 20 / vidacultural 10 / concerten 5 /
valenciabonita-tg 5 / worldafisha 2; hemisferic idempotent). The local DB now PERSISTS across ticks
(never teardown — user rule) and accumulates. `source_runs` populated (21 ok) → /api/health should now
pass (T143 likely auto-closes). **Inspection found the top quality bug → T145**: `parseEventDate` doesn't
recognise real RU/UK date formats ("МАР 18", "16 декабря", "23 липня"…) so most events are `start_date=null`
— next high-value fix (deterministic JS, T140). Also **T146** (web normalizers ingest nav/contact junk +
title cruft), **T147/T148** (above). **T144 part 1 DONE [~]**: `scripts/export-seed.mjs` (`npm run
export-seed`) — read-only SELECT dump of the live DB → seed JSON (round-trips via `db:setup`; defaults to
scratch `data/seed-export/`, `--commit` → `data/seed`; mirrors `seed.mjs` cols incl. enrich). Gate: build
green, **144/144** tests.
**Tick F (T145 DONE [x] — parseEventDate RU/UK, ultracode Workflow `w2gb5i4au`).** `parseEventDate`
(worldafisha.ts, shared by ALL normalizers) rewritten: RU nominative+genitive months + 3-letter abbrevs
(any case, МАР/ДЕК) + UK months (липня=July…) + numeric + day-first AND month-first; year-inference = next
occurrence on/after `today` (month+day); fixed a `/u`-flag `\b` bug skipping leading Cyrillic. Signature
preserved. Both verify lenses `ok`; 16/16 worldafisha, **155/155** total, clean build green. **Verified
END-TO-END on the live DB**: re-`normalizeAll()` → **35/44 events now dated** (was ~null). **KEY FINDING →
T144**: the SEED `events.json` was built with the OLD parser (stale null-dates) → the local-first re-bake
must re-normalize with this fixed parser. **DB-persistence lesson**: seed events ALSO carry `source_item_id`,
so it does NOT distinguish freshly-ingested rows — used a clean delete+reseed; the **898 raw `source_items`
persist** (canonical seed restored, 406 events). Filed earlier this session: T146/T147/T148 (web junk /
rutatuta hex-escape / cac fetch-fail). Gate: build green, 155/155.
**Tick G (date recovery toward a clean seed, ultracode Workflow `wq30in27f`).** **T150 DONE [x]** —
worldafisha `dateFromUrl(url)` extracts the date from the `/event/…-YYYY-MM-DD` slug (preferred over
text), `isEventUrl` drops 57 non-events (`/persons/` artist pages + index), `cancelled` flag; live: 23/23
`/event/` dates recovered (was 0/23). **T151 DONE [x]** — built `lib/pipeline/normalizers/fever.ts` (+
registered); the agent CORRECTED the brief's wrong premise (fever raw_text has NO ISO date — it's a
flattened card string with SPANISH dates "4 jul"/"5 dic - 6 feb") by inspecting real rows, parses
deterministically → 45 events / 35 dated, drops nav/snapshot/gift-card. Both verify verdicts were FALSE
-POSITIVE "scope violation"s (each verifier saw the OTHER bundle's files in the shared `git status` and
mis-attributed — the impls are file-disjoint + correct). **New finding → T153 (HIGH)**: `spain-filter.ts`
doesn't match Latin-translit city slugs (valensiya/barselona/alikante) → 21/23 worldafisha Valencia events
still dropped at the Spain gate. Gate: clean build green, **177/177** tests (155 + 9 worldafisha + 13 fever).
**Seed-rebuild (user "перестрой seed чтоб без null дат") IN PROGRESS** — recovering dates first (T150/T151
done; T153/T146/T152 next), then re-normalize on the live DB + export the clean dated seed; the destructive
`data/seed/` overwrite will be confirmed with the user first (curated feria/fever/logunespa content).
**Tick H (clean-quality, ultracode Workflow `w397bvz78`).** **T153 DONE [x]** — spain-filter.ts +7
Latin-translit city stems (valensi/barselon/alikante/marbel/sevil/saragos/tenerif); live worldafisha
`/event/` slugs through the Spain gate **2/23 → 23/23** (non-Spain still excluded). **T146 DONE [x]** —
deterministic `isJunkCard` (email/@handle/nav+legal labels/channel-header/"pinned a photo") in
valenciarusa.ts, reused by vidacultural.ts; live valenciarusa 22→19, vidacultural 17→10, 0 real events
lost. Both verify `ok` (the "ignore parallel-bundle files" instruction killed the prior false-positive
scope flags). Gate: clean build green, **194/194** tests. **MEASURED (read-only, all date fixes applied)**:
the 6 normalizers now yield **107 events / 91 dated (85%)** from 238 raw `source_items` (worldafisha 23/23,
valenciarusa 19/19, vidacultural 10/9, concerten 5/3, valenciabonita 5/2 [relative ES dates→T152], fever
45/35). Was ~42 events near-all-null before. NEXT: confirm seed-rebuild scope/overwrite policy with the
user, then re-normalize→export the clean dated seed (the other ~13 sources still lack normalizers → all
`ignored`; full T144 bake wants those too).
**Tick I — PAUSED on session spend-limit (resets ~03:00 Europe/Madrid).** User decision: bake ALL
sources, DROP date-less events (skip T152). Launched Workflow `w6juuvq0q` to build the 10 remaining
event normalizers (palau/ticketmaster/songkick/visitvalencia/hoyvalencia/eventbrite/laganzua/lacotorra/
elcontacto/russpain) against REAL live data; agents do NOT edit `normalize.ts` (main loop wires the
registry). **PARTIAL**: all 10 `lib/pipeline/normalizers/<src>.ts` + `tests/normalize-<src>.test.mjs`
are ON DISK (UNTRACKED, uncommitted) but the run hit the session limit — **build:hoyvalencia + build:laganzua
FAILED** (files exist but may be incomplete/unverified) and **8 verifies did NOT run** (palau/ticketmaster/
songkick/visitvalencia/eventbrite/lacotorra/elcontacto/russpain built + self-checked but UNVERIFIED).
Confirmed-good self-checks from the run: palau 63→10 ev/10 dated (8 tests), ticketmaster 65→28/28 (11),
songkick 58→26/8 (date lives only in a partner row). Full report: the workflow output file.
**RESUME PLAN (after limit reset):** (1) re-verify the 8 + re-build hoyvalencia/laganzua; (2) `node -c`
each + run each new test file, fix failures; (3) wire all 10 into `NORMALIZER_REGISTRY` (each exports
`<NAME>_SOURCE_KEY` + `normalize<Name>`); (4) gate `npm run build` + `npm test`; (5) re-normalize the live
DB + measure all 16 sources; (6) commit. The 10 untracked files persist on disk meanwhile. (User: "подожди
1ч 20м и продолжи тики с этим".)
**RESUMED (limit reset, user OK'd expensive actions).** Triage: all 10 new test files PASS
(palau 8 / ticketmaster 11 / songkick 8 / visitvalencia 8 / hoyvalencia 16 / eventbrite 8 /
laganzua 9 / lacotorra 8 / elcontacto 8 / russpain 11) — the "failed" builds were complete.
Wired all 10 into `NORMALIZER_REGISTRY` (now 17). Gate: clean build green, **289/289** tests.
**Full real-data measure (16 event sources, read-only): 709 raw → 367 events, 239 dated (65%).**
GOOD: palau 10/10, ticketmaster 28/28, worldafisha 23/23, valenciarusa 19/19. **QUALITY ISSUES
to FIX (synthetic tests pass but real data is off) → T154**: visitvalencia 56 events / **0 dated**
(dates not parsed), lacotorra 8 raw → **56 events** (explosion?), laganzua **1**/47 (over-filter),
elcontacto 0/3 + russpain 0/4 (RU sites, 0 events), eventbrite 7/61 + songkick 8-dated/26 +
hoyvalencia 38/76 (check). Adversarial verify never ran (died on the limit) — these need a
verify+fix pass before the seed bake.
**Tick J — SEED REBAKED CLEAN (user "перестрой seed чтоб без null дат", drop dateless).** Fixed the 6
flagged normalizers (T154, all verify ok): eventbrite link_card→snapshot-driven (7→14); visitvalencia
0-dated = data genuinely has no dates; lacotorra 56 = 1 multi-event snapshot; elcontacto/russpain = 404
chrome. **dedup over-merge fixed (T035 follow-up)**: `strongMatchKey` keyed on url ALONE collapsed
multi-event-per-page sources (lacotorra 56→1) — tightened to `url|titleSignature|start_date`; live re-bake
verified lacotorra 56/56, eventbrite 14/14. **T155 (user "дубли не наплодятся") VERIFIED**: 0 unmerged
cross-source dup groups (no under-merge). **BAKE** (normalize→dedup→score→tag, geo skipped): 709 raw →
**294 dated seed events, 0 null dates**. Exported `data/seed/events.json` = 239 derived dated alive events
(ids 25171-25544, no collision with curated 1001-24796); kept curated feria(43)/fever(2); cleaned
events-logunespa.json 19→10 (dropped 9 dateless). **FOUND T156**: dedup ALSO over-merges same-source
curated feria (43→2) — the ≥2-source guard slips; sidestepped for the seed (curated taken from files) but
a LIVE-pipeline bug. **T157**: baked events have no geo (lat/lng null) — run geoEnrich + re-export for the
map. The persistent local DB + 898 source_items live on. Build green, 295/295.

**Non-negotiables** (see constitution v1.1.0): append-only raw `source_items`; dedup
keeps a link to every source (via `entity_sources`) and never merges on fallback geo
alone; all schema changes additive (`IF NOT EXISTS`); enrichment is batched/fail-soft
on the Anthropic SDK, grounds-or-flags facts (never invents); notifications opt-in +
de-duplicated for events AND places; recurring schedules idempotent; site renders
deterministically from the DB; every autonomous change builds green and commits.
<!-- SPECKIT END -->
