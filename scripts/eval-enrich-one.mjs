#!/usr/bin/env node
// Eval helper (sub-area I, T090). Runs ONE enrichment call through the REAL production
// client — lib/pipeline/enrich-client.ts:createClaudeEnrichClient (`claude -p`,
// key-free) — and prints the resulting enrichment JSON object to stdout. Nothing else
// is printed on stdout, so the promptfoo custom provider (providers/promptfoo-enrich.mjs)
// can capture it cleanly.
//
//   node --import tsx scripts/eval-enrich-one.mjs '<card-json>'     # ENRICH_EVAL_WEB=0|1
//
// The card JSON is one argv arg (the fixture's `input`). ENRICH_EVAL_WEB=1 → PATH B
// (web grounding: web=true → sonnet + --allowedTools WebFetch inside the client).
// enrich-client.ts imports ONLY types from enrich.ts (erased at compile time) and never
// touches the DB module, so this stays key-free and side-effect-free.

import { createClaudeEnrichClient } from "../lib/pipeline/enrich-client.ts";

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    process.stderr.write("eval-enrich-one: missing card JSON arg\n");
    process.exit(2);
  }
  let card;
  try {
    card = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`eval-enrich-one: card arg is not JSON — ${err.message}\n`);
    process.exit(2);
  }

  const web = process.env.ENRICH_EVAL_WEB === "1";
  // Map the fixture `input` (title/description/source/category/links) onto the
  // EnrichInput shape the client reads (title/description/source_url/links_json/...).
  const row = {
    id: card.id ?? null,
    title: card.title ?? null,
    description: card.description ?? null,
    raw_excerpt: card.raw_excerpt ?? card.excerpt ?? null,
    source_url: card.source_url ?? card.source ?? null,
    links_json:
      card.links_json ??
      (Array.isArray(card.links) ? JSON.stringify(card.links) : null),
  };

  const client = createClaudeEnrichClient();
  const result = await client.enrich(row, { web });
  // ONLY the enrichment JSON on stdout.
  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => {
  process.stderr.write(`eval-enrich-one: ${err && err.message ? err.message : String(err)}\n`);
  process.exit(1);
});
