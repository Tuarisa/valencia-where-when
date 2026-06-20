---
spec: llm-testing
phase: research
created: 2026-06-20T13:10:00Z
provider: Anthropic / Claude (claude-opus-4-8, claude-haiku-4-5, etc.)
---

# Research: llm-testing

## Executive Summary

Adopt **promptfoo** as the primary LLM eval tool (golden fixtures → assertions:
JSON-schema validity, fuzzy date/venue match, **llm-rubric** for RU-translation
quality) wrapping the enrichment call, **plus the existing `node:test` harness** for
fast offline unit tests with a **mocked LLM**. For schema-constrained output, move
enrichment to the **Anthropic TypeScript SDK (`@anthropic-ai/sdk`)** using
`messages.parse()` + `output_config.format` (**constrained decoding — guaranteed
schema**, GA, no beta header) — strictly better than the `claude -p --json-schema`
CLI, whose schema check is **post-hoc validation, not constrained generation**. The
SDK also makes the call mockable for unit tests (the CLI does not). Enrichment
(`lib/pipeline/enrich.ts`, T043) is **not built yet** — adopt the SDK at build time.

## Key Findings

| # | Finding | Evidence |
|---|---------|----------|
| 1 | **Enrichment not built.** `lib/pipeline/enrich.ts`, `notify.ts`, `/api/cron/enrich` do not exist; no `claude -p` / `@anthropic-ai/sdk` usage anywhere in repo. This spec can pick the mechanism cleanly. | `ls lib/pipeline/` (no enrich/notify); `grep` for `claude -p`/SDK → empty; 001 plan.md T043, contracts §enrich |
| 2 | Target enrichment schema (per 001 plan/data-model): `{title_ru, description_ru, start_date, end_date, venue_name, address, links[]}` + OCR text + short headline split. Writes `title_ru, description_ru, links_json, enrichment_json, enriched_at`; **fail-soft per item** (constitution IV). | data-model.md "Enrichment state"; contracts `enrichCards(limit,{dry})`; research D3 |
| 3 | **CLI already supports structured output.** `claude` v2.1.177 on PATH exposes `--json-schema <schema>`, `--output-format json\|stream-json`, `--model`, `--fallback-model`, `--append-system-prompt`, `--bare`. | `claude -p --help` (local) |
| 4 | **BUT CLI `--json-schema` is post-hoc validation**, not constrained decoding: "Schema validation happens *after* Claude finishes. It's not constrained generation during inference." Result lands in `.structured_output`. | code.claude.com/docs/en/headless; GitHub issue #9058 |
| 5 | **SDK structured outputs = constrained decoding (grammar-level guarantee), GA, no beta header.** `messages.parse()` (Zod/`zodOutputFormat`) or `output_config:{format:{type:"json_schema",schema}}`. Supported on Opus 4.8 / Sonnet 4.6 / Haiku 4.5 (+ legacy). | platform.claude.com structured-outputs.md (GA); claude-api skill §Structured Outputs |
| 6 | **JSON-schema limits (both SDK + tool use):** no `minimum/maximum`, `minLength/maxLength`, no recursive schemas; `additionalProperties:false` required on every object. TS/Python SDK auto-strip unsupported keywords and validate client-side. → date/length bounds must be validated in test assertions, not the schema. | structured-outputs.md "Not Supported"; claude-api skill |
| 7 | **promptfoo**: Anthropic provider id `anthropic:messages:claude-opus-4-8`; assertions `is-json`, `contains`, `javascript`, `llm-rubric`, `factuality`. `llm-rubric`/`factuality` **auto-use Anthropic as grader when `ANTHROPIC_API_KEY` set & no `OPENAI_API_KEY`** (or Claude Code CLI creds). | promptfoo.dev/docs/providers/anthropic |
| 8 | **promptfoo can wrap the `claude` CLI** via a custom-script provider (`exec:./providers/claude-cli.sh` or a `.cjs` calling `execFileSync(claude,["--print",...])`) — confirmed community pattern. So we can eval the *exact* enrichment call (SDK fn or CLI) rather than re-implement it. | promptfoo.dev/docs/providers/custom-script; paperclipai issue #2091 |
| 9 | **deepeval** (pytest-style, Python) supports Anthropic grader via `AnthropicModel`; `GEval` = LLM-as-judge on custom criteria. Strong, but **Python** — mismatch with the Node/TS stack (would add a second toolchain). | deepeval.com/integrations/models/anthropic; /docs/metrics-llm-evals |
| 10 | **Braintrust**: hosted eval platform (`Eval()`, `autoevals` incl. LLM-judge), Anthropic-compatible; powerful but **SaaS + account + cost**, overkill for a single-household app. | (general knowledge; not load-bearing — deferred) |
| 11 | **Repo test baseline**: `node:test` only (`node --test tests/**/*.test.mjs`), 3 `.mjs` tests. Pattern = **pure-logic `.mjs` mirrors** of TS modules + **injectable `exec`** (see `dedup({exec})`) so tests run DB-free, no import-time side effects. **No test framework, no `.github/workflows`, no Makefile.** | package.json; `tests/dedup.test.mjs` (mirror pattern); `dedup.ts:249` `dedup({exec=sql})` |
| 12 | **Auth caveat for CI/tests.** `claude` CLI auth = OAuth/keychain **or** `ANTHROPIC_API_KEY`; `--bare` skips OAuth/keychain so needs `ANTHROPIC_API_KEY`. SDK needs `ANTHROPIC_API_KEY`. promptfoo `llm-rubric` needs the same. → live eval runs are **cost-gated + key-gated**; default unit tests must **mock the LLM** (no key, no network, deterministic). | code.claude.com/docs/en/headless (bare auth); local env has no `ANTHROPIC_API_KEY` |
| 13 | **No temperature knob on Opus 4.8 / Haiku-via-SDK structured path**: Opus 4.8/4.7 reject `temperature` (400); determinism comes from constrained decoding + low `effort`, not `temperature:0`. (CLI doesn't expose temperature either.) | claude-api skill (sampling params removed on 4.7/4.8) |

## Three Decisions

### Decision A — Structured-output mechanism: **SDK `messages.parse()` + `output_config.format` (constrained decoding)**

Use the Anthropic TS SDK's constrained-decoding structured output for the enrichment
call. Define the extraction schema once (Zod → `zodOutputFormat`, or raw
`output_config:{format:{type:"json_schema",schema}}`), get a **guaranteed** JSON
object back (`response.parsed_output`), no parse-retry loop.

- **Rationale**: Grammar-level guarantee at inference time (Finding 5) beats the
  CLI's after-the-fact validation (Finding 4). GA, no beta header. Removes the
  "model returned prose around the JSON" failure class that a hand-rolled
  `claude -p` prompt is prone to — exactly the fragility constitution IV warns about.
- **Schema shape** (objects need `additionalProperties:false`; bounds go in tests not schema — Finding 6):
  ```jsonc
  { "type":"object","additionalProperties":false,
    "required":["title_ru","description_ru","start_date","venue_name","links"],
    "properties":{
      "title_ru":{"type":"string"},
      "description_ru":{"type":"string"},
      "start_date":{"type":"string","format":"date"},      // "YYYY-MM-DD"
      "end_date":{"type":["string","null"],"format":"date"},
      "venue_name":{"type":["string","null"]},
      "address":{"type":["string","null"]},
      "links":{"type":"array","items":{"type":"string","format":"uri"}},
      "ocr_text":{"type":["string","null"]} } }
  ```
- **Alternatives considered**:
  - *Tool use / `input_schema` (`strict:true`)*: also constrained, but a tool-call
    wrapper is indirection vs. a direct typed response; `output_config.format` is the
    purpose-built path for "return this shape." Use `strict` tools only if enrichment
    later needs the model to *act* (call a real tool), not just extract.
  - *`claude -p --json-schema`*: post-hoc validation only (Finding 4); on a malformed
    answer it returns `is_error`, not a corrected object — you'd reintroduce a retry
    loop. Keep as a **fallback** if SDK adoption is deferred.

### Decision B — CLI vs SDK: **migrate enrichment to `@anthropic-ai/sdk`**

Build `lib/pipeline/enrich.ts` (T043) on the Anthropic TS SDK, **not** `claude -p`.

- **Rationale**:
  1. **Schema guarantee** — only the SDK gives constrained decoding (Decision A).
  2. **Testability/mocking** — the SDK is an injectable async function; unit tests
     mock it (mirrors the existing `dedup({exec})` injection pattern, Finding 11) for
     fast, offline, deterministic runs. A spawned `claude -p` subprocess is far
     harder to mock and ties tests to a CLI binary + auth state (Finding 12).
  3. **Cost/model control** — pick `claude-haiku-4-5` (cheap, fast) for enrichment
     and graders explicitly; per-call `usage` for spend tracking; per-item `try/catch`
     stays inside one TS module (fail-soft, constitution IV) with no process-exit
     semantics to interpret.
  4. **Constitution IV fit** — batched, per-item, short calls, fail-soft: the SDK's
     per-call boundary maps 1:1 to "one item, one call, catch, continue." Streaming
     available if a poster OCR call ever runs long (avoids the 180s/60s timeouts that
     killed the old single big call — research D3).
- **Migration impact on T043** (small, since nothing is built):
  - Add dep `@anthropic-ai/sdk`; add `ANTHROPIC_API_KEY` to `.env.example`/secrets.
  - `enrich.ts` exports `enrichEvent(event, { client })` (injectable client, default
    `new Anthropic()`) + `enrichCards(limit,{dry,exec,client})` orchestrator —
    mirrors `dedup`'s injectable shape so it's unit-testable with a stub client.
  - `/api/cron/enrich` route just calls `enrichCards`. No change to dedup/score/tags.
  - Image/poster OCR: pass the poster as an `image` content block (URL or base64) in
    the same `messages.parse()` call — one call does OCR + RU translate + extract.
- **Alternatives considered**: *stay on `claude -p`* — already proven on the machine
  (v2.1.177, used by `local-run`) and needs no API key when OAuth'd, but loses the
  schema guarantee and mockability; keep it as the documented fallback for an
  offline/no-key local run, behind the same `enrichEvent` interface.

### Decision C — Eval tool: **promptfoo (primary) + `node:test` mocked units (secondary)**

- **promptfoo** for input→output enrichment eval against a **golden/fixture set**
  (post/poster → expected fields). One `promptfooconfig.yaml` per fixture set; the
  *provider* is a thin custom script that calls the real `enrichEvent` (or the
  `claude` CLI) so the eval tests the actual pipeline call. Assertions:
  - `is-json` + a `javascript` assert running **JSON-schema validation** (Ajv) →
    schema-validity pass/fail.
  - `javascript` asserts for **fuzzy date match** (parse → compare within ±0 days for
    `start_date`; the date-recognition metric) and **venue/place match**
    (normalized/`slugify` contains, Levenshtein ratio ≥ threshold).
  - `llm-rubric` for **RU translation quality** (LLM-as-judge), grader =
    `claude-haiku-4-5` (cheap), auto-selected when `ANTHROPIC_API_KEY` set (Finding 7).
  - Run **gated**: `npm run eval` (not in default `npm test`), key-gated + cost-gated.
- **`node:test`** stays the fast inner loop: pure-logic units (date parser, venue
  normalizer, link extractor, schema-shape assertions) + an **enrichment unit with a
  mocked SDK client** (fixture in → stubbed model JSON out → assert mapping to DB
  fields + fail-soft on a thrown stub). Zero network, zero key, deterministic — runs
  in `npm test` / CI.
- **Rationale**: promptfoo is Node/TS-native (Finding 7-8), first-class Anthropic
  grader + matrix fixtures + the assertion types this spec names, and can wrap the
  exact call. `node:test` is already the repo standard (Finding 11) — no new toolchain
  for the deterministic layer. Two layers = fast offline correctness (mocked) +
  periodic real-quality eval (live, cost-gated).
- **Alternatives considered**:
  - *deepeval*: great pytest-style + `GEval` judge, **but Python** (Finding 9) — adds a
    second toolchain to a TS repo. Reconsider only if a Python eval env already exists.
  - *Braintrust*: powerful hosted evals, but **SaaS + account + recurring cost**
    (Finding 10) — disproportionate for a single-household app (matches research D5's
    "lightweight, zero/few new deps" stance).
  - *`node:test` only (no promptfoo)*: viable and zero-dep, but you'd hand-roll
    fixture matrices, an LLM-judge harness, and reporting that promptfoo gives free —
    worth it only if avoiding any new dev dep is a hard requirement.

## Proposed Test / Eval Design

### Fixtures / golden set
- `tests/fixtures/enrich/*.json`: each = `{ input: {raw_text, image_url?, source}, expected: {title_ru, description_ru, start_date, end_date?, venue_name?, address?, links[]} }`.
- Seed from **real backlog cases** (the Слава Комиссаренко 3-source/conflicting-date
  case already in `dedup.test.mjs`; RU Telegram posts; an ES poster-image case for OCR).
- Keep small (10–25 cases) — single-household scale (research D5).

### Assertion layers
| Layer | Tool | Assertion | Metric |
|-------|------|-----------|--------|
| Schema validity | node:test + promptfoo `is-json`/Ajv | output matches enrichment schema | pass/fail (must be 100%) |
| Date recognition | node:test + promptfoo `javascript` | parsed `start_date`==expected (±0d); `end_date` window | precision/recall on date field |
| Place/venue recognition | promptfoo `javascript` | normalized venue/address fuzzy-match ≥ ratio | precision/recall on venue field |
| RU translation quality | promptfoo `llm-rubric` (grader = Haiku) | "accurate, natural Russian, preserves dates/names" | judge score 0–1, threshold (e.g. ≥0.7) |
| Fail-soft | node:test (mocked client throws) | item skipped, base record valid, `errors++` | pass/fail |

### Offline (mocked) vs live (eval) split
- **Offline / `npm test` (CI default)**: mock the SDK client → fixed JSON; assert
  field-mapping, schema shape, date/venue parsers, fail-soft. No key, no network,
  deterministic. This is the bug-catching layer.
- **Live / `npm run eval` (manual / gated cron)**: real `enrichEvent` over fixtures
  via promptfoo; **cheap grader (`claude-haiku-4-5`)**; key-gated (`ANTHROPIC_API_KEY`)
  + cost-gated (skip if unset). Determinism: no `temperature` knob on 4.7/4.8
  (Finding 13) — rely on constrained decoding + low `effort`; accept small variance,
  hence threshold-based (not exact) judge asserts.

### CI / cost
- `npm test` (node:test, mocked) in CI — free, fast, no secrets.
- `npm run eval` (promptfoo) **excluded from CI default**; run on demand or a separate
  key-gated workflow. (Repo currently has **no `.github/workflows`** — Finding 11; the
  001 plan adds a scheduler workflow, so an eval workflow can ride alongside, secret-gated.)

## Coexistence with constitution & local-run
- **Constitution IV (fail-soft, batched, no long blocking call)**: tests *assert* it
  (mocked-throw fail-soft case; per-item boundary). Eval must not run inside the hot
  pipeline — it's a separate `npm run eval`, like enrichment is a separate cron stage.
- **local-run spec**: enrichment there can use the `claude -p` fallback (no key, OAuth)
  behind the same `enrichEvent` interface; offline `npm test` needs neither key nor
  network, so it runs fully offline (local-run's offline tier). Live eval is the only
  part needing network/key — document it as such (mirrors local-run's "needs network"
  table).

## Related Specs
| Spec | Relation | mayNeedUpdate |
|------|----------|:---:|
| `001-valencia-events` | **High** — owns `enrich.ts` (T043), the enrichment schema, contracts, constitution IV. This spec picks the mechanism (SDK + structured output) and adds the eval/test layer. T043 should be built on the SDK per Decision B. | **yes** (T043 acceptance + a new `@anthropic-ai/sdk` dep; add eval tasks) |
| `local-run` | **Medium** — wants `claude -p` enrichment runnable locally; this spec recommends SDK primary + `claude -p` fallback. Offline `npm test` (mocked) fits local-run's offline tier; live eval needs key+network. | **maybe** (note SDK path + key requirement; keep CLI fallback) |

## Risks
| Risk | Likelihood | Impact | Mitigation |
|------|:---:|:---:|------|
| Live eval cost / key in CI | Med | Med | Default `npm test` mocked & free; `npm run eval` key-gated + Haiku grader; skip when no key |
| LLM-judge non-determinism (RU quality) | Med | Low | Threshold (not exact) asserts; pin grader model+prompt; small fixture set |
| New dep weight (`@anthropic-ai/sdk`, `promptfoo`) vs "lightweight" (D5) | Low | Low | SDK is one runtime dep; promptfoo is a dev-only dep run on demand, not in build/CI |
| Schema can't encode date/length bounds (Finding 6) | Low | Low | Validate bounds in test assertions (Ajv + date parser), not in the model schema |
| CLI vs SDK auth drift between local-run and CI | Med | Low | Single `enrichEvent` interface; SDK=key, CLI fallback=OAuth; documented per env |

## Feasibility / Risk / Effort

- **Feasibility: High** — enrichment unbuilt (clean slate); CLI already does schema
  output, SDK does it better; promptfoo + node:test both fit the stack.
- **Risk: Low–Medium** — main risks are live-eval cost/key handling and judge variance,
  both mitigated by the mocked-default + gated-live split.
- **Effort: M** — add `@anthropic-ai/sdk` + build `enrich.ts` on it with injectable
  client (T043, already planned); add `promptfoo` dev dep + one `promptfooconfig.yaml`
  + a thin provider wrapping `enrichEvent`; author 10–25 fixtures; add mocked
  `enrich` unit + date/venue parser units; add `npm run eval` (key-gated). (XL only if
  fixtures must be hand-curated from scratch at scale — not needed here.)

## Sources
- platform.claude.com `build-with-claude/structured-outputs.md` (GA, constrained decoding, schema limits, models)
- code.claude.com `/docs/en/headless` (`-p`, `--output-format json`, `--json-schema` = post-hoc, `--bare` auth, response shape)
- `claude -p --help` (local CLI v2.1.177: `--json-schema`, `--output-format`, `--model`, `--fallback-model`)
- promptfoo.dev `/docs/providers/anthropic` (provider id, assertions, `llm-rubric` auto-Anthropic grader)
- promptfoo.dev `/docs/providers/custom-script` + paperclipai issue #2091 (wrap `claude` CLI as exec provider)
- deepeval.com `/integrations/models/anthropic`, `/docs/metrics-llm-evals` (AnthropicModel, GEval — Python)
- GitHub `anthropics/claude-code` issue #9058 (CLI schema = validation, not constrained generation)
- claude-api skill: §Structured Outputs, §Tool Use, model table (Opus 4.8 / Haiku 4.5), sampling-param removal
- Repo: `lib/pipeline/dedup.ts` (injectable `exec` pattern), `tests/dedup.test.mjs` (mirror pattern), `tests/normalize-registry.test.mjs`, `package.json`, `tsconfig.json`
- 001 spec: `research.md` D3/D5, `plan.md`, `contracts/pipeline-and-endpoints.md`, `data-model.md`
- `local-run/research.md` (claude CLI present, offline/network split, no key in env)

## Open Questions
- Is `ANTHROPIC_API_KEY` available for live eval, or must everything stay OAuth/CLI?
  (No `ANTHROPIC_API_KEY` in the current shell — confirm before sizing live-eval tasks.)
- Acceptable per-eval spend ceiling? (Drives fixture count + grader model = Haiku.)
- Should T043 (`enrich.ts`) be (a) built on the SDK by this spec, or (b) this spec only
  adds the eval layer and 001 builds `enrich.ts`? Decision B assumes the SDK at build time.
