<!-- SPECKIT START -->
# Valencia Radar — agent context

**Active feature**: `001-valencia-events`
**Spec**: `specs/001-valencia-events/spec.md`
**Plan**: `specs/001-valencia-events/plan.md`
**Tasks**: `specs/001-valencia-events/tasks.md`
**Constitution**: `.specify/memory/constitution.md` (v1.0.0)

**Stack**: Next.js 14 (App Router) + React 18, Neon serverless Postgres
(`@neondatabase/serverless`), Vercel cron, TypeScript pipeline in `lib/pipeline/`.

**Pipeline**: ingest → normalize → score → tag → geo (existing in `run.ts`);
MISSING and to be built: cross-source **dedup**, batched **enrich** (`claude -p`
OCR + RU translate), **notify** (weekly digest + rare alert), full multi-source
**normalizers**, wider **geo**, **places/restaurants catalog** surface.

**Key commands**: `npm run build` (compile gate — must be green before commit),
`npm run dev`, `npm run db:setup`, `npm run pipeline:run`, `node --test tests/`.

**Non-negotiables** (see constitution): append-only raw `source_items`; dedup keeps
links to every source; enrichment is batched/fail-soft (never one long `claude -p`
call); notifications opt-in + de-duplicated; site renders deterministically from the
DB; every autonomous change builds green and commits.
<!-- SPECKIT END -->
