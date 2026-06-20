import { sql } from "../db";
import { normalizeHemisferic, HEMISFERIC_SOURCE_KEY } from "./normalizers/hemisferic";
import { normalizeWorldafisha, WORLDAFISHA_SOURCE_KEY } from "./normalizers/worldafisha";
import { normalizeValenciarusa, VALENCIARUSA_SOURCE_KEY } from "./normalizers/valenciarusa";
import { normalizeVidacultural, VIDACULTURAL_SOURCE_KEY } from "./normalizers/vidacultural";
import { normalizeConcerten, CONCERTEN_SOURCE_KEY } from "./normalizers/concerten";
import { normalizeValenciabonitaTg, VALENCIABONITA_TG_SOURCE_KEY } from "./normalizers/valenciabonita-telegram";
import { markRawItem } from "./normalizers/types";

// Re-export the Hemisfèric path so existing imports keep working.
export { normalizeHemisferic } from "./normalizers/hemisferic";

// A registered source normalizer processes ALL pending rows for its source key
// (batch). The dispatcher runs each registered normalizer, then marks any
// pending rows from unregistered sources as `ignored` (never deletes them —
// raw layer is append-only, constitution I).
export type SourceNormalizer = () => Promise<{ created: number; updated: number; processed: number }>;

// Registry keyed by source_key. Add new sources here as their normalizer module
// lands (Phase 8). Hemisfèric is the first entry.
export const NORMALIZER_REGISTRY: Map<string, SourceNormalizer> = new Map([
  [HEMISFERIC_SOURCE_KEY, normalizeHemisferic],
  [WORLDAFISHA_SOURCE_KEY, normalizeWorldafisha],
  [VALENCIARUSA_SOURCE_KEY, normalizeValenciarusa],
  [VIDACULTURAL_SOURCE_KEY, normalizeVidacultural],
  [CONCERTEN_SOURCE_KEY, normalizeConcerten],
  [VALENCIABONITA_TG_SOURCE_KEY, normalizeValenciabonitaTg],
]);

// Resolve a normalizer for a source key (pure — testable without a DB).
export function resolveNormalizer(
  sourceKey: string,
  registry: Map<string, SourceNormalizer> = NORMALIZER_REGISTRY,
): SourceNormalizer | undefined {
  return registry.get(sourceKey);
}

// Dispatch every pending raw item to its registered normalizer. Unknown sources
// resolve to `ignored`. Returns aggregate counts plus a per-source breakdown.
export async function normalizeAll(): Promise<{
  created: number;
  updated: number;
  processed: number;
  ignored: number;
  bySource: Record<string, { created: number; updated: number; processed: number }>;
}> {
  const bySource: Record<string, { created: number; updated: number; processed: number }> = {};
  let created = 0;
  let updated = 0;
  let processed = 0;

  // Run each registered (known) source normalizer.
  for (const [sourceKey, normalizer] of NORMALIZER_REGISTRY) {
    const res = await normalizer();
    bySource[sourceKey] = res;
    created += res.created;
    updated += res.updated;
    processed += res.processed;
  }

  // Mark pending rows from unregistered sources as `ignored` (append-only).
  const known = Array.from(NORMALIZER_REGISTRY.keys());
  const pending = (await sql`
    SELECT id, source_key FROM source_items
    WHERE (normalized_status IS NULL OR normalized_status = 'pending'
           OR normalized_at IS NULL OR normalized_at < last_seen)
      AND source_key <> ALL(${known})
  `) as Array<{ id: number; source_key: string }>;

  let ignored = 0;
  for (const row of pending) {
    await markRawItem(row.id, "ignored", `no normalizer for source ${row.source_key}`);
    ignored++;
  }

  return { created, updated, processed, ignored, bySource };
}
