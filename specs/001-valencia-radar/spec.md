# Feature Specification: Valencia Radar — curated events & places radar

**Feature Branch**: `001-valencia-radar`

**Created**: 2026-06-20 · **Consolidated**: 2026-06-20 (merged the original
`001-valencia-events` speckit feature with seven ralph-specum research specs —
`pipeline`, `dedup`, `card-enrich`, `repeateable-events`, `llm-testing`,
`local-run`, `vercel-workflow` — into this single authoritative feature; the
originals are preserved under `specs/_archive/`).

**Status**: Draft

**Input**: Personal events + places notifier and website for a Russian-speaking
expat family in Valencia, Spain (planner + partner + their kid Mark). Aggregate
22+ Telegram/web sources into one database; normalize, dedupe, score, tag,
enrich (Anthropic SDK OCR + RU translation), and geo-enrich; deliver (1) a
curated events afisha website and (2) a places/restaurants catalog; plus a weekly
curated digest and rare-event alerts.

## Scope map (sub-areas)

This feature is organized into bounded sub-areas; design detail and tasks are
grouped by them in `plan.md`, `data-model.md`, and `tasks.md`:

- **A. Ingestion & Source Registry** — parser + normalizer registries, "add a
  source" contract, per-source adaptive cadence, conditional-GET, bounded
  parallel pool with per-source failure isolation, dispatcher.
- **B. Pipeline Architecture & Execution** — the canonical stage order and the
  durable Vercel Workflow substrate (refresh/enrich/digest workflows).
- **C. Deduplication** — two-layer dedup for events *and* places, the
  `entity_sources` link table, geo guards.
- **D. Recurring Events** — `event_series` + `event_occurrences`; series-level
  enrich/score/notify.
- **E. Card Enrichment** — Anthropic SDK constrained decoding, canonical
  `enrichment_json` schema, ground-or-flag anti-hallucination, model tiering.
- **F. Outputs & Surfaces** — events afisha (feed + calendar + map + detail) and
  the independent places/restaurants catalog.
- **G. Notifications** — weekly digest + rare alert, notified bookkeeping,
  transport.
- **H. Local Dev** *(tooling)* — offline Docker Postgres + Neon HTTP-proxy run.
- **I. LLM Evaluation** *(tooling)* — promptfoo + `node:test` eval harness.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Curated events website (feed + calendar + map + detail pages) (Priority: P1)

The family planner opens the website and immediately sees a curated, filtered feed
of upcoming events that fit the family — not raw scrape noise. At the top sits a
month calendar (defaulting to the current month) alongside a map of venues; the
long scrollable feed is below. Recurring / many-session offerings like the
Hemisfèric films appear as **one card per series** (not one row per showing); each
session still appears on the correct calendar day, and the card's detail page lists
the full schedule. Every event and place has its own detail page showing the source
link, tags, an image when available, and — when enrichment has run — a clean short
title plus a Russian-translated description with clickable links.

**Why this priority**: This is the MVP — the single place the family actually
looks at to decide "what shall we do." Without it nothing else delivers value.

**Independent Test**: Load the site against the seeded database; confirm the feed
shows only curated events (no navigation/category junk), the calendar opens on the
current month, the map plots venues, each Hemisfèric film is one feed card whose
detail page shows every session while the calendar still buckets sessions by day,
and clicking any event/place opens a detail page with a working source link.

**Acceptance Scenarios**:

1. **Given** a database of normalized, scored events, **When** the planner opens the home page, **Then** they see a filtered feed of upcoming events plus a calendar (current month) and a venue map above a long list.
2. **Given** a recurring offering with many sessions (e.g. a Hemisfèric film across 14 days), **When** the feed and calendar render, **Then** the feed shows one card for the series and the calendar buckets each session on its date; the detail page lists the full schedule.
3. **Given** any event or place in the feed, **When** the planner clicks it, **Then** a dedicated detail page opens with title, description, tags, image (if any), and a link back to the original source.
4. **Given** an event whose card has been enriched, **When** its detail page renders, **Then** the title is a short headline (not a wall of text) and the description is in Russian with clickable links.

### User Story 2 - Weekly curated digest (Priority: P1)

Every Friday around 09:00 Europe/Madrid the planner receives a digest covering the
next 2–3 weeks, containing only events that fit the family — RU
standup/concerts/meetups/lectures, big city festivals, family shows, and bright
gastro — plus a small "new places on the radar" block. Events already sent in a
prior digest are not repeated, and low-confidence (unverified) enriched cards are
held back rather than shown with possibly-wrong facts.

**Why this priority**: Proactive curation is the core promise ("notify me, don't
make me check"). It is the reason to build a database rather than just browse
channels.

**Independent Test**: Run the digest in dry-run against the database; confirm it
selects only fitting, upcoming (within horizon) events above the score threshold,
excludes anything already marked notified and anything below the confidence-hold
threshold, includes a "new places" block, and on a real (non-dry) run records
deliveries so a second run does not repeat them.

**Acceptance Scenarios**:

1. **Given** scored events within the 2–3 week horizon, **When** the weekly digest runs, **Then** it includes only family-fitting events above threshold and excludes village-fiesta/tourist noise.
2. **Given** an event included in last week's digest, **When** this week's digest runs, **Then** that event is not listed again.
3. **Given** newly catalogued places since the last digest, **When** the digest runs, **Then** a short "new places on the radar" block is appended and previously-sent places are not repeated.
4. **Given** an enriched event whose confidence is below the hold threshold, **When** the digest runs, **Then** that event is withheld (not shown with unverified facts).

### User Story 3 - Rare-event alert (Priority: P2)

When something rare and high-value appears between weekly cycles — for example a
well-known standup comedian announcing a Valencia tour — the planner gets a quick
standalone alert rather than waiting for Friday.

**Why this priority**: High-value, time-sensitive items (tickets sell out) justify
breaking the weekly cadence, but this is secondary to the weekly digest existing.

**Independent Test**: Feed in an event scoring above the "rare/high-value"
threshold with a near horizon; confirm an alert is emitted once and then marked so
it is not re-sent or duplicated in the weekly digest.

**Acceptance Scenarios**:

1. **Given** a newly ingested event above the rare-value threshold, **When** the alert check runs, **Then** a single alert is produced for it.
2. **Given** an event already alerted, **When** the next alert check or weekly digest runs, **Then** it is not sent again.

### User Story 4 - Places / restaurants catalog (Priority: P2)

The planner browses a catalog of recommended places and restaurants, mined from
the same channels, categorized so they can answer "where for date night / with
Mark / a big group / takeaway," and filter by cuisine, district, price, and who
recommended it. A place recommended by several channels appears once, crediting all
recommenders, and (when enrichment has run) shows a Russian description.

**Why this priority**: A valuable independent second output, but the events afisha
is the primary draw; the catalog can grow alongside it.

**Independent Test**: From places in the database, confirm the catalog lists them
with category facets (cuisine, district, occasion, price, recommender), that a
multi-recommended place appears once with all recommenders, that each place has its
own detail page; confirm the catalog renders even if the events side has gaps.

**Acceptance Scenarios**:

1. **Given** places mined from channels, **When** the planner opens the catalog, **Then** places are categorized by cuisine, district, occasion, price, and recommender.
2. **Given** the events pipeline has a gap or failure, **When** the catalog is requested, **Then** it still renders (the two outputs are independent).
3. **Given** the same place recommended by multiple channels, **When** the catalog renders, **Then** it appears once with every recommender credited.

### User Story 5 - Trustworthy, deduplicated, mapped, grounded data (Priority: P3)

The planner trusts what they see: the same real-world concert appearing in three
sources collapses into one event with the correct date (an incorrect Telegram-post
date is overridden by a higher-weight/higher-score source) while keeping a link to
every contributing source; events with any location hint show up at accurate map
locations; and enriched content never invents facts — gaps are left blank and
conflicts are flagged.

**Why this priority**: Quality/trust hardening that makes stories 1–4 dependable;
important but layered on top of them.

**Independent Test**: Seed three records for one concert (e.g. Слава Комиссаренко)
with conflicting dates; confirm they merge to one entity carrying links to all
three sources and the date from the most reliable source; confirm distinct
real-world places at identical fallback coordinates do *not* merge; confirm a large
majority of events with an address or maps link receive coordinates; confirm an
enriched card with a source/poster conflict records the conflict and lowers its
confidence instead of guessing.

**Acceptance Scenarios**:

1. **Given** three source records for one concert with differing dates, **When** dedup runs, **Then** one event remains, dated from the highest source-weight/score record, retaining references to all contributing sources.
2. **Given** events carrying an address, venue name, or `maps.app.goo.gl` link, **When** geo-enrichment runs, **Then** most of them gain coordinates and appear on the map.
3. **Given** an enriched card where the poster and the source text disagree on a date, **When** enrichment runs, **Then** the conflict is recorded in `notes`, the higher-authority value is chosen, and confidence is lowered (no silent invention).

### Edge Cases

- A source returns a redirect (e.g. 308), changes its HTML, or is temporarily down — the run for other sources MUST still complete and be logged (per-source failure isolation).
- A raw item is navigation/category/pagination junk — it is marked ignored and never surfaces as an event.
- Enrichment of one card fails or times out — the un-enriched event remains valid and renderable; the failure does not corrupt the record or abort the batch.
- An event has no usable date or only a vague "date TBA" — it is excluded from the calendar/digest horizon logic but may still exist as a record.
- A Telegram channel is private/closed — it is skipped (public `t.me/s/` preview only) unless explicitly approved for a heavier path.
- The same place is recommended by multiple channels — it appears once with all recommenders credited.
- Two distinct real-world places share identical *fallback* coordinates (e.g. an area-centroid geocode) — they MUST NOT be merged by proximity alone.
- A recurring offering's schedule is unchanged between runs — re-ingestion adds no duplicate occurrences and does not re-trigger enrichment.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST ingest from the configured 22+ sources (Russian-language sites, city/Spanish sites, ticketing/experience platforms, official city/CAC APIs, and public Telegram channels via `t.me/s/` web preview) into an append-only raw layer.
- **FR-002**: System MUST normalize raw items into `events`, `places`, and (for recurring offerings) `event_series` + `event_occurrences`, marking each raw item normalized, ignored, or error, and never deleting raw rows.
- **FR-003**: System MUST deduplicate events *and* places across sources, collapsing records for the same real-world entity into one while retaining a link to **every** contributing source item (recorded in an `entity_sources` link table, with a denormalized convenience copy on the survivor).
- **FR-004**: System MUST resolve conflicting attributes (notably event dates) during dedup by source weight and score, keeping the most reliable value, and MUST NOT merge distinct entities on geographic proximity alone (fallback/centroid coordinates never vote).
- **FR-005**: System MUST score each event 0–100 to express how well it fits the family, suppressing perennial/tourist filler and elevating RU/local/family signals.
- **FR-006**: System MUST tag events and places with machine-usable labels (e.g. city, language, category, family, has-image, source-type).
- **FR-007**: System MUST geo-enrich events and places, resolving short map links and geocoding addresses/venue names into coordinates, while respecting external rate limits (Nominatim ≥1.1s pacing + real User-Agent).
- **FR-008**: System MUST enrich cards in resilient batches via the Anthropic SDK with constrained-decoding structured output (poster OCR, Russian translation, short-title/body split, clickable links, citations) without long blocking calls, MUST keep the base record valid if enrichment fails, and MUST ground or flag every fact (never invent dates/prices/venues). A `claude -p` fallback path exists for offline/no-key use.
- **FR-009**: System MUST present a website with a filtered event feed, a month calendar defaulting to the current month, and a venue map, with the calendar+map above a long list.
- **FR-010**: System MUST surface recurring / many-session offerings (e.g. Hemisfèric films) as one feed card per series, while the month calendar buckets each session on its own date and the detail page lists the full schedule. (Supersedes the original "one card per day" wording.)
- **FR-011**: System MUST provide an individual detail page for every event, series, and place, each showing source link(s), tags, image (if any), and translated content when available.
- **FR-012**: System MUST produce a weekly digest (Friday ~09:00 Europe/Madrid, 2–3 week horizon) of only family-fitting events plus a "new places" block, excluding already-notified events/places and holding back enriched cards below the confidence threshold.
- **FR-013**: System MUST record notification deliveries for **both** events and places so neither is re-notified, and digest dispatch MUST be explicit (opt-in), never automatic spam.
- **FR-014**: System MUST emit a standalone rare-event alert for high-value items between weekly cycles, marked so they are not duplicated.
- **FR-015**: System MUST provide a places/restaurants catalog categorized by cuisine, district, occasion (date night / with Mark / big group / takeaway), price, and recommender, renderable independently of the events side; places MAY carry the same RU enrichment as events.
- **FR-016**: System MUST run the pipeline on a schedule and render the site deterministically from the database (no live scraping/heavy enrichment at request time), in the canonical stage order **ingest → normalize → dedup → score → tag → enrich → geo**.
- **FR-017**: System MUST tolerate individual source failures (redirects, HTML changes, downtime) without aborting the whole run, logging each run's outcome.
- **FR-018**: System MUST model recurring offerings as a parent `event_series` (the card) plus child `event_occurrences` (the dated sessions), and MUST run enrich/score/notify once per series — not once per occurrence (e.g. 104 Hemisfèric rows → 11 series + 104 occurrences).
- **FR-019**: System MUST poll each source on an adaptive cadence derived from its observed change rate (frequently-changing Telegram channels more often than rarely-changing official pages), bounded by per-type floors/ceilings, using a fine-grained external scheduler tick; a daily full "force all" run remains as a safety-net.
- **FR-020**: System MUST be idempotent at every stage: re-running ingest on an unchanged source adds no duplicate raw items or occurrences; re-running dedup resolves to the same stable survivor id; re-running enrich skips already-enriched rows; nothing re-fires notifications.
- **FR-021**: System MUST persist a confidence (0–1) and a `notes` field per enriched card, and MUST use the confidence to gate digest inclusion (hold low-confidence) and model escalation (cheap model by default, escalate to a stronger model for poster-heavy / low-confidence / conflicting cards).
- **FR-022**: System MUST be fully runnable and verifiable offline by a developer (local Postgres + seed data + pipeline stages that need no network), and the LLM enrichment MUST be testable without network or API key (mocked client) with a separate, key-gated live evaluation harness.

### Key Entities *(include if feature involves data)*

- **Source**: A configured origin (site, API, or Telegram channel) with a weight/quality tier, enabled flag, and adaptive-cadence state (poll interval, next-due, change/fail counters); the provenance of everything ingested.
- **Source run**: A logged execution against a source (status, item count, whether it produced changes / was unmodified) for observability.
- **Source item (raw)**: An append-only raw captured item before normalization, carrying original text, links, images, and a dedup hash.
- **Event**: A normalized single-shot happening with title, description, date/time, venue/location, coordinates, score, tags, translated fields, notified state, and links to contributing sources.
- **Event series**: A recurring/many-session offering (the card) carrying enrichment, score, tags, notified state, and a schedule summary.
- **Event occurrence**: One dated session of a series (date + session time), feeding the calendar.
- **Place**: A normalized venue/restaurant with name, location/district, categories (cuisine, occasion, price), recommender(s), tags, coordinates, and optional translated fields.
- **Entity source (link)**: A row tying a survivor event/place to each contributing raw source item, with the match method and score — the source-of-truth provenance for dedup.
- **Media asset**: One or more images attached to an event or place.
- **Notification**: A delivery log entry tying an event/series/place to a digest or alert that was sent.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The home feed contains zero raw navigation/category/pagination junk items — every surfaced item is a real event, series, or place.
- **SC-002**: The weekly digest never repeats an event or place that a previous digest already sent (0 duplicate notifications across runs).
- **SC-003**: Every set of source records describing the same real-world event collapses to exactly one event entry, carrying links to all its sources; distinct real-world entities at identical fallback coordinates are never merged.
- **SC-004**: At least 80% of events that carry any location hint (address, venue name, or map link) are plotted on the map with coordinates.
- **SC-005**: The calendar opens on the current month by default, every time, regardless of the oldest data in the database.
- **SC-006**: Card enrichment completes its batch without timing out, and a failed individual enrichment leaves the corresponding event/place fully renderable.
- **SC-007**: The website renders the same result given the same database state (deterministic, no request-time scraping), and the places catalog renders even when the events pipeline has gaps.
- **SC-008**: The weekly digest, given a fixed database, selects only family-fitting events within the 2–3 week horizon above the score threshold and at/above the confidence threshold (curation is verifiable, not arbitrary).
- **SC-009**: A many-session offering produces one feed card per series and one calendar entry per session (e.g. the seed's 104 Hemisfèric rows render as 11 cards with their sessions intact), and a re-run on an unchanged schedule creates 0 new occurrences and re-fires 0 enrichments.
- **SC-010**: Enriched cards introduce no invented facts: every fact added beyond the source is grounded by a citation or left null, and conflicts are recorded in `notes` with a lowered confidence (verifiable on the golden fixture set).
- **SC-011**: A developer can bring the whole app up offline from a clean checkout (local DB + seed) and run the non-network pipeline stages; the mocked enrichment test suite passes with no API key or network.

## Assumptions

- Audience is a small private household (the planner, partner, and child Mark); there is no multi-tenant/public-account requirement, so authentication and per-user accounts are out of scope for this feature.
- Telegram ingestion uses only public `t.me/s/<channel>` web previews (~last 20 posts); private channels and full history are out of scope unless a specific channel is later approved for a heavier path.
- The existing Node.js codebase, Postgres schema, and seed data (≈342 events, 14 places, 22 sources, 216 media assets) are reused; all schema growth is additive (`IF NOT EXISTS`), never destructive.
- "Family-fitting" curation defaults to: RU standup/concerts/meetups/lectures, big city festivals/fallas, family shows, and bright gastro; small village fiestas are excluded unless notably special; SpainNewsOnline-style political news is excluded by default.
- Digest cadence defaults to weekly Friday ~09:00 Europe/Madrid with a 2–3 week look-ahead; the hosting scheduler may constrain finer cadences (see dependency below).
- The enrichment engine is the Anthropic TypeScript SDK (`@anthropic-ai/sdk`) with constrained decoding; `claude -p` (OAuth) is the offline/no-key fallback. `ANTHROPIC_API_KEY` is required for the live path and the live eval, and is documented in `.env.example`.
- The notification transport defaults to **dry-run text output** behind a pluggable sender; a real transport (a single private chat/webhook or email) is chosen by an env flag and may start as dry-run.
- Local development uses Dockerized Postgres 15 behind a Neon HTTP proxy so production DB call paths are untouched; a Neon dev-branch URL is the no-Docker fallback.

### Dependencies

- Requires a hosted Postgres database and a scheduler to run the pipeline and digest. The current hosting tier (Vercel Hobby) allows only one cron/day; the desired finer ingest cadence plus the weekly Friday digest are driven by an external scheduler (GitHub Actions cron) hitting `CRON_SECRET`-protected endpoints — no paid tier required. Upgrading to Vercel Pro (native multi-cron) is a deferred option.
- Durable pipeline/enrich/digest jobs depend on the Vercel Workflow SDK to escape the 300s function cap with per-step retries.
- Geo-enrichment depends on an external geocoding service (Nominatim) subject to rate limits and acceptable-use (pacing and a real User-Agent required).
- Card enrichment depends on the Anthropic API (text + vision, and optional web search/fetch tools) invoked in batches; absent a key, the offline fallback / mocked path is used.
