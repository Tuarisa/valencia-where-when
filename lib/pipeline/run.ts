import { ingestAll } from "./ingest";
import { normalizeHemisferic } from "./normalize";
import { scoreAll } from "./score";
import { tagAll } from "./tags";
import { geoEnrich } from "./geo";

// Full pipeline: ingest -> normalize -> score -> tag -> geo.
// Runs sequentially so each stage sees the previous stage's output.
export async function runPipeline(opts: { geoLimit?: number } = {}) {
  const started = Date.now();
  const ingest = await ingestAll();
  const normalize = await normalizeHemisferic();
  const score = await scoreAll();
  const tag = await tagAll();
  const geo = await geoEnrich(opts.geoLimit ?? 30);
  return {
    ok: true,
    took_ms: Date.now() - started,
    ingest,
    normalize,
    score,
    tag,
    geo,
  };
}
