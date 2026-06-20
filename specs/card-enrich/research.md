---
spec: card-enrich
phase: research
created: 2026-06-20T13:40:00Z
provider: Anthropic / Claude (claude-haiku-4-5 default, claude-opus-4-8 for hard cards)
---

# Research: card-enrich

## Executive Summary

Build `lib/pipeline/enrich.ts` as an injectable `@anthropic-ai/sdk` call (per
`llm-testing` Decision B) that turns a raw `events`/`places` row into a polished
"post": RU title + body, tidied/extended description, structured links, category,
confidence, and — critically — a **citations-grounded** enrichment that flags rather
than invents conflicting facts. **Web augmentation ("гуглить") = Anthropic's
server-side `web_search` + `web_fetch` tools in the SAME `messages` call** (one
durable step does OCR + translate + lookup + extract). Web search is **$10/1k
searches**, web fetch is **free** (token-only), both return **citations** — strictly
better grounding than hand-rolling the project's `fetchText`+search. Enrich does
**NOT** geocode: it proposes a clean `venue_name`/`address` (+ optional `maps_url`)
and the **existing `geo.ts` stays the geocoder** (run geo AFTER enrich). Runs as a
per-card Vercel Workflow `'use step'` (fail-soft, idempotent, `enriched_at IS NULL`).
A **worked reference already exists in the seed** (event 106): `enrichment_json`
with `confidence: 0.95` and a `notes` field flagging a Telegram-vs-official date
conflict — adopt that exact shape.

## Key Findings

| # | Finding | Evidence |
|---|---------|----------|
| 1 | **Enrichment not built.** `lib/pipeline/enrich.ts` and `/api/cron/enrich` don't exist; no `@anthropic-ai/sdk`/`workflow`/`promptfoo` dep in `package.json`. Clean slate. | `lib/pipeline/run.ts` (ingest→normalize→score→tag→geo, **no enrich**); `grep` package.json |
| 2 | **A worked enrichment already exists in seed data** (event 106, Слава Комиссаренко). `enrichment_json` = `{title_ru, description_ru, start_date, end_date, start_time, venue_name, address, category, price, is_free, links[], confidence:0.95, notes}`. `notes` literally flags *"в Telegram 21 июля, на афише/сайте Roig Arena — 21 июня"*. This is the schema + anti-hallucination posture, demonstrated. | `data/seed/events.json` id=106 `enrichment_json` |
| 3 | **DB columns already exist** for every enriched field. events: `title_ru, description_ru, links_json, enrichment_json, enriched_at, lat, lng, geo_source, venue_name, address, district, image_url, price, is_free, category, tags_json`. places: same minus event-only + **`maps_url`**. **events have NO `maps_url` column.** | `db/schema.sql` events (l.54–99) / places (l.104–135) |
| 4 | **Coverage is near-zero** → big batch. Of 342 events: **1** has `title_ru`/`enrichment_json`, 34 have `lat`, 179 have `image_url`. 14 places (some have `maps_url`, e.g. `https://maps.google.com/?q=39.46,-0.37`). | `node` count over seed |
| 5 | **Web search tool**: `web_search_20250305` (basic) / `web_search_20260209` (dynamic filtering) / `web_search_20260318` (latest, +response_inclusion). Declared in `tools:[{type,name:"web_search",max_uses,allowed_domains,blocked_domains,user_location}]`. **$10 / 1,000 searches** + token cost. **Citations always on**; results carry `url,title,page_age,encrypted_content` + `web_search_result_location` citations. Supported on Opus 4.8 / Sonnet 4.6 / + (Haiku via basic). | platform.claude.com web-search-tool.md (verified) |
| 6 | **Web fetch tool**: `web_fetch_20250910` (basic) / `_20260209`+ (dynamic filter). **No extra charge — token-only.** Returns full page/PDF as a `document` block; citations **opt-in** (`citations:{enabled:true}`). **Security: can only fetch URLs already in context** (user msg / prior search/fetch result) — cannot fetch model-invented URLs. `max_content_tokens` caps size; no JS-rendered pages. | platform.claude.com web-fetch-tool.md (verified) |
| 7 | **Structured output is GA, constrained decoding** (reuse `llm-testing` Dec A): `messages.parse()` + `output_config:{format:{type:"json_schema",schema}}` → `response.parsed_output`. Schema limits: every object needs `additionalProperties:false`; **no min/max, no minLength/maxLength** (validate bounds in tests). | `llm-testing/research.md` Dec A/Finding 6; claude-api skill §Structured Outputs |
| 8 | **⚠ Structured output is NOT directly composable with server tools in one call.** `web_search`/`web_fetch` run a server-side loop (`pause_turn`); `output_config.format` shapes the *final* turn. Pattern: let Claude search/fetch freely, then constrain the final answer. **Citations + structured output = 400 (incompatible).** → Two viable shapes (Decision A). | web tools docs (`pause_turn`, server loop); tool-use-concepts.md "Structured Outputs … Incompatible with: Citations" |
| 9 | **geo.ts already does geocoding** end-to-end: resolves `maps.app.goo.gl`/`@lat,lng`/`?q=` from `venue_url`(events)/`maps_url`(places), else Nominatim over `venue_name+address+city`. Selects `WHERE lat IS NULL AND (venue_url|address|venue_name)`. Enrich must **feed** this, not duplicate it. | `lib/pipeline/geo.ts` |
| 10 | **Render already consumes enriched fields.** detail page: `title_ru ?? deriveTitle`, `description_ru ?? description ?? raw_excerpt`, `image_url`, `RichText`, `LinkButtons(links_json)`. Home/map: `lat/lng` markers, `source_url ?? maps_url` link. So enrich's outputs flow straight to UI with no render change. | `app/events/[id]/page.tsx` l.21–56; `app/Home.tsx` l.280–331 |
| 11 | **Constitution IV is explicit & names this spec.** *"`claude -p` enrichment (poster OCR, RU translation, title/body split) MUST run in background/cron batches, never one long blocking call … incremental and idempotent … a failed/partial enrichment MUST NEVER corrupt the base record."* Plus I (append-only raw; conflicts resolve by weight+score, retain links). | `.specify/memory/constitution.md` IV, I |
| 12 | **Vercel Workflow fit decided.** enrich = `enrichWorkflow(limit)` → select-batch step + `Promise.all` of per-card `enrichOne(card)` `'use step'`; each card retries independently (fail-soft). Trigger `/api/cron/enrich` → `start(enrichWorkflow,[limit])`. | `vercel-workflow/research.md` D-WF1, step-mapping table |
| 13 | **No `temperature` knob on Opus 4.8/Haiku-structured path** — determinism via constrained decoding + low `effort`, not `temperature:0`. Opus 4.8/4.7 **400** on `temperature`. | claude-api skill (sampling params removed) |
| 14 | **Vision/OCR is one content block, same call.** Poster image as `{type:"image",source:{type:"url"|"base64",…}}` in the same `messages.parse()` → OCR + translate + extract in one step. 179/342 events have `image_url`. Opus 4.7+ high-res vision (2576px) for dense posters. | claude-api skill (Vision); web tools share the call |

## Decisions

### Decision A — Web augmentation = Anthropic `web_search` + `web_fetch` server tools (in the enrich call), final turn constrained to schema

**Decision**: The enricher runs as a **server-tool-enabled `messages` call**: declare
`web_search` (+ `web_fetch`, +`image` block for OCR) so Claude "googles" the venue /
date / official ticket page itself, then return the enriched JSON. Because server
tools + `output_config.format` can't trivially co-exist in one turn (Finding 8), use
**Shape A1 (recommended)**:

- **A1 — tool turn then parse turn.** Call 1: `messages.create({tools:[web_search,
  web_fetch], messages:[card + poster image + "look up & verify, cite sources"]})`,
  loop on `pause_turn`. Call 2 (or same conversation, final turn): re-issue with
  `output_config.format` (no tools, no citations) to coerce the verified facts into
  the schema. Two model calls per *hard* card; one for *easy* (no-search) cards.
- **A2 — strict tool as the writer.** Single call: declare `web_search` + a
  `submit_enrichment` **custom tool with `strict:true` + `input_schema`**; force
  `tool_choice` to it at the end. One call, but more wiring; keep as fallback.

**Rationale**:
- **Grounding/citations for free** (Finding 5): every web-sourced fact carries a
  `url`+`cited_text`. That is the backbone of the anti-hallucination strategy
  (constitution I) — we can persist citations into `enrichment_json.notes`/a
  `citations[]` array. Hand-rolling `fetchText`+a search step gives raw HTML, no
  grounding metadata, and re-implements what Claude does natively.
- **One step does it all** (Findings 8,14): OCR (image block) + translate + lookup
  (search/fetch) + extract (final schema) in one durable workflow step — matches
  constitution IV's "poster OCR, RU translation, title/body split" as one unit.
- **Cost is controllable**: `max_uses:3` bounds search spend ($10/1k → ~$0.03/card
  worst case at 3 searches); **web_fetch is free**; most cards need 0–1 searches.
- **`web_fetch` URL safety** (Finding 6): it can only fetch URLs already in context
  — we *seed* the card's own `source_url`/`url`/`links_json` so Claude can fetch the
  **original source** (Telegram post, ticket page) deterministically without search.

**Alternatives considered**:
- *App-side `fetchText`/`fetchJson` (geo.ts/util.ts style) + a search API, fed to the
  model as text*: fully deterministic & mockable, **zero per-search $**, no new
  Console toggle. **But** no citations/grounding, must pick & run a search provider,
  re-implements fetch/clean, and the model can still hallucinate over the dumped
  text. **Recommend as the offline/no-key fallback** behind the same `enrichOne`
  interface (mirrors `local-run`): when web tools are off, pass `source_url` content
  via `fetchText` into the prompt. Best of both: web tools in prod, app-fetch offline.
- *No web at all (source-only enrich)*: cheapest/most deterministic; loses "гуглить"
  (can't find official venue/coords/correct date). Make web augmentation a **flag**
  (`{web:boolean}`) so easy cards skip it and tests run offline.

**Testability**: `enrichOne(card,{client})` injects the SDK client (mirrors
`dedup({exec})`); unit tests stub the client → fixed JSON, **no network, no $**. Live
web-tool behavior is exercised only in the gated `npm run eval` (llm-testing Dec C).

### Decision B — Output schema maps 1:1 to existing columns; the seed's `enrichment_json` IS the schema

**Decision**: Adopt the **event-106 `enrichment_json` shape verbatim** as the
constrained output, persisted to `enrichment_json` (full audit blob, append-only),
with the consumable fields **promoted to columns**. (Full schema + per-field
source-of-truth in the next section.)

**Rationale**: It already exists, already renders, already round-trips through
`links_json`/`title_ru`/`description_ru`, and already carries `confidence`+`notes`.
Don't invent a new schema. The model returns the blob; `enrichOne` writes the
columns + the blob in one UPDATE.

**Alternatives**: a flatter schema without `notes`/`confidence` — rejected, those two
fields ARE the data-integrity mechanism (Decision D).

### Decision C — Geo reconciliation: enrich PROPOSES location, geo.ts GEOCODES; run geo after enrich

**Decision**: Enrich does **not** call Nominatim or compute lat/lng. It outputs a
clean `venue_name`, `address`, optional `district`, and — when it found one via
search/fetch — a Google Maps URL. Pipeline order becomes
`… → geoEnrich? → enrich → geoEnrich`. The **post-enrich `geoEnrich`** then geocodes
the freshly-cleaned `venue_name+address` (its existing Nominatim path) — strictly
more rows resolve because enrich filled `venue_name`/`address` that were null.

**Maps URL handling** (Finding 3 — **events lack a `maps_url` column**):
- **places**: write the Maps URL to the existing `places.maps_url` (geo already reads
  it as a geocode source — bonus).
- **events**: **no column.** Options for requirements: (a) **store the Maps URL in
  `links_json`** as a `{label:"Google Maps",url}` entry (renders today via
  `LinkButtons`, zero migration) — **recommended**; (b) reuse `venue_url` (geo reads
  it — also feeds geocoding); (c) add an `events.maps_url` column (migration, but
  `db:schema` is `IF NOT EXISTS` additive). **Flag (a) vs (c) for requirements.**
- Don't have the model *fabricate* `?q=lat,lng` — only emit a Maps URL it actually
  found (a place's official Google listing) or a safe `?q=<venue_name>+<address>`
  search URL (deterministic, not a coordinate claim).

**Rationale**: geo.ts is tested, handles redirect-resolution + Nominatim + rate-limit
sleep; duplicating it in enrich violates DRY and risks divergent coords. Enrich's job
is to make the *text inputs* geo needs correct. Avoids two geocoders.

**Alternatives**: enrich calls geo inline per card — rejected (couples stages, Nominatim
1.1s sleep inside the LLM step blows step latency, duplicates logic).

### Decision D — Anti-hallucination: ground-or-flag, never invent; raw untouched; confidence + citations

**Decision** (TOP concern, constitution I): the prompt + schema enforce —
1. **Never invent dates, prices, venue, address.** If a fact isn't in the source or a
   cited web result, the field stays **null**, and the gap goes in `notes`.
2. **Conflicts are flagged, not resolved silently.** When source ≠ web (the event-106
   case: Telegram 21 июля vs Roig Arena 21 июня), record BOTH in `notes` and pick the
   higher-authority one (official venue/ticket page > Telegram), lowering `confidence`.
3. **Every added/changed fact must be grounded**: from the source text/image, or a web
   citation (`url`). Persist a `citations[]` (url + what it supports) in
   `enrichment_json`.
4. **`confidence` 0–1** per card; low-confidence cards can be held from the digest /
   surfaced for review.
5. **Translation/rewrite must preserve** names, dates, numbers, venue verbatim
   (llm-rubric checks this in eval).
6. **Raw is sacred** (constitution I): enrich reads `events`/`places` + `source_items`
   and writes only enriched columns; `source_items` never mutated. Re-enrichment just
   re-UPDATEs the event row.

**Rationale**: matches constitution I ("conflicts resolve by source weight+score,
retain links to every source") and IV ("failed/partial enrichment must never corrupt
the base record"). The seed already proves the pattern (`confidence`+`notes`).

**Alternatives**: "trust the model, no confidence/notes" — rejected, that's the
hallucination footgun the goal's "дописывать/гуглить" creates.

### Decision E — Model & cost: Haiku 4.5 default, escalate to Opus 4.8 for hard/low-confidence cards

**Decision**: `claude-haiku-4-5` ($1/$5 per MTok) is the default enricher. Escalate to
`claude-opus-4-8` ($5/$25) **only** for: poster-only cards (heavy OCR), cards the
Haiku pass returns `confidence < threshold`, or conflict cards. Web-search billed
separately ($10/1k) regardless of model. Use `output_config:{effort:"low"}` for the
structured pass (no `temperature` — Finding 13).

**Rationale**: ~342 events, tens/run — Haiku keeps per-card cost ~cents; reserve Opus
spend for the cards that need vision/reasoning. Per-call `usage` tracks spend
(llm-testing). Two-tier mirrors the "cheap default, escalate" pattern.

**Alternatives**: Opus for everything (3–5× cost, unjustified at this scale); Haiku
only (misses hard OCR/conflict cases). Two-tier is the balance.

## Enrichment JSON Schema + per-field source-of-truth & grounding rules

Output shape (constrained via `output_config.format`; objects `additionalProperties:false`;
bounds enforced in tests, not schema — Finding 7). Mirrors seed event-106.

```jsonc
{ "type":"object","additionalProperties":false,
  "required":["title_ru","description_ru","confidence"],
  "properties":{
    "title_ru":      {"type":"string"},                        // short headline, ≤~72ch (test-checked)
    "description_ru":{"type":"string"},                        // tidied/extended RU body
    "category":      {"type":["string","null"]},               // standup|concert|...
    "start_date":    {"type":["string","null"],"format":"date"},
    "end_date":      {"type":["string","null"],"format":"date"},
    "start_time":    {"type":["string","null"]},               // "HH:MM"
    "end_time":      {"type":["string","null"]},
    "venue_name":    {"type":["string","null"]},
    "address":       {"type":["string","null"]},
    "district":      {"type":["string","null"]},
    "price":         {"type":["string","null"]},               // "40 €"
    "is_free":       {"type":["boolean","null"]},
    "maps_url":      {"type":["string","null"],"format":"uri"}, // only if found/safe search URL
    "image_url":     {"type":["string","null"],"format":"uri"}, // a better poster found, else keep existing
    "links":         {"type":"array","items":{"type":"object","additionalProperties":false,
                       "required":["label","url"],
                       "properties":{"label":{"type":"string"},"url":{"type":"string","format":"uri"}}}},
    "citations":     {"type":"array","items":{"type":"object","additionalProperties":false,
                       "required":["url","supports"],
                       "properties":{"url":{"type":"string","format":"uri"},"supports":{"type":"string"}}}},
    "ocr_text":      {"type":["string","null"]},               // raw text pulled from poster
    "confidence":    {"type":"number"},                        // 0–1 (range test-checked)
    "notes":         {"type":["string","null"]} } }            // conflicts/gaps/provenance
```

**Source-of-truth & grounding per field**

| Field | Primary source | Grounding rule | Persists to |
|---|---|---|---|
| `title_ru` | source title/body + OCR | rewrite of existing text; no new facts | `events.title_ru` |
| `description_ru` | source desc/body + OCR + web | tidy+translate+extend; every *added* sentence needs a citation | `events.description_ru` |
| `start/end_date`, `start/end_time` | source first; **official ticket/venue page via fetch** overrides | NEVER invent; conflict → `notes` + lower `confidence`; null if unknown | `events.start_date` … |
| `venue_name`, `address`, `district` | source + web search/fetch | clean only; feeds geo.ts (Decision C); null if unknown | columns |
| `price`, `is_free` | source + official page | never guess a number; null if unknown | `events.price/is_free` |
| `maps_url` | web search result, or safe `?q=venue+address` | no fabricated coordinates | places.maps_url / events links_json (Dec C) |
| `image_url` | existing `image_url`, or poster found via search | keep existing unless a clearly-better official one cited | `events.image_url` |
| `links` | source `links_json` + ticket/official URLs found | URLs must be real (from source or cited result) | `events.links_json` |
| `citations` | web_search/web_fetch result `url`s | one per web-sourced fact | `enrichment_json` |
| `confidence`, `notes` | model self-assessment | mandatory; `notes` records all conflicts/gaps | `enrichment_json` |
| `enriched_at` | `nowIso()` set by `enrichOne` | — | `events.enriched_at` |

Full object → `enrichment_json` (append-only audit). `enrichOne` writes promoted
columns **with `COALESCE`-style guards** so a null from the model never clobbers an
existing good value.

## Where code lives (file plan)

```text
package.json                       EDIT  add dep @anthropic-ai/sdk (+ workflow per vercel-workflow); ANTHROPIC_API_KEY to .env.example
lib/pipeline/enrich.ts             NEW   enrichOne(row,{client,web,exec}) + enrichCards(limit,{dry,client,exec}); '+use step'
lib/pipeline/enrich-schema.ts      NEW   JSON schema + (optional) Zod; prompt builder
app/workflows/enrich.ts            NEW   'use workflow' enrichWorkflow(limit) → select-batch + Promise.all(enrichOne) (vercel-workflow D-WF1)
app/api/cron/enrich/route.ts       NEW   CRON_SECRET-gated → start(enrichWorkflow,[limit])
lib/pipeline/run.ts                EDIT  optional: run enrichCards before final geoEnrich (Decision C ordering)
tests/enrich.test.mjs              NEW   mocked-client unit: field mapping, fail-soft, COALESCE guard, confidence/notes (llm-testing)
tests/fixtures/enrich/*.json       NEW   golden cards incl. event-106 conflict + a poster-OCR case
```

Selection (idempotent, batched — constitution IV): `WHERE enriched_at IS NULL ORDER BY
score DESC NULLS LAST LIMIT $limit`; per-item `try/catch`, on error increment `errors`,
leave row un-enriched (still renderable). Re-enrich trigger: `enriched_at IS NULL`
(or a force flag / `last_seen > enriched_at`).

## Related Specs

| Spec | Relation | mayNeedUpdate |
|------|----------|:---:|
| `llm-testing` | **High** — defines the SDK+structured-output mechanism & eval/mock harness this spec builds on. This spec is the FEATURE; its `enrichOne`/schema are exactly what llm-testing's fixtures/promptfoo target. | **maybe** (point fixtures at this schema; add web-tool stub) |
| `vercel-workflow` | **High** — enrich = `enrichWorkflow` step (D-WF1). Build enrich as a workflow from the start; trigger route added. | **no** (already anticipated) |
| `001-valencia-events` | **High** — owns `enrich.ts` (T043–T046), enrichment columns, contracts, constitution I/IV. This spec specifies enrich's mechanism/schema/grounding. | **yes** (T043 acceptance: SDK + web tools + schema + grounding; note no events.maps_url) |
| `local-run` | **Medium** — offline tier needs an enrich path with no key/network: the app-fetch fallback (Decision A alt) + mocked unit tests fit; live web tools need key + Console toggle. | **maybe** (document web-tool key/toggle + offline fallback) |

## Quality Commands

| Type | Command | Source |
|------|---------|--------|
| Lint | `npm run lint` (`next lint`) | package.json scripts.lint |
| TypeCheck / compile gate | `npm run build` (`next build`) | package.json scripts.build; constitution VI |
| Unit Test | `npm test` (`node --test tests/**/*.test.mjs`) | package.json scripts.test |
| Integration / dry-run | `npm run pipeline:run` | package.json scripts |
| Eval (LLM, gated) | `npm run eval` (to add — promptfoo, key+cost gated) | llm-testing Dec C |
| Build | `npm run build` | package.json scripts.build |
| E2E | Not found | — |

**Local CI**: `npm run lint && npm run build && npm test`

## Verification Tooling

| Tool | Command | Detected From |
|------|---------|---------------|
| Dev Server | `npm run dev` (`next dev`) | package.json scripts.dev |
| Browser Automation | none | — |
| E2E Config | none | — |
| Port | 3000 (Next default) | next defaults |
| Health/trigger endpoint | `GET/POST /api/cron/enrich` (CRON_SECRET) → `{runId}` | this spec (new) |
| Docker | via `local-run` (not yet in repo) | local-run/.progress.md |

**Project Type**: Web app (Next.js 14 App Router) + internal pipeline library + cron jobs.
**Verification Strategy**: `npm run build` (type/compile gate) → `npm test` (mocked
enrich unit: field mapping + fail-soft, no key/network) → gated `npm run eval`
(promptfoo over golden cards incl. the event-106 conflict + a poster-OCR case, Haiku
grader) → manual: trigger `/api/cron/enrich`, confirm `enriched_at`/`title_ru`/
`enrichment_json` written and base record still renders if a card errors.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|:---:|:---:|------|
| **Hallucinated dates/prices/venue** (the core "дописывать" risk) | Med | **High** | Ground-or-null + `notes` + `citations` + `confidence` (Dec D); eval asserts date/venue match; official-page-overrides-source rule |
| Web search cost creep ($10/1k) | Med | Low | `max_uses:3`; web_fetch (free) of the card's own `source_url` first; `{web:false}` for easy cards; batch caps |
| Server tools + structured output not co-callable in 1 turn (Finding 8) | High | Med | Two-turn shape A1 (tool turn → parse turn), or strict-tool A2; **never** combine citations + `output_config.format` (400) |
| Model nulls clobber existing good columns | Med | Med | `COALESCE`/guarded UPDATE; enrich only fills/overwrites with confidence; raw untouched |
| `events` has no `maps_url` column | High | Low | Maps URL → `links_json` entry (renders today) or `venue_url`; or additive `IF NOT EXISTS` column (Dec C) |
| Web fetch can't read JS-rendered pages / only context URLs | Med | Low | Seed `source_url`/`links_json` into the prompt so fetch targets are present; search fills the rest |
| ANTHROPIC_API_KEY + Console web-search toggle absent in env/CI | High | Med | Mocked unit default (no key); web tools gated to `eval`/prod; app-fetch offline fallback (local-run) |
| Console admin must enable web search | Low | Med | Document as prerequisite; fallback to app-fetch when disabled |
| Latency: per-card search+OCR could be slow | Med | Low | Per-card Vercel Workflow step (escapes 300s); Haiku; `max_uses` cap |

## Feasibility / Risk / Effort

- **Feasibility: High** — every output column exists; a worked enrichment lives in the
  seed; web tools verified & available; mechanism (SDK + structured output + workflow
  step) decided by prior specs; render already consumes the fields.
- **Risk: Medium** — hallucination is the real risk (mitigated by ground-or-flag +
  confidence + citations); secondary: web-tool cost/availability + the structured-output
  ⊕ server-tool two-turn wrinkle.
- **Effort: M** — `enrich.ts` (`enrichOne`+`enrichCards`, injectable client) +
  `enrich-schema.ts`/prompt + workflow + cron route + mocked unit + a few golden
  fixtures. (L only if the two-turn search→parse flow + per-field grounding prompt need
  heavy iteration, or if an `events.maps_url` migration + backfill is in scope.)

## Open Questions (for requirements)

1. **events Maps URL**: store in `links_json` (no migration, renders now) **[recommended]**,
   reuse `venue_url` (feeds geo), or add an `events.maps_url` column?
2. **Web augmentation default**: on for all cards, or `{web:false}` default + opt-in for
   low-confidence/poster cards (cost vs completeness)? And is the Console web-search
   toggle + `ANTHROPIC_API_KEY` available, or must offline app-fetch be the primary path?
3. **Single-turn vs two-turn** (A1 vs A2): accept 2 model calls per searched card for
   clean structured output, or invest in the strict-tool single-call writer?
4. **`confidence` threshold** that (a) escalates Haiku→Opus, (b) holds a card from the
   digest / flags for review? (e.g. <0.6 hold, <0.8 review.)
5. **Re-enrichment trigger**: only `enriched_at IS NULL`, or also re-run when
   `last_seen > enriched_at` (source changed) / on a force flag?
6. **Scope now**: events + places both, or events first (places are only 14 rows but
   have `maps_url` + different fields)?
7. **Image/poster OCR scope**: always OCR when `image_url` present (179/342), or only
   when source text is thin? (cost/vision-model tradeoff.)

## Sources
- platform.claude.com `agents-and-tools/tool-use/web-search-tool.md` (verified: `web_search_2025…/2026…`, $10/1k, citations always-on, max_uses, domain/location filters, response shape, pause_turn)
- platform.claude.com `agents-and-tools/tool-use/web-fetch-tool.md` (verified: `web_fetch_2025…/2026…`, free/token-only, citations opt-in, **context-URL-only** security, max_content_tokens, no-JS)
- claude-api skill: §Structured Outputs (GA, `messages.parse`/`output_config.format`, schema limits), §Vision, model table (Haiku 4.5 $1/$5, Opus 4.8 $5/$25), sampling-param removal; tool-use-concepts.md ("Structured Outputs … Incompatible with: Citations")
- `specs/llm-testing/research.md` (Decisions A/B/C: SDK constrained decoding, injectable client, promptfoo+node:test)
- `specs/vercel-workflow/research.md` (D-WF1 enrich as per-card workflow step; step-mapping)
- `.specify/memory/constitution.md` (I Data Integrity First; IV Batched, Resilient Enrichment — names this work)
- Repo: `db/schema.sql` (events/places enrichment columns; **events has no maps_url, places.maps_url exists**); `data/seed/events.json` id=106 (**worked `enrichment_json` with confidence+notes conflict flag**) & coverage counts; `lib/pipeline/geo.ts` (geocoder to reconcile), `util.ts` (`fetchText`/`fetchJson` fallback), `normalize.ts`, `format.ts` (`deriveTitle`/RichText/LinkButtons); `app/events/[id]/page.tsx` + `app/Home.tsx` (render consumes title_ru/description_ru/links_json/lat/lng/image_url); `lib/pipeline/run.ts` (pipeline order); `package.json` (no anthropic/workflow/promptfoo dep yet)
