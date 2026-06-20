import { sql } from "../db";
import { CONFIDENCE_HOLD } from "./enrich";

// Notifications (sub-area G, FR-012/013/014/021). The SELECTION logic is PURE +
// unit-testable; the DB loader + send + mark-notified bookkeeping (T071) wrap it.
// Digest = family-fit, un-notified, in-horizon, above score AND confidence floors.
// Rare alert = un-notified, above a HIGHER score bar, dispatched out of cycle.

export interface DigestCandidate {
  id: number;
  title?: string | null;
  start_date?: string | null;
  score?: number | null;
  notified?: number | null;
  category?: string | null;
  tags_json?: string | null;
  enrichment_json?: string | null;
  enriched_at?: string | null;
  [k: string]: unknown;
}

// Defaults (data-model "Resolved threshold table" / spec FR-012/014).
export const DIGEST_HORIZON_DAYS = 21; // 2–3 week look-ahead
export const DIGEST_SCORE_THRESHOLD = 55; // family-fit floor for the weekly digest
export const ALERT_SCORE_THRESHOLD = 85; // rare/high-value bar for out-of-cycle alerts

// Curation excludes (Constitution II): political news (SpainNewsOnline-style) is out
// by default; the score threshold suppresses the rest of the tourist/village filler.
const EXCLUDE = ["news", "politics", "politica", "política", "noticias", "spainnews"];

export function parseTags(c: DigestCandidate): string[] {
  try {
    const a = JSON.parse(c.tags_json || "[]");
    return Array.isArray(a) ? a.map((t) => String(t).toLowerCase()) : [];
  } catch {
    return [];
  }
}

// PURE: does this card fit the family? Lenient — include unless it carries an
// excluded (political-news) signal; the score floor does the rest of the curation.
export function isFamilyFit(c: DigestCandidate): boolean {
  const cat = (c.category || "").toLowerCase();
  const tags = parseTags(c);
  return !EXCLUDE.some((x) => cat.includes(x) || tags.some((t) => t.includes(x)));
}

// PURE: enrichment confidence (0..1) or null when the card is NOT enriched. A
// null means "no confidence gate" — un-enriched cards are shown as-is; only an
// ENRICHED card with low confidence is withheld (don't show unverified facts).
export function cardConfidence(c: DigestCandidate): number | null {
  if (!c.enriched_at) return null;
  try {
    const e = JSON.parse(c.enrichment_json || "{}");
    return typeof e?.confidence === "number" ? e.confidence : null;
  } catch {
    return null;
  }
}

// PURE: YYYY-MM-DD + N days → YYYY-MM-DD (UTC, deterministic given the inputs).
export function addDays(date: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return date;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

// PURE: is `date` within [today, today+horizonDays]? ISO dates compare lexically.
export function withinHorizon(date: string | null | undefined, today: string, horizonDays: number): boolean {
  if (!date) return false;
  const d = date.slice(0, 10);
  return d >= today && d <= addDays(today, horizonDays);
}

export interface DigestParams {
  today: string; // YYYY-MM-DD
  horizonDays?: number;
  threshold?: number;
  holdThreshold?: number;
}

// PURE: weekly-digest selection. notified=0 AND in-horizon AND score≥threshold AND
// family-fit AND not (enriched & confidence<hold).
export function selectDigest(
  candidates: DigestCandidate[],
  { today, horizonDays = DIGEST_HORIZON_DAYS, threshold = DIGEST_SCORE_THRESHOLD, holdThreshold = CONFIDENCE_HOLD }: DigestParams,
): DigestCandidate[] {
  return candidates.filter((c) => {
    if (c.notified) return false;
    if ((c.score ?? 0) < threshold) return false;
    if (!isFamilyFit(c)) return false;
    if (!withinHorizon(c.start_date, today, horizonDays)) return false;
    const conf = cardConfidence(c);
    if (conf != null && conf < holdThreshold) return false;
    return true;
  });
}

export interface AlertParams {
  alertThreshold?: number;
  holdThreshold?: number;
}

// PURE: rare-event alert selection. Higher score bar; no horizon clamp (high-value
// items can be further out). notified=0, family-fit, confidence-gated.
export function selectAlerts(
  candidates: DigestCandidate[],
  { alertThreshold = ALERT_SCORE_THRESHOLD, holdThreshold = CONFIDENCE_HOLD }: AlertParams = {},
): DigestCandidate[] {
  return candidates.filter((c) => {
    if (c.notified) return false;
    if ((c.score ?? 0) < alertThreshold) return false;
    if (!isFamilyFit(c)) return false;
    const conf = cardConfidence(c);
    if (conf != null && conf < holdThreshold) return false;
    return true;
  });
}

// Load un-notified upcoming event candidates (the pure selectors then filter). Series
// + the "new places" block join in with T071's full digest builder. Injectable exec.
export async function loadEventCandidates({ exec = sql }: { exec?: typeof sql } = {}): Promise<DigestCandidate[]> {
  return (await exec`
    SELECT id, title, start_date, score, notified, category, tags_json, enrichment_json, enriched_at
    FROM events
    WHERE notified = 0 AND status = 'upcoming'
    ORDER BY score DESC NULLS LAST
  `) as unknown as DigestCandidate[];
}
