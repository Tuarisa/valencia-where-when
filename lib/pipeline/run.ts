import { ingestAll } from "./ingest";
import { normalizeAll } from "./normalize";
import { dedup } from "./dedup";
import { scoreAll } from "./score";
import { tagAll } from "./tags";
import { enrichCards, type EnrichClient } from "./enrich";
import { geoEnrich } from "./geo";

// Full pipeline in the canonical stage order (constitution V, v1.1.0):
// ingest -> normalize -> dedup -> score -> tag -> [enrich] -> geo.
// Runs sequentially so each stage sees the previous stage's output. Dedup runs
// immediately after normalize (collapses cross-source duplicates by source
// weight+score, idempotent — re-runs find no new merges).
//
// Enrich (T020/T050) slots in BEFORE geo so geo benefits from enrich-filled
// venue/address — but it is OFF the default hot path (enrich.ts: "NOT part of the
// synchronous runPipeline hot path"). It runs ONLY when an `enrichClient` is injected
// (the Vercel enrich workflow, or a local run wiring `createClaudeEnrichClient()` from
// enrich-client.ts). A plain offline run passes no client, so enrich is skipped and the
// pipeline stays fast + key-free. geo stays last.
export async function runPipeline(
  opts: { geoLimit?: number; enrichClient?: EnrichClient; enrichLimit?: number } = {},
) {
  const started = Date.now();
  const ingest = await ingestAll();
  const normalize = await normalizeAll();
  const dedupe = await dedup();
  const score = await scoreAll();
  const tag = await tagAll();
  const enrich = opts.enrichClient
    ? await enrichCards(opts.enrichLimit ?? 10, { client: opts.enrichClient })
    : { skipped: "no enrichClient (enrich runs in the workflow/route or a keyed local run)" };
  const geo = await geoEnrich(opts.geoLimit ?? 30);
  return {
    ok: true,
    took_ms: Date.now() - started,
    ingest,
    normalize,
    dedup: dedupe,
    score,
    tag,
    enrich,
    geo,
  };
}
