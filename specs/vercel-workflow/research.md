---
spec: vercel-workflow
phase: research
created: 2026-06-20T13:20:00Z
---

# Research: vercel-workflow

## Executive Summary

The Vercel Workflow SDK (npm `workflow`, `'use workflow'` / `'use step'` directives) is **real, GA, and works on Hobby** (50K events + 1GB written/month included; only Data Retained is Pro-only). It gives **durable, per-step retries + idempotency + unlimited-duration runs + `sleep`** — which genuinely escapes the 300s `maxDuration` cap and is a clean fit for the fail-soft enrichment requirement. **It does NOT add a scheduler**: a workflow is still started by code calling `start()`, so you still need a trigger (Vercel cron route or GitHub Actions) — the **Hobby 1-cron/day limit is unchanged**. Recommendation: **adopt for the pipeline + enrich + digest as durable workflows, keep the existing GH-Actions/Vercel-cron triggers** (D1 stands, lightly amended).

## Key Findings

### What the SDK is (verified)

| Fact | Value | Source |
|------|-------|--------|
| Package | `workflow` (`npm i workflow`) | vercel.com/docs/workflows |
| Status | GA, fully managed; builds on open-source SDK `workflow-sdk.dev` | vercel.com/docs/workflows |
| Core directives | `'use workflow'` (durable fn), `'use step'` (durable unit of work) | /docs/workflows/concepts |
| Trigger API | `import { start } from "workflow/api"` → `await start(fn, [args])` → `{ runId }` | workflow-sdk.dev/docs/foundations/starting-workflows |
| Sleep | `import { sleep } from "workflow"` → `await sleep('7 days')` (no compute while paused) | /docs/workflows/concepts |
| Hooks | `defineHook()` + `hook.resume()` for external events (human-in-loop) | /docs/workflows/concepts |
| Next config | wrap with `withWorkflow(nextConfig)` from `workflow/next` | workflow-sdk.dev/docs/getting-started/next |
| Local dev | runs under `next dev` (steps/sleeps work locally, no separate worker); `npx workflow web` / `npx workflow inspect runs` for observability | workflow-sdk.dev/docs/getting-started/next |
| Runtime | executes on **Vercel Functions**; orchestrated by **Vercel Queues**; **Fluid compute recommended** (cost/perf) — not strictly required | /docs/workflows, /docs/workflows/pricing |

### How steps work (the part that matters for us)

- A step = ordinary async fn with `'use step'` as its **first statement**. It compiles to an isolated API route, gets **automatic retries on throw** (transient errors), and the workflow **suspends without consuming resources** while it runs. Our existing stage fns (`ingestAll`, `normalizeAll`, …) can become steps with a one-line directive — no rewrite of bodies.
- Workflow fn must be **deterministic** (replayed from an event log on crash/deploy); all side effects/IO live **inside steps**. Inputs/outputs must be serializable.
- **Fan-out / parallel** = `await Promise.all([stepA(x), stepB(y)])` (standard async; each step is independently durable). Per-source normalizers map naturally to fan-out.
- **Per-step retry on throw** is exactly the fail-soft semantics enrichment needs (constitution IV): wrap each card's `claude -p` call as a step; a thrown error retries that item, not the whole batch.

### Pricing / plan (verified — the decisive constraint)

| Resource | Hobby included | On-demand |
|----------|----------------|-----------|
| Workflow Events | 50,000 / month | $0.02 / 1K |
| Data Written | 1 GB / month | $0.50 / GB |
| Data Retained | **not on Hobby** | $0.50 / GB-mo (Pro+) |
| Storage retention after run | Hobby **1 day**, Pro 7d, Ent 30d | — |

Run limits (all plans): **Max run duration = No limit**, **Max sleep = No limit**, steps/run 10,000, events/run 25,000, max payload 50MB. Per-step runtime = normal Vercel Functions limit. Platform **Schedules/cron: No limit** (this is the Workflows-platform line, NOT the project cron-plan limit — see below). Source: /docs/workflows/pricing.

Our scale (~342 events, ~tens of enrich items/run, 2 ingest + 1 digest/day) produces a few hundred–low-thousands of events/month → **comfortably inside the 50K free tier**. Hobby's 1-day retention only affects post-run debug log availability, not correctness.

## Decisions

### D-WF1 — Adopt Vercel Workflow for the three durable jobs
**Decision**: Re-express `runPipeline`, the (to-build) batched `enrichCards`, and the (to-build) weekly `notify`/digest as Workflow durable workflows; keep each existing stage fn as a `'use step'`.
**Rationale**: (a) escapes 300s single-invocation cap → pipeline never truncates; (b) per-step retries + idempotent replay = the fail-soft enrichment constitution IV demands, for free; (c) `sleep`/hooks available for future "wait then alert" flows; (d) GA + free on Hobby; (e) minimal/reversible — stage bodies unchanged, only directives + a trigger route change (constitution VI).
**Alternatives considered**: see Alternatives section. None beat "native to the platform we already deploy on, free on Hobby, one-line step adoption."

### D-WF2 — Keep external triggers; Workflow does NOT replace the scheduler
**Decision**: Triggering stays as today: a thin `CRON_SECRET`-protected route calls `start(workflow, [args])`. The Vercel daily cron (`15 7 * * *`) and **the GitHub Actions scheduler from spec 001 D1 remain** for the 2nd ingest + Friday digest.
**Rationale**: Verified — the SDK has **no built-in cron/schedule primitive**; workflows are started by `start()` from server code. The "Schedules/cron: No limit" line in Workflow pricing is a platform-resource note, not a relaxation of the **Hobby project-cron = 1/day** limit (that limit lives in Cron-Jobs/plan docs and is unchanged). So adopting Workflow **does not unlock more crons on Hobby**.
**Amendment to spec 001 D1**: GH Actions still drives cadence, but now POSTs to routes that call `start(...)` (fire-and-forget, returns `runId` immediately) instead of awaiting a 300s pipeline. This makes the trigger route fast and removes the 300s race entirely.
**Alternatives**: Vercel Pro (multiple crons) — still costs money, deferred; the GH-Actions trigger is unchanged in spirit.

### D-WF3 — File layout
**Decision**: `app/workflows/` for workflow fns; keep stage logic in `lib/pipeline/*` (add `'use step'` to the stage fns or thin step wrappers). Trigger routes stay under `app/api/cron/*`. Wrap `next.config.mjs` with `withWorkflow`.
**Rationale**: Matches the SDK's Next.js convention (`app/workflows/…`) and the existing repo layout; stage code stays where tests/contracts already point.

## Migration design (concrete, minimal, reversible)

### File changes
```text
next.config.mjs              EDIT  → export default withWorkflow(nextConfig)   // from "workflow/next"
package.json                 EDIT  → add dep "workflow"
app/workflows/
  pipeline.ts                NEW   → 'use workflow' refreshWorkflow()
  enrich.ts                  NEW   → 'use workflow' enrichWorkflow(limit)   (own-spec / deferred)
  digest.ts                  NEW   → 'use workflow' digestWorkflow(mode)    (own-spec / deferred)
lib/pipeline/
  ingest.ts normalize.ts score.ts tags.ts geo.ts   EDIT (1 line each) → add 'use step'
  run.ts                     KEEP for local/script path OR thin-wrap workflow (see note)
app/api/cron/
  refresh/route.ts           EDIT  → call start(refreshWorkflow) instead of awaiting runPipeline(); drop maxDuration=300
  enrich/route.ts            NEW   → start(enrichWorkflow,[limit])    (deferred to enrich spec)
  digest/route.ts            NEW   → start(digestWorkflow,[mode])     (deferred to digest spec)
vercel.json                  EDIT  → remove functions.maxDuration override (workflow steps own their own limits); keep the daily cron entry
```

### Step mapping
| Job | Workflow fn | Steps (`'use step'`) |
|-----|-------------|----------------------|
| Refresh pipeline | `refreshWorkflow()` | `ingestAll` → `normalizeAll` (fan-out per-source normalizer = `Promise.all`) → `dedup` → `scoreAll` → `tagAll` → `geoEnrich` |
| Enrich (deferred) | `enrichWorkflow(limit)` | select-batch step, then `Promise.all` of per-card `enrichOne(card)` steps — each card retries independently, fail-soft = constitution IV |
| Digest (deferred) | `digestWorkflow(mode)` | `selectCandidates` → `buildDigest` → `send` → `markNotified` (optionally `sleep` between alert windows) |

### Trigger wiring (verified pattern)
```typescript
// app/api/cron/refresh/route.ts
import { start } from "workflow/api";
import { refreshWorkflow } from "@/app/workflows/pipeline";

export async function GET(req: Request) {
  // existing CRON_SECRET bearer check ...
  const run = await start(refreshWorkflow, []);   // returns fast
  return Response.json({ ok: true, runId: run.runId });
}
```
```typescript
// app/workflows/pipeline.ts
export async function refreshWorkflow() {
  'use workflow';
  await ingestAll();
  await normalizeAll();
  await dedup();
  await scoreAll();
  await tagAll();
  await geoEnrich(30);
  return { ok: true };
}
```
Note on `run.ts`: keep `runPipeline()` as-is for the **local `scripts/run-pipeline.mjs`** path (ties to `local-run` spec — workflows run under `next dev`, but the standalone `.mjs` script does not). The workflow fn becomes the *deploy* entry; `run.ts` stays the *script* entry. Both reuse the same stage fns.

## What it solves vs. does NOT solve

**Solves**
- 300s cap on the pipeline → **gone** (unlimited run duration; each stage is its own function invocation).
- Fail-soft enrichment (IV) → **native** per-step retries + idempotent replay; one bad card no longer aborts the batch.
- Crash/deploy resilience, observability (dashboard run traces), `sleep`/hooks for future alert timing.
- Fast trigger routes (fire-and-forget `start()`), removing the GH-Actions ↔ 300s race.

**Does NOT solve**
- **Hobby 1-cron/day limit — UNCHANGED.** Workflow has no scheduler; you still need Vercel cron and/or GH Actions to *trigger* `start()`. Spec 001 D1's GH-Actions scheduler is still required.
- Cost of the underlying `claude -p`/Function compute is unchanged (Workflow bills events/data on top, but our volume is inside the free tier).
- The standalone `.mjs` local pipeline script is outside Workflow (runs under `next dev` only) — relevant to `local-run`.

## Fit with other specs

| Spec | Relation | mayNeedUpdate |
|------|----------|---------------|
| 001-valencia-events | **High** — supersedes plan.md/research.md **D1 mechanism detail**: triggers now call `start()` and the pipeline moves into a workflow. Adopting Workflow is a Technology-constraint change → **constitution amendment** (stack is "fixed" per the constitution; adding Workflow SDK requires it). | **Yes** |
| local-run | **High** — local Workflow runs under `next dev` inside the Docker "as-if-Vercel" container; the offline `.mjs` `pipeline:run` path stays separate. local-run must verify `withWorkflow` + `start()` work in the container and that `npx workflow web` is reachable. | **Yes** |
| llm-testing | **Medium** — enrichment becomes per-card workflow **steps**; the SDK-based `enrich({client})` mockable design still holds (step body is the same fn). Test the step fn directly; workflow orchestration is integration-tested. | Maybe (test harness wraps step fn, not workflow) |
| enrich / digest (deferred own-specs) | **High** — these are exactly the `enrichWorkflow` / `digestWorkflow` above; they should be authored as workflows from the start. | n/a (not yet created) |

## Alternatives considered

| Option | Why-not (vs Vercel Workflow) |
|--------|------------------------------|
| **Keep Vercel cron + GH Actions only** (status quo, spec 001) | No durability/retries; pipeline still bound by 300s; enrichment fail-soft must be hand-rolled. *Still needed as the trigger layer regardless.* |
| **Inngest** | Mature durable-step SDK, great DX, **has built-in cron** (would replace GH Actions). But: 3rd-party account, separate billing, extra infra; not native to the Vercel deploy. Heavier than the goal warrants. |
| **Trigger.dev** | Similar to Inngest (self-host or cloud, built-in schedules). Same "extra platform" objection; more setup. |
| **Upstash QStash / Workflow** | QStash gives durable HTTP-callback steps **+ schedules** cheaply; good fit for serverless. But another vendor + token, and less integrated than first-party Workflow now that it's GA on Hobby. |

Recommendation: **Vercel Workflow** for durability (native, free on Hobby, one-line step adoption) **+ keep GH Actions purely as the cron trigger**. If multi-cron scheduling later becomes the pain point, reconsider Inngest/QStash (they'd subsume the trigger too) — but that's a scheduling problem Workflow doesn't claim to solve.

## Quality Commands

| Type | Command | Source |
|------|---------|--------|
| Lint | `npm run lint` (`next lint`) | package.json scripts.lint |
| TypeCheck / compile gate | `npm run build` (`next build`) | package.json scripts.build; constitution VI |
| Unit Test | `npm test` (`node --test tests/**/*.test.mjs`) | package.json scripts.test |
| Integration / dry-run | `npm run pipeline:run` (`node scripts/run-pipeline.mjs`) | package.json scripts |
| Build | `npm run build` | package.json scripts.build |
| E2E | Not found | — |

**Local CI**: `npm run lint && npm run build && npm test`

## Verification Tooling

| Tool | Command | Detected From |
|------|---------|---------------|
| Dev Server | `npm run dev` (`next dev`) | package.json scripts.dev |
| Workflow local run | runs under `next dev`; inspect via `npx workflow web` / `npx workflow inspect runs` | workflow-sdk.dev (Next.js guide) |
| Browser Automation | none | — |
| E2E Config | none | — |
| Port | 3000 (Next default; not pinned in env/scripts) | next defaults |
| Health/trigger endpoint | `GET /api/cron/refresh` (CRON_SECRET-gated) → after migration returns `{ runId }` | app/api/cron/refresh/route.ts |
| Docker | planned via `local-run` spec (not yet in repo) | local-run/.progress.md |

**Project Type**: Web app (Next.js 14 App Router) + internal pipeline library + cron-driven jobs.
**Verification Strategy**: `npm run build` (type/compile gate, constitution VI) → start `next dev` → POST trigger route with `CRON_SECRET` → assert `start()` returns a `runId` and steps execute in dashboard / `npx workflow inspect runs` → confirm DB mutated (events/places). For enrich/digest, dry-run flags as in contracts.

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Constitution says stack is "fixed"; adding Workflow SDK is a stack change | Med | Requires a constitution amendment (Technology Constraints) before/with adoption — surface in requirements. |
| Determinism rule: workflow fn body must be deterministic (no IO outside steps) | Med | Keep ALL IO inside `'use step'` fns; workflow fn only orchestrates. Audit `run.ts` → no `Date.now()`/random in the workflow body. |
| `'use step'` first-statement constraint + serializable args/returns | Low | Stage fns already take/return plain objects; verify no class instances cross step boundaries. |
| Hobby 1-day run-log retention | Low | Debug logs only; correctness unaffected. Persist run summaries to DB if needed. |
| Local Workflow needs `next dev` (not the offline `.mjs` script) | Med | Coordinate with `local-run`: keep `pipeline:run` script path for offline; workflow path needs the dev server + Docker parity. |
| Workflow billing events on top of compute | Low | Volume well inside 50K free events/mo; monitor in dashboard. |
| `claude -p` as a step: long calls may exceed Function limit per step | Med | Per-card step (one `claude -p` per item) keeps each step short — matches constitution IV; this is *better* than today. |

## Feasibility / Risk / Effort

- **Feasibility: High** — GA, free on Hobby, native to Vercel, one-line step adoption, stage bodies reusable.
- **Risk: Medium** — constitution amendment needed; determinism discipline; ties to `local-run` for local execution.
- **Effort: M** — pipeline migration is S–M (directives + 1 workflow fn + 1 trigger edit + `withWorkflow`); enrich/digest as workflows are separate (deferred) specs.

## Open Questions (for requirements)

1. **Scope**: Migrate ONLY the existing `refresh` pipeline now, or also stub `enrichWorkflow`/`digestWorkflow` (their own deferred specs build the bodies)? Recommend: migrate refresh now; design enrich/digest as workflows when those specs land.
2. **Constitution amendment**: OK to add "Vercel Workflow SDK" to the fixed-stack list (MINOR bump)? This is required before adoption.
3. **Keep `runPipeline()`/`scripts/run-pipeline.mjs`** as the offline/local path alongside the workflow (yes, recommended — ties to `local-run`), or fully replace it?
4. **Fan-out normalizers**: turn the per-source normalizers into parallel steps now, or keep `normalizeAll` as one step initially (simpler) and fan out later?
5. **Trigger semantics**: confirm fire-and-forget (`start()` returns `runId`, GH Action doesn't await completion) is acceptable for the digest/alert flows (no synchronous result to the trigger).
6. **Plan**: stay on Hobby (1-day retention, 1 cron/day + GH Actions)? Or is Pro on the table (7-day retention, multiple native crons — would let Workflow triggers be Vercel crons and retire GH Actions)?

## Sources
- https://vercel.com/docs/workflows (overview, package, GA, Functions+Queues, observability)
- https://vercel.com/docs/workflows/concepts ('use workflow'/'use step', sleep, hooks, determinism)
- https://vercel.com/docs/workflows/pricing (Hobby allowances, limits, retention, "Schedules/cron: No limit" platform note)
- https://vercel.com/docs/workflows/python (parity: @wf.workflow/@wf.step/sleep)
- https://workflow-sdk.dev/docs/foundations/starting-workflows (`start()` from `workflow/api`, runId)
- https://workflow-sdk.dev/docs/getting-started/next (`withWorkflow`, local dev under `next dev`, no built-in cron)
- vercel.com/docs/cron-jobs (Hobby project-cron limit unchanged; CRON_SECRET pattern)
- specs/001-valencia-events/{plan.md, research.md (D1), contracts/pipeline-and-endpoints.md}
- .specify/memory/constitution.md (principles IV/V/VI; "stack is fixed")
- lib/pipeline/run.ts, app/api/cron/refresh/route.ts, vercel.json, package.json, next.config.mjs
- specs/local-run/.progress.md, specs/llm-testing/.progress.md
