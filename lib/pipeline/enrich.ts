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
export interface EnrichLink {
  label: string;
  url: string;
}
export interface EnrichCitation {
  url: string;
  supports: string;
}
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
  links?: EnrichLink[];
  citations?: EnrichCitation[]; // grounding URLs for every added/contested fact (T052)
  ocr_text?: string | null;
  confidence: number; // 0..1, required (model self-assessment)
  notes?: string | null; // conflicts / gaps / provenance prose
  model?: string | null; // model id that produced this result (audit / tiering, T052)
}

// The exact set of canonical keys. normalizeEnrichment drops everything else so a
// chatty model can never smuggle extra columns into enrichment_json (mirrors the
// constrained-decoding `additionalProperties:false`, enforced again at runtime).
export const ENRICHMENT_KEYS = [
  "title_ru",
  "description_ru",
  "category",
  "start_date",
  "end_date",
  "start_time",
  "end_time",
  "venue_name",
  "address",
  "district",
  "price",
  "is_free",
  "maps_url",
  "image_url",
  "links",
  "citations",
  "ocr_text",
  "confidence",
  "notes",
  "model",
] as const;

// Scalar fields that, when present but empty/blank, normalize to null (so a model's
// "" never overwrites a good column via the COALESCE promote).
const NULLABLE_STRING_FIELDS = [
  "category",
  "start_date",
  "end_date",
  "start_time",
  "end_time",
  "venue_name",
  "address",
  "district",
  "price",
  "maps_url",
  "image_url",
  "ocr_text",
  "notes",
  "model",
] as const;

function toNullableString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? null : t;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function toNullableBool(v: unknown): boolean | null {
  if (v == null) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (["true", "yes", "1", "free", "gratis", "бесплатно"].includes(t)) return true;
    if (["false", "no", "0", "paid"].includes(t)) return false;
  }
  if (typeof v === "number") return v !== 0;
  return null;
}

// Clamp a self-assessed confidence into [0,1]. Non-numeric / NaN → 0 (treated as the
// least-trustworthy value so the hold gate withholds it rather than auto-publishing).
export function clampConfidence(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function normalizeLinks(v: unknown): EnrichLink[] {
  if (!Array.isArray(v)) return [];
  const out: EnrichLink[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const url = toNullableString((item as Record<string, unknown>).url);
    if (!url) continue; // a link with no URL is useless
    const label = toNullableString((item as Record<string, unknown>).label) ?? url;
    out.push({ label, url });
  }
  return out;
}

function normalizeCitations(v: unknown): EnrichCitation[] {
  if (!Array.isArray(v)) return [];
  const out: EnrichCitation[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const url = toNullableString((item as Record<string, unknown>).url);
    if (!url) continue; // a citation must point somewhere to ground anything
    const supports = toNullableString((item as Record<string, unknown>).supports) ?? "";
    out.push({ url, supports });
  }
  return out;
}

// T051 — Validate + normalize a RAW model object into the canonical EnrichmentResult:
// drop unknown keys, coerce scalar types, blank-string → null, clamp confidence to
// [0,1], and shape links[]/citations[] (dropping entries that lack a URL). This is the
// single runtime gate between an untrusted model response and what gets persisted to
// enrichment_json / promoted to columns; pure + total (never throws — a junk input
// yields a minimal valid card with confidence 0).
export function normalizeEnrichment(raw: unknown): EnrichmentResult {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: EnrichmentResult = {
    title_ru: toNullableString(r.title_ru) ?? "",
    description_ru: toNullableString(r.description_ru) ?? "",
    confidence: clampConfidence(r.confidence),
  };
  for (const k of NULLABLE_STRING_FIELDS) {
    out[k] = toNullableString(r[k]);
  }
  out.is_free = toNullableBool(r.is_free);
  out.links = normalizeLinks(r.links);
  out.citations = normalizeCitations(r.citations);
  return out;
}

// T052 — Ground-or-flag gate. A result is HELD (kept but withheld from the digest, not
// auto-published) when its confidence falls below CONFIDENCE_HOLD. We additionally flag
// any "added fact" (a non-null where/when/price field) that has NO citation backing it,
// since the constitution forbids inventing dates/prices/venue/address (ground-or-flag):
// those flags are folded into notes so the audit blob records WHY a card was held.
const GROUNDABLE_FACTS = [
  "start_date",
  "end_date",
  "start_time",
  "end_time",
  "venue_name",
  "address",
  "price",
] as const;

export interface GroundReport {
  held: boolean; // confidence < CONFIDENCE_HOLD → withhold from digest
  flags: string[]; // human-readable reasons (ungrounded facts, low confidence)
  ungroundedFacts: string[]; // field names asserted without any citation
}

// Pure: inspect a (normalized) result and report grounding/hold status. Does NOT mutate.
export function groundReport(r: EnrichmentResult): GroundReport {
  const flags: string[] = [];
  const hasCitations = (r.citations?.length ?? 0) > 0;
  const ungroundedFacts: string[] = [];
  if (!hasCitations) {
    for (const f of GROUNDABLE_FACTS) {
      if (r[f] != null) ungroundedFacts.push(f);
    }
  }
  if (ungroundedFacts.length) {
    flags.push(`ungrounded facts (no citation): ${ungroundedFacts.join(", ")}`);
  }
  const held = r.confidence < CONFIDENCE_HOLD;
  if (held) flags.push(`confidence ${r.confidence.toFixed(2)} < hold ${CONFIDENCE_HOLD}`);
  return { held, flags, ungroundedFacts };
}

// Pure: fold the grounding flags into the canonical `notes` field so enrichment_json
// itself records why a card was held / which facts are unsupported (provenance lives
// in the blob, not just in code). Returns a NEW result; never throws.
export function applyGroundOrFlag(r: EnrichmentResult): EnrichmentResult {
  const report = groundReport(r);
  if (!report.flags.length) return r;
  const prior = r.notes ? `${r.notes} ` : "";
  return { ...r, notes: `${prior}[${report.flags.join("; ")}]` };
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

// Injectable enrichment engine. Concrete impls (none imported here so the module stays
// key-free + mockable): the DEFAULT `claude -p` client (Claude subscription/OAuth, NO
// API key — constitution IV), an OPTIONAL Anthropic-SDK client (constrained decoding /
// serverless runtime), and a stub/mock in tests.
//
// T053 — optional web augmentation: a client MAY perform web_search / WebFetch to
// ground facts when `opts.web === true`. It is OFF by default; a client that cannot do
// web lookups simply ignores the flag. This is a CAPABILITY hint on an interface, not a
// dependency — nothing here imports `workflow`, the Anthropic SDK, or a fetch library.
export interface EnrichClient {
  enrich(row: EnrichInput, opts?: { web?: boolean }): Promise<EnrichmentResult>;
  // Optional self-description so the orchestrator/tests can decide whether to pass
  // `{web:true}` and which model id to record. Both are advisory.
  readonly supportsWeb?: boolean;
  readonly model?: string;
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
  const raw = await client.enrich(row, { web });
  // T051 normalize (drop unknown keys, clamp confidence, coerce types) → T052
  // ground-or-flag (fold hold/ungrounded reasons into notes), recording the model id.
  let r = normalizeEnrichment(raw);
  if (client.model && !r.model) r = { ...r, model: client.model };
  r = applyGroundOrFlag(r);
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

// ──────────────────────────────────────────────────────────────────────────────
// T054 — Series-aware enrichment. Enrichment runs ONCE per event_series (the card),
// never per event_occurrence — occurrences are dated sessions of the same card and
// carry no enrichable text (data-model "occurrence: never enriched directly; its
// series is"). The selection/targeting logic is pure (needsEnrich) so it is testable
// offline, and the COALESCE promote preserves an already-enriched series' score on a
// re-run, exactly like enrichOne does for events.
// ──────────────────────────────────────────────────────────────────────────────

// PURE: the resolved re-enrichment trigger (data-model E): a card needs (re-)enrichment
// when it has never been enriched, OR its source changed since the last enrichment
// (last_seen strictly after enriched_at), OR an explicit force flag is set. ISO-8601
// timestamps compare lexicographically, so a plain string `>` is correct + dependency-
// free. Works for events, series, and places (any row with enriched_at + last_seen).
export function needsEnrich(
  row: { enriched_at?: string | null; last_seen?: string | null },
  force = false,
): boolean {
  if (force) return true;
  if (!row.enriched_at) return true;
  if (row.last_seen && row.last_seen > row.enriched_at) return true;
  return false;
}

// Enrich ONE series row: same normalize → ground-or-flag → COALESCE-promote shape as
// enrichOne, but writes the event_series table. Deliberately does NOT touch score
// (scorer-owned) so a re-enrich preserves it; enriched_at is overwritten with `now`
// (the re-enrich trigger compares it against last_seen). Throws on client failure; the
// batch catches per item (fail-soft).
export async function enrichSeriesOne(
  row: EnrichInput,
  { client, exec = sql, web = false }: { client: EnrichClient; exec?: typeof sql; web?: boolean },
): Promise<EnrichmentResult> {
  const raw = await client.enrich(row, { web });
  let r = normalizeEnrichment(raw);
  if (client.model && !r.model) r = { ...r, model: client.model };
  r = applyGroundOrFlag(r);
  const ts = nowIso();
  const existingLinks = r.links ?? [];
  const mapsLink = r.maps_url ? [{ label: "Google Maps", url: r.maps_url }] : [];
  const links = [...existingLinks, ...mapsLink];
  const linksJson = links.length ? JSON.stringify(links) : null;

  await exec`UPDATE event_series SET
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

// Batched series enricher: pick a capped batch of series needing (re-)enrichment
// (highest score first), one row per series (NOT per occurrence). `force` re-enriches
// every selected card; otherwise the SQL applies the needsEnrich trigger. Per-item
// try/catch keeps it fail-soft. `dry` selects but writes nothing.
export async function enrichSeriesCards(
  limit = 10,
  {
    client,
    exec = sql,
    dry = false,
    web = false,
    force = false,
  }: { client: EnrichClient; exec?: typeof sql; dry?: boolean; web?: boolean; force?: boolean },
): Promise<EnrichResult> {
  const rows = (await exec`
    SELECT id, title, description, raw_excerpt, source_url, image_url, links_json, score
    FROM event_series
    WHERE ${force} OR enriched_at IS NULL OR last_seen > enriched_at
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
      await enrichSeriesOne(row, { client, exec, web });
      enriched++;
    } catch {
      errors++;
    }
  }
  return { attempted: rows.length, enriched, skipped, errors };
}
