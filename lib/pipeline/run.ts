import { ingestAll } from "./ingest";
import { normalizeAll } from "./normalize";
import { dedup } from "./dedup";
import { scoreAll } from "./score";
import { tagAll } from "./tags";
import { geoEnrich } from "./geo";

// Full pipeline in the canonical stage order (constitution V, v1.1.0):
// ingest -> normalize -> dedup -> score -> tag -> [enrich] -> geo.
// Runs sequentially so each stage sees the previous stage's output. Dedup runs
// immediately after normalize (collapses cross-source duplicates by source
// weight+score, idempotent — re-runs find no new merges). Enrich (T050) will slot
// in before geo once it exists; geo stays last so it benefits from enrich-filled
// venue/address.
export async function runPipeline(opts: { geoLimit?: number } = {}) {
  const started = Date.now();
  const ingest = await ingestAll();
  const normalize = await normalizeAll();
  const dedupe = await dedup();
  const score = await scoreAll();
  const tag = await tagAll();
  const geo = await geoEnrich(opts.geoLimit ?? 30);
  return {
    ok: true,
    took_ms: Date.now() - started,
    ingest,
    normalize,
    dedup: dedupe,
    score,
    tag,
    geo,
  };
}
