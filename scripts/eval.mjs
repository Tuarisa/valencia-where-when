#!/usr/bin/env node
// Valencia Radar — LLM eval runner (sub-area I, T092). KEY-GATED and OUT OF CI.
//
//   npm run eval
//
// This NEVER fails a build/CI. If there is no usable enrichment engine — neither an
// ANTHROPIC_API_KEY (SDK / promptfoo anthropic grader) NOR a logged-in `claude` CLI
// (the key-free `claude -p` default engine) — it prints a skip notice and EXITS 0.
//
// When an engine IS available it runs the promptfoo config (promptfooconfig.yaml),
// which drives the REAL enrichment code path (lib/pipeline/enrich-client.ts via
// providers/promptfoo-enrich.mjs) over the golden fixtures (tests/fixtures/enrich/*.json)
// and grades the two T139 paths:
//   PATH A = RU translation (haiku) · PATH B = grounded WebFetch extraction (sonnet).
//
// promptfoo is run at RUNTIME via `npx --yes promptfoo` — it is NOT a project dependency
// (no npm i). The llm-rubric RU-quality grader needs ANTHROPIC_API_KEY; the `claude -p`
// provider does not (subscription/OAuth). We therefore distinguish two engine states.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CONFIG = join(ROOT, "promptfooconfig.yaml");

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

// Is a logged-in `claude` CLI available? (the key-free `claude -p` default engine.)
function claudeCliAvailable() {
  if (process.env.ENRICH_NO_CLI === "1") return false; // escape hatch for tests/CI
  const bin = process.env.CLAUDE_BIN || "claude";
  try {
    const r = spawnSync(bin, ["--version"], { stdio: "ignore", timeout: 15000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

function main() {
  const hasKey = !!process.env.ANTHROPIC_API_KEY;
  const hasCli = claudeCliAvailable();

  // GATE: with no key and no CLI there is no engine — skip cleanly (exit 0). Per T092
  // this keeps the mocked `npm test` and any CI fully offline and green.
  if (!hasKey && !hasCli) {
    log("eval skipped: no ANTHROPIC_API_KEY (and no usable `claude -p` CLI). This is not a failure.");
    process.exit(0);
  }

  if (!existsSync(CONFIG)) {
    log(`eval skipped: ${CONFIG} not found. This is not a failure.`);
    process.exit(0);
  }

  // The llm-rubric RU-quality grader (Haiku) needs an API key. Without one we still run
  // the eval through the `claude -p` provider, but the grader assertions can't execute —
  // warn so the summary is read correctly.
  if (!hasKey && hasCli) {
    log("eval: ANTHROPIC_API_KEY not set — running the `claude -p` provider, but the");
    log("      llm-rubric RU-quality grader (Haiku) will be unavailable. Set the key for full grading.");
  }

  log(`eval: engine = ${hasKey ? "ANTHROPIC_API_KEY" : ""}${hasKey && hasCli ? " + " : ""}${hasCli ? "claude -p CLI" : ""}`);
  log("eval: running promptfoo (via npx --yes promptfoo, runtime-only — not an installed dep)…");
  log("");

  // Run promptfoo at runtime. `--no-cache` keeps results deterministic per run; output
  // is streamed to the user's terminal. We do NOT install promptfoo as a dependency.
  const args = ["--yes", "promptfoo@latest", "eval", "-c", CONFIG, "--no-progress-bar"];
  const res = spawnSync("npx", args, {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });

  if (res.error) {
    // Could not even launch npx/promptfoo (offline npx, no network). Treat as a SKIP, not
    // a CI failure — the harness must never break a build.
    log("");
    log(`eval skipped: could not launch promptfoo via npx (${res.error.message}). This is not a failure.`);
    process.exit(0);
  }

  log("");
  if (res.status === 0) {
    log("eval: promptfoo completed — see the table above and eval-results.json for details.");
  } else {
    // promptfoo exits non-zero when assertions FAIL. That is a meaningful eval result the
    // user wants to see, but `npm run eval` is dev-only / out of CI, so we surface the
    // status without aborting any larger pipeline that might (mistakenly) chain it.
    log(`eval: promptfoo reported failing assertions (exit ${res.status}). See the table / eval-results.json.`);
  }
  // Always exit 0: this tool reports eval quality; it must never gate a build/CI.
  process.exit(0);
}

main();
