# Feature Specification: Valencia Radar — curated events & places radar

**Feature Branch**: `001-valencia-events`

**Created**: 2026-06-20

**Status**: Draft

**Input**: User description: Personal events + places notifier and website for a Russian-speaking expat family in Valencia, Spain (planner + partner + their kid Mark). Aggregate 16+ Telegram/web sources into one database; normalize, dedupe, score, tag, geo-enrich, and translate; deliver (1) a curated events afisha website and (2) a places/restaurants catalog; plus a weekly curated digest and rare-event alerts.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Curated events website (feed + calendar + map + detail pages) (Priority: P1)

The family planner opens the website and immediately sees a curated, filtered feed
of upcoming events that fit the family — not raw scrape noise. At the top sits a
month calendar (defaulting to the current month) alongside a map of venues; the
long scrollable feed is below. Many-session venues like the Hemisfèric are
color-coded and collapsed into a single card per day that reveals each session
time on expand. Every event and place has its own detail page showing the source
link, tags, an image when available, and — when enrichment has run — a clean
short title plus a Russian-translated description with clickable links.

**Why this priority**: This is the MVP — the single place the family actually
looks at to decide "what shall we do." Without it nothing else delivers value.

**Independent Test**: Load the site against the seeded database; confirm the feed
shows only curated events (no navigation/category junk), the calendar opens on the
current month, the map plots venues, Hemisfèric days collapse to one card with
session times, and clicking any event/place opens a detail page with a working
source link.

**Acceptance Scenarios**:

1. **Given** a database of normalized, scored events, **When** the planner opens the home page, **Then** they see a filtered feed of upcoming events plus a calendar (current month) and a venue map above a long list.
2. **Given** a day with many Hemisfèric sessions, **When** that day is shown in the calendar, **Then** it appears as one color-coded card that expands to list each session with its time, rather than one row per session.
3. **Given** any event or place in the feed, **When** the planner clicks it, **Then** a dedicated detail page opens with title, description, tags, image (if any), and a link back to the original source.
4. **Given** an event whose card has been enriched, **When** its detail page renders, **Then** the title is a short headline (not a wall of text) and the description is in Russian with clickable links.

### User Story 2 - Weekly curated digest (Priority: P1)

Every Friday around 09:00 Europe/Madrid the planner receives a digest covering the
next 2–3 weeks, containing only events that fit the family — RU
standup/concerts/meetups/lectures, big city festivals, family shows, and bright
gastro — plus a small "new places on the radar" block. Events already sent in a
prior digest are not repeated.

**Why this priority**: Proactive curation is the core promise ("notify me, don't
make me check"). It is the reason to build a database rather than just browse
channels.

**Independent Test**: Run the digest in dry-run against the database; confirm it
selects only fitting, upcoming (within horizon) events above the score threshold,
excludes anything already marked notified, includes a places block, and on
`--mark-sent` records deliveries so a second run does not repeat them.

**Acceptance Scenarios**:

1. **Given** scored events within the 2–3 week horizon, **When** the weekly digest runs, **Then** it includes only family-fitting events above threshold and excludes village-fiesta/tourist noise.
2. **Given** an event included in last week's digest, **When** this week's digest runs, **Then** that event is not listed again.
3. **Given** newly catalogued places since the last digest, **When** the digest runs, **Then** a short "new places on the radar" block is appended.

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
recommended it.

**Why this priority**: A valuable independent second output, but the events afisha
is the primary draw; the catalog can grow alongside it.

**Independent Test**: From places in the database, confirm the catalog lists them
with category facets (cuisine, district, occasion, price, recommender) and that
each place has its own detail page; confirm the catalog renders even if the events
side has gaps.

**Acceptance Scenarios**:

1. **Given** places mined from channels, **When** the planner opens the catalog, **Then** places are categorized by cuisine, district, occasion, price, and recommender.
2. **Given** the events pipeline has a gap or failure, **When** the catalog is requested, **Then** it still renders (the two outputs are independent).

### User Story 5 - Trustworthy, deduplicated, mapped data (Priority: P3)

The planner trusts what they see: the same real-world concert appearing in three
sources collapses into one event with the correct date (an incorrect Telegram-post
date is overridden by a higher-weight/higher-score source), and events with any
location hint show up at accurate map locations.

**Why this priority**: Quality/trust hardening that makes stories 1–4 dependable;
important but layered on top of them.

**Independent Test**: Seed three records for one concert with conflicting dates;
confirm they merge to one entity carrying links to all three sources and the date
from the most reliable source; confirm a large majority of events with an address
or maps link receive coordinates.

**Acceptance Scenarios**:

1. **Given** three source records for one concert with differing dates, **When** dedup runs, **Then** one event remains, dated from the highest source-weight/score record, retaining references to all contributing sources.
2. **Given** events carrying an address, venue name, or `maps.app.goo.gl` link, **When** geo-enrichment runs, **Then** most of them gain coordinates and appear on the map.

### Edge Cases

- A source returns a redirect (e.g. 308), changes its HTML, or is temporarily down — the run for other sources MUST still complete and be logged.
- A raw item is navigation/category/pagination junk — it is marked ignored and never surfaces as an event.
- Enrichment of one card fails or times out — the un-enriched event remains valid and renderable; the failure does not corrupt the record or abort the batch.
- An event has no usable date or only a vague "date TBA" — it is excluded from the calendar/digest horizon logic but may still exist as a record.
- A Telegram channel is private/closed — it is skipped (public `t.me/s/` preview only) unless explicitly approved for a heavier path.
- The same place is recommended by multiple channels — it appears once with all recommenders credited.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST ingest from the configured 16+ sources (Russian-language sites, city/Spanish sites, ticketing/experience platforms, official city/CAC APIs, and public Telegram channels via `t.me/s/` web preview) into an append-only raw layer.
- **FR-002**: System MUST normalize raw items into `events` and `places` entities, marking each raw item normalized, ignored, or error, and never deleting raw rows.
- **FR-003**: System MUST deduplicate events/places across sources, collapsing records for the same real-world entity into one while retaining links to every contributing source.
- **FR-004**: System MUST resolve conflicting attributes (notably event dates) during dedup by source weight and score, keeping the most reliable value.
- **FR-005**: System MUST score each event 0–100 to express how well it fits the family, suppressing perennial/tourist filler and elevating RU/local/family signals.
- **FR-006**: System MUST tag events and places with machine-usable labels (e.g. city, language, category, family, has-image, source-type).
- **FR-007**: System MUST geo-enrich events and places, resolving short map links and geocoding addresses/venue names into coordinates, while respecting external rate limits.
- **FR-008**: System MUST enrich cards in resilient batches (poster OCR, Russian translation, short-title/body split, clickable links) without long blocking calls, and MUST keep the base record valid if enrichment fails.
- **FR-009**: System MUST present a website with a filtered event feed, a month calendar defaulting to the current month, and a venue map, with the calendar+map above a long list.
- **FR-010**: System MUST collapse many-session venues (e.g. Hemisfèric) into one calendar card per day, color-coded and expandable to per-session times.
- **FR-011**: System MUST provide an individual detail page for every event and every place, each showing source link, tags, image (if any), and translated content when available.
- **FR-012**: System MUST produce a weekly digest (Friday ~09:00 Europe/Madrid, 2–3 week horizon) of only family-fitting events plus a "new places" block, excluding already-notified events.
- **FR-013**: System MUST record notification deliveries so events/places are not re-notified, and digest dispatch MUST be explicit (opt-in), never automatic spam.
- **FR-014**: System MUST emit a standalone rare-event alert for high-value items between weekly cycles, marked so they are not duplicated.
- **FR-015**: System MUST provide a places/restaurants catalog categorized by cuisine, district, occasion (date night / with Mark / big group / takeaway), price, and recommender, renderable independently of the events side.
- **FR-016**: System MUST run the pipeline on a schedule and render the site deterministically from the database (no live scraping/heavy enrichment at request time).
- **FR-017**: System MUST tolerate individual source failures (redirects, HTML changes, downtime) without aborting the whole run, logging each run's outcome.

### Key Entities *(include if feature involves data)*

- **Source**: A configured origin (site, API, or Telegram channel) with a weight/quality tier and enabled flag; the provenance of everything ingested.
- **Source run**: A logged execution against a source (status, item count, outcome) for observability.
- **Source item (raw)**: An append-only raw captured item before normalization, carrying original text, links, images, and a dedup hash.
- **Event**: A normalized happening with title, description, date/time, venue/location, coordinates, score, tags, translated fields, notified state, and links to contributing sources.
- **Place**: A normalized venue/restaurant with name, location/district, categories (cuisine, occasion, price), recommender(s), tags, and coordinates.
- **Media asset**: One or more images attached to an event or place.
- **Notification**: A delivery log entry tying an event/place to a digest or alert that was sent.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The home feed contains zero raw navigation/category/pagination junk items — every surfaced item is a real event or place.
- **SC-002**: The weekly digest never repeats an event that a previous digest already sent (0 duplicate notifications across runs).
- **SC-003**: Every set of source records describing the same real-world event collapses to exactly one event entry, carrying references to all its sources.
- **SC-004**: At least 80% of events that carry any location hint (address, venue name, or map link) are plotted on the map with coordinates.
- **SC-005**: The calendar opens on the current month by default, every time, regardless of the oldest data in the database.
- **SC-006**: Card enrichment completes its batch without timing out, and a failed individual enrichment leaves the corresponding event/place fully renderable.
- **SC-007**: The website renders the same result given the same database state (deterministic, no request-time scraping), and the places catalog renders even when the events pipeline has gaps.
- **SC-008**: The weekly digest, given a fixed database, selects only family-fitting events within the 2–3 week horizon above the score threshold (curation is verifiable, not arbitrary).

## Assumptions

- Audience is a small private household (the planner, partner, and child Mark); there is no multi-tenant/public-account requirement, so authentication and per-user accounts are out of scope for this feature.
- Telegram ingestion uses only public `t.me/s/<channel>` web previews (~last 20 posts); private channels and full history are out of scope unless a specific channel is later approved for a heavier path.
- The existing Node.js codebase, Postgres schema, and seed data (≈342 events, 14 places, 22 sources) are reused; this spec captures the full product so remaining work can be converged against the code.
- "Family-fitting" curation defaults to: RU standup/concerts/meetups/lectures, big city festivals/fallas, family shows, and bright gastro; small village fiestas are excluded unless notably special; SpainNewsOnline-style political news is excluded by default.
- Digest cadence defaults to weekly Friday ~09:00 Europe/Madrid with a 2–3 week look-ahead; the hosting scheduler may constrain finer cadences (see dependency below).
- Delivery channel for the digest/alerts is a single private channel the household reads (e.g. a chat/email); exact transport is an implementation choice and may start as dry-run output.

### Dependencies

- Requires a hosted Postgres database and a scheduler to run the pipeline and digest. The current hosting tier allows only one scheduled run per day; the desired 12-hour ingest plus weekly Friday digest may require a higher tier or an external scheduler — this trade-off must be surfaced during planning.
- Geo-enrichment depends on an external geocoding service subject to rate limits and acceptable-use (pacing and a real User-Agent required).
- Card enrichment depends on an external AI text/vision capability invoked in batches.
