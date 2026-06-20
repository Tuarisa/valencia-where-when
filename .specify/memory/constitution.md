<!--
Sync Impact Report
- Version change: (template) → 1.0.0
- Ratification: initial adoption 2026-06-20
- Modified principles: none (initial authoring)
- Added principles:
  - I. Data Integrity First
  - II. Curation Over Volume
  - III. Two Independent Outputs
  - IV. Batched, Resilient Enrichment
  - V. Static-First, Cron-Driven
  - VI. Reversible Automation
- Added sections: Technology & Data Constraints; Development Workflow & Quality Gates
- Removed sections: none
- Templates requiring updates:
  - ✅ .specify/templates/plan-template.md (Constitution Check is generic; principles map cleanly — no edit required)
  - ✅ .specify/templates/spec-template.md (no mandatory-section change introduced)
  - ✅ .specify/templates/tasks-template.md (task categories compatible — no edit required)
- Deferred TODOs: none
-->

# Valencia Radar Constitution

Valencia Radar is a personal events + places notifier and website for a
Russian-speaking expat family in Valencia, Spain. Stack: Next.js 14 (App Router),
Neon serverless Postgres, Vercel cron, and a TypeScript ingestion pipeline in
`lib/pipeline/`.

## Core Principles

### I. Data Integrity First
Raw ingest MUST be append-only: rows in `source_items` are never mutated in place
or deleted by downstream stages. Normalization and deduplication MUST NOT destroy
source rows — they derive `events`/`places` from raw data and may mark raw rows
(`normalized` / `ignored` / `error`) but always preserve them. When dedup merges
records, conflicts (e.g. divergent dates for the same concert) MUST resolve by
source weight + score, and the surviving entity MUST retain a link to every
contributing source. Rationale: source data is the ground truth and the only way
to audit, re-normalize, or recover from a bad extractor; losing it is
irreversible.

### II. Curation Over Volume
The product MUST surface only what fits the family — Russian-speaking and
family-friendly: RU standup, expat meetups, concerts, lectures, city
festivals/fallas, family shows, and bright gastro — not everything scraped.
Scoring and filtering are first-class concerns implemented as explicit, testable
pipeline stages, never afterthoughts bolted onto rendering. A change that
increases collected volume without improving what reaches the user is out of
scope. Rationale: the value is a trustworthy short list, not an exhaustive feed.

### III. Two Independent Outputs
The system MUST maintain two outputs that share one database but never block each
other: (a) an events afisha (feed + calendar + map + per-entity pages), and
(b) a places/restaurants catalog (categorized by cuisine, district, occasion,
price, who recommended). A failure or gap in one output MUST NOT prevent the
other from building or shipping. Rationale: events and places have different
cadences and data shapes; coupling them creates fragility.

### IV. Batched, Resilient Enrichment
`claude -p` enrichment (poster OCR, Russian translation, title/body split) MUST
run in background or cron batches, never as a single long blocking call —
prior single calls hit 180s/60s CLI timeouts. Enrichment MUST be incremental and
idempotent, and a failed or partial enrichment MUST NEVER corrupt the base record
(the un-enriched event/place remains valid and renderable). Rationale: enrichment
is best-effort decoration on top of already-valid data; it must fail soft.

### V. Static-First, Cron-Driven
The site MUST read from the database and render deterministically; it MUST NOT
perform live scraping or heavy enrichment at request time. The pipeline
(ingest → normalize → dedup → score → tag → geo → enrich) runs on a schedule.
Notifications MUST be opt-in and explicit (digest dispatch is a deliberate action
with `mark notified` bookkeeping) and MUST NEVER auto-spam. Rationale: predictable
reads, cheap hosting, and no surprise outbound messages.

### VI. Reversible Automation
Every autonomous (Ralph) iteration MUST leave the tree green: `npm run build` MUST
pass and the change MUST be committed before the task is considered done. No task
may land in a red/broken state. Schema-affecting changes MUST be expressed as
migrations against `db/schema.sql`, not ad-hoc manual edits. Rationale: autonomous
loops are only safe when every step is individually verifiable and revertible via
git history.

## Technology & Data Constraints

- **Stack is fixed**: Next.js 14 App Router + React 18, Neon serverless Postgres
  via `@neondatabase/serverless`, TypeScript pipeline in `lib/pipeline/`, deployed
  on Vercel with cron. Changing a core technology requires a constitution
  amendment.
- **Telegram sources** are read via public `t.me/s/<channel>` web preview only —
  no login, no bot subscription, no MTProto user session unless a specifically
  required channel is private (which requires explicit approval).
- **External politeness**: geocoding (Nominatim) MUST keep its rate-limit pause
  (~1.1s) and a real User-Agent. Scrapers MUST tolerate source HTML/redirect
  changes (e.g. 308) without crashing the whole run.
- **Cron cadence reality**: Vercel Hobby runs cron once per day. Desired 12h
  ingest + weekly Friday digest may require a paid plan or an external scheduler;
  this trade-off MUST be surfaced in any plan that depends on it.
- **Secrets** (`DATABASE_URL`, `CRON_SECRET`) live in env vars, never committed.

## Development Workflow & Quality Gates

- **Build gate**: `npm run build` MUST pass before any commit on `main`.
- **Schema changes** go through `db/schema.sql` + `scripts/apply-schema.mjs`; seed
  data via `scripts/seed.mjs`. Pipeline changes are validated with
  `npm run pipeline:run` against a database before merge where feasible.
- **One task per iteration**: autonomous work picks a single task from `tasks.md`
  / `WORKBOARD.md`, implements, builds, and commits with a descriptive message.
- **Source of truth**: `specs/001-valencia-events/spec.md` is authoritative for
  product intent; `WORKBOARD.md` tracks operational backlog; this constitution
  governs how work is done.

## Governance

This constitution supersedes ad-hoc practice. Amendments MUST be made by editing
this file, bumping the version per semantic versioning, and recording the change
in the Sync Impact Report comment at the top:
- **MAJOR**: removal or backward-incompatible redefinition of a principle.
- **MINOR**: a new principle/section or materially expanded guidance.
- **PATCH**: clarifications, wording, or non-semantic refinements.

All plans and specs MUST pass a Constitution Check against these principles before
implementation. Complexity that violates a principle MUST be justified in writing
or rejected. Runtime development guidance for agents lives in `CLAUDE.md`.

**Version**: 1.0.0 | **Ratified**: 2026-06-20 | **Last Amended**: 2026-06-20
