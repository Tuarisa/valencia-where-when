import { sql } from "../db";
import { nowIso } from "./util";

// Batched, fail-soft card enrichment (sub-area E, constitution IV). The LLM engine
// is INJECTED as an `EnrichClient` so the orchestration (selection, COALESCE writes,
// per-item try/catch, confidence gating) is fully unit-testable WITHOUT a network or
// API key. The concrete Anthropic-SDK client — constrained decoding via
// `output_config.format`, OCR + RU translation, optional web_search/web_fetch tools,
// `claude -p` fallback — lands in T051–T053; this file deliberately does not import
// the SDK so the skeleton stays mockable and key-free.

// Canonical enrichment output (data-model.md "E. Enrichment" — superset schema).
// What the constrained-decoding call must return; persisted whole to
// enrichment_json (audit) and promoted to columns with COALESCE guards.
export interface EnrichmentResult {
  title_ru: string;
  description_ru: string;
  category?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  venue_name?: string | null;
  address?: string | null;
  district?: string | null;
  price?: string | null;
  is_free?: boolean | null;
  maps_url?: string | null;
  image_url?: string | null;
  links?: Array<{ label: string; url: string }>;
  citations?: Array<{ url: string; supports: string }>;
  ocr_text?: string | null;
  confidence: number; // 0..1, required (model self-assessment)
  notes?: string | null;
}

// The minimal row shape an enricher reads (subset of an event/series/place).
export interface EnrichInput {
  id: number;
  title?: string | null;
  description?: string | null;
  raw_excerpt?: string | null;
  source_url?: string | null;
  image_url?: string | null;
  links_json?: string | null;
  score?: number | null;
  [k: string]: unknown;
}

// Injectable enrichment engine. Concrete impls: Anthropic SDK (primary, T051),
// `claude -p` fallback (T053), and a stub/mock in tests.
export interface EnrichClient {
  enrich(row: EnrichInput, opts?: { web?: boolean }): Promise<EnrichmentResult>;
}

// Resolved threshold table (data-model.md). Confidence gates digest inclusion +
// model escalation; named here so the digest selector (G) shares the same numbers.
export const CONFIDENCE_HOLD = 0.6; // below → withhold from the digest
export const CONFIDENCE_REVIEW = 0.8; // below → flag for review / escalate model

export interface EnrichResult {
  attempted: number;
  enriched: number;
  skipped: number;
  errors: number;
}

const intBool = (v?: boolean | null): number | null => (v == null ? null : v ? 1 : 0);

// Enrich ONE row: call the injected client, then promote the result onto the event
// with COALESCE guards (model nulls never clobber existing good values) + persist the
// full result to enrichment_json + stamp enriched_at. The Google-Maps link, if any,
// is folded into links_json (events have no maps_url column — data-model "facts").
// Throws on client failure; the batch (enrichCards) catches per item so one bad card
// never aborts the run or corrupts the base record (constitution IV).
export async function enrichOne(
  row: EnrichInput,
  { client, exec = sql, web = false }: { client: EnrichClient; exec?: typeof sql; web?: boolean },
): Promise<EnrichmentResult> {
  const r = await client.enrich(row, { web });
  const ts = nowIso();
  const existingLinks = r.links ?? [];
  const mapsLink = r.maps_url ? [{ label: "Google Maps", url: r.maps_url }] : [];
  const links = [...existingLinks, ...mapsLink];
  const linksJson = links.length ? JSON.stringify(links) : null;

  await exec`UPDATE events SET
    title_ru        = COALESCE(${r.title_ru ?? null}, title_ru),
    description_ru  = COALESCE(${r.description_ru ?? null}, description_ru),
    category        = COALESCE(${r.category ?? null}, category),
    venue_name      = COALESCE(${r.venue_name ?? null}, venue_name),
    address         = COALESCE(${r.address ?? null}, address),
    district        = COALESCE(${r.district ?? null}, district),
    price           = COALESCE(${r.price ?? null}, price),
    is_free         = COALESCE(${intBool(r.is_free)}, is_free),
    image_url       = COALESCE(${r.image_url ?? null}, image_url),
    links_json      = COALESCE(${linksJson}, links_json),
    enrichment_json = ${JSON.stringify(r)},
    enriched_at     = ${ts}
    WHERE id = ${row.id}`;
  return r;
}

// Batched enricher: pick a capped batch of un-enriched events (highest score first),
// enrich each in its own try/catch so a failure is counted and skipped (the row stays
// un-enriched but valid + renderable). NOT part of the synchronous runPipeline hot
// path — invoked from the enrich workflow/route (T055). `dry` selects but writes
// nothing. Selection re-runs cheaply: enriched rows drop out (enriched_at IS NOT NULL).
export async function enrichCards(
  limit = 10,
  { client, exec = sql, dry = false }: { client: EnrichClient; exec?: typeof sql; dry?: boolean },
): Promise<EnrichResult> {
  const rows = (await exec`
    SELECT id, title, description, raw_excerpt, source_url, image_url, links_json, score
    FROM events
    WHERE enriched_at IS NULL
    ORDER BY score DESC NULLS LAST
    LIMIT ${limit}
  `) as unknown as EnrichInput[];

  let enriched = 0;
  let errors = 0;
  let skipped = 0;
  for (const row of rows) {
    if (dry) {
      skipped++;
      continue;
    }
    try {
      await enrichOne(row, { client, exec });
      enriched++;
    } catch {
      // fail-soft: leave the row un-enriched (still renderable), count it, move on.
      errors++;
    }
  }
  return { attempted: rows.length, enriched, skipped, errors };
}
