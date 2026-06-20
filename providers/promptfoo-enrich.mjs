// Promptfoo custom provider (sub-area I, T090). Calls the REAL production enrichment
// code path — lib/pipeline/enrich-client.ts (`claude -p`, key-free) — so the eval
// grades what ships, not a re-implementation.
//
// Promptfoo loads this file directly (no bundler), and the enrich client is
// TypeScript. Rather than depend on a tsx loader being registered inside the npx
// promptfoo process, we shell out to a tiny `node --import tsx` subprocess
// (scripts/eval-enrich-one.mjs) that imports the .ts client and runs ONE enrich call,
// printing the enrichment JSON to stdout. That subprocess is the thing actually
// exercising the production prompt + model tiering + WebFetch flag.
//
// Contract (promptfoo provider API): export default an object with `id` and
//   async callApi(prompt, context) -> { output } | { error }
// The `prompt` is the JSON-encoded card (see promptfooconfig.yaml prompts:). We also
// read context.vars.path (A | B | series) to drive web grounding (PATH B → web=true).

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const RUNNER = join(ROOT, "scripts", "eval-enrich-one.mjs");

function parseCard(prompt) {
  // prompt is "{{card}}" rendered → the JSON string of the fixture's `input`.
  if (typeof prompt !== "string") return prompt && typeof prompt === "object" ? prompt : {};
  try {
    return JSON.parse(prompt);
  } catch {
    // Fall back: treat the raw string as a description-only card.
    return { description: prompt };
  }
}

const provider = {
  id: () => "claude-p-enrich",

  async callApi(prompt, context) {
    const card = parseCard(prompt);
    const vars = (context && context.vars) || {};
    // PATH B = grounded WebFetch extraction (web=true → sonnet + --allowedTools WebFetch
    // inside the client). PATH A / series = translation-only (web=false → haiku).
    const web = String(vars.path || card.path || "A").toUpperCase() === "B";

    const cfg = (context && context.providerConfig) || {};
    const timeoutMs = Number(cfg.timeoutMs || 240000);

    try {
      // Card JSON is passed as a single argv arg (cards are small); web flag via env.
      const { stdout } = await execFileP(
        process.execPath,
        ["--import", "tsx", RUNNER, JSON.stringify(card)],
        {
          cwd: ROOT,
          env: { ...process.env, ENRICH_EVAL_WEB: web ? "1" : "0" },
          timeout: timeoutMs + 30000,
          maxBuffer: 8 * 1024 * 1024,
        }
      );
      // The runner prints ONLY the enrichment JSON object on stdout.
      return { output: stdout.trim() };
    } catch (err) {
      return { error: `enrich provider failed: ${err && err.message ? err.message : String(err)}` };
    }
  },
};

export default provider;
