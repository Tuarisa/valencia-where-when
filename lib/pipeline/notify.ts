import { sql } from "../db";
import { nowIso } from "./util";
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

// === Series (sub-area D/G, T073) =========================================
// A recurring offering is rendered as ONE card: the series (title/venue/score)
// plus its NEXT upcoming occurrence within the horizon — NOT one row per session.
// The next-occurrence date is computed from event_occurrences (MIN date ≥ today),
// either at load time (SQL) or purely from an `occurrences` list. No-repeat is
// keyed on series_id (notifications.series_id), so a series is digested once.
export interface SeriesCard extends DigestCandidate {
  // `start_date` here carries the NEXT upcoming occurrence date (so the existing
  // horizon/render helpers apply unchanged); `series_start` keeps the run start.
  series_start?: string | null;
  next_occurrence?: string | null;
  occurrence_count?: number | null;
  venue_name?: string | null;
  recurrence_summary?: string | null;
  occurrences?: Array<{ occurrence_date?: string | null; status?: string | null }>;
}

// PURE: earliest occurrence date on/after `today` (a non-cancelled session). Returns
// null when every occurrence is in the past or cancelled. ISO dates compare lexically.
export function nextOccurrence(
  occurrences: Array<{ occurrence_date?: string | null; status?: string | null }> | null | undefined,
  today: string,
): string | null {
  if (!Array.isArray(occurrences)) return null;
  let best: string | null = null;
  for (const o of occurrences) {
    const d = (o?.occurrence_date || "").slice(0, 10);
    if (!d || d < today) continue;
    if ((o?.status || "upcoming") === "cancelled") continue;
    if (best == null || d < best) best = d;
  }
  return best;
}

// PURE: weekly-digest selection for SERIES. Identical gates to selectDigest, but the
// horizon test runs against the NEXT upcoming occurrence (preferring an explicit
// `next_occurrence`, else computed from the `occurrences` list, else `start_date`).
// The chosen date is written back to `start_date` so renderers show ONE card + next date.
export function selectSeriesDigest(
  series: SeriesCard[],
  { today, horizonDays = DIGEST_HORIZON_DAYS, threshold = DIGEST_SCORE_THRESHOLD, holdThreshold = CONFIDENCE_HOLD }: DigestParams,
): SeriesCard[] {
  const out: SeriesCard[] = [];
  for (const s of series) {
    if (s.notified) continue;
    if ((s.score ?? 0) < threshold) continue;
    if (!isFamilyFit(s)) continue;
    const next = s.next_occurrence ?? nextOccurrence(s.occurrences, today) ?? s.start_date ?? null;
    if (!withinHorizon(next, today, horizonDays)) continue;
    const conf = cardConfidence(s);
    if (conf != null && conf < holdThreshold) continue;
    out.push({ ...s, next_occurrence: next, start_date: next });
  }
  return out;
}

// Load un-notified upcoming series + their NEXT upcoming occurrence (MIN occurrence_date
// ≥ today over non-cancelled sessions). The pure selectSeriesDigest then filters. The
// JOIN collapses N occurrences to ONE row per series (T073). Injectable exec.
export async function loadSeriesCandidates(
  { exec = sql, today }: { exec?: typeof sql; today: string },
): Promise<SeriesCard[]> {
  return (await exec`
    SELECT s.id, s.title, s.start_date AS series_start, s.score, s.notified,
           s.category, s.tags_json, s.enrichment_json, s.enriched_at,
           s.venue_name, s.recurrence_summary,
           n.next_occurrence, n.occurrence_count
    FROM event_series s
    LEFT JOIN (
      SELECT series_id,
             MIN(occurrence_date) AS next_occurrence,
             COUNT(*) AS occurrence_count
      FROM event_occurrences
      WHERE occurrence_date >= ${today} AND COALESCE(status, 'upcoming') <> 'cancelled'
      GROUP BY series_id
    ) n ON n.series_id = s.id
    WHERE s.notified = 0 AND s.status = 'upcoming'
    ORDER BY s.score DESC NULLS LAST
  `) as unknown as SeriesCard[];
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

// Load un-notified upcoming event candidates (the pure selectors then filter).
// Injectable exec.
export async function loadEventCandidates({ exec = sql }: { exec?: typeof sql } = {}): Promise<DigestCandidate[]> {
  return (await exec`
    SELECT id, title, start_date, score, notified, category, tags_json, enrichment_json, enriched_at
    FROM events
    WHERE notified = 0 AND status = 'upcoming'
    ORDER BY score DESC NULLS LAST
  `) as unknown as DigestCandidate[];
}

export interface NewPlace {
  id: number;
  name?: string | null;
  category?: string | null;
  area?: string | null;
  [k: string]: unknown;
}

// "New places on the radar" block: un-notified places (places gained a `notified`
// column in T004). Injectable exec.
export async function loadNewPlaces({ exec = sql }: { exec?: typeof sql } = {}): Promise<NewPlace[]> {
  return (await exec`
    SELECT id, name, category, area
    FROM places
    WHERE notified = 0
    ORDER BY id DESC
  `) as unknown as NewPlace[];
}

// PURE: render the digest as plain text. This is the default deliverable — the
// transport (Telegram/email/webhook) is pluggable below and starts as dry-run
// output (research G2). Deterministic given its inputs.
export function renderDigestText(
  events: DigestCandidate[],
  places: NewPlace[],
  mode: "weekly" | "alert" = "weekly",
  series: SeriesCard[] = [],
): string {
  const lines: string[] = [];
  lines.push(mode === "alert" ? "🔔 Valencia Radar — срочно" : "📅 Valencia Radar — афиша на 2–3 недели");
  lines.push("");
  if (events.length === 0 && series.length === 0) {
    lines.push("Ничего нового, подходящего семье, не найдено.");
  } else {
    for (const e of events) {
      const date = (e.start_date || "").slice(0, 10) || "дата уточняется";
      lines.push(`• ${date} — ${e.title ?? "(без названия)"}${e.score != null ? ` (score ${e.score})` : ""}`);
    }
    // Recurring offerings: ONE card per series, showing the next upcoming date (T073).
    for (const s of series) {
      const next = (s.next_occurrence || s.start_date || "").slice(0, 10);
      const when = next ? `ближайшая дата ${next}` : "даты уточняются";
      const cadence = s.recurrence_summary ? ` — ${s.recurrence_summary}` : "";
      lines.push(`• 🔁 ${s.title ?? "(без названия)"}${cadence} (${when})${s.score != null ? ` (score ${s.score})` : ""}`);
    }
  }
  if (mode === "weekly" && places.length) {
    lines.push("");
    lines.push("📍 Новые места на радаре:");
    for (const p of places) lines.push(`• ${p.name ?? "(место)"}${p.category ? ` — ${p.category}` : ""}`);
  }
  return lines.join("\n");
}

export interface DigestPayload {
  mode: "weekly" | "alert";
  events: DigestCandidate[];
  series: SeriesCard[];
  places: NewPlace[];
  text: string;
}

// Build a digest/alert payload: load candidates → pure-select → render text. Does
// NOT write anything (selection only) — sending + mark-notified are explicit steps.
export async function buildDigest(
  { exec = sql, today, mode = "weekly", params = {} }: { exec?: typeof sql; today: string; mode?: "weekly" | "alert"; params?: Partial<DigestParams & AlertParams> },
): Promise<DigestPayload> {
  const candidates = await loadEventCandidates({ exec });
  const events =
    mode === "alert"
      ? selectAlerts(candidates, params)
      : selectDigest(candidates, { today, ...params });
  // Recurring offerings: one card per series, gated like the weekly digest and shown
  // with its next upcoming occurrence (T073). Series are weekly-digest only — a rare
  // alert is for a single high-signal one-off, not a standing schedule.
  const series =
    mode === "weekly"
      ? selectSeriesDigest(await loadSeriesCandidates({ exec, today }), { today, ...params })
      : [];
  const places = mode === "weekly" ? await loadNewPlaces({ exec }) : [];
  return { mode, events, series, places, text: renderDigestText(events, places, mode, series) };
}

// Pluggable sender. Default = dry-run (returns the text, delivers nothing). A real
// transport (Telegram/webhook/email) is selected by env in T071's route.
export type DigestSender = (payload: DigestPayload) => Promise<{ delivered: boolean; transport: string }>;

export const dryRunSender: DigestSender = async () => ({ delivered: false, transport: "dry-run" });

export async function sendDigest(payload: DigestPayload, { sender = dryRunSender }: { sender?: DigestSender } = {}) {
  return sender(payload);
}

// Mark events + (optionally) places as notified and log a `notifications` row each,
// so a later digest never repeats them (SC-002, FR-013). Injectable exec.
export async function markEventsNotified(
  ids: number[],
  { exec = sql, channel = "digest" }: { exec?: typeof sql; channel?: string } = {},
): Promise<number> {
  if (ids.length === 0) return 0;
  const ts = nowIso();
  // Batch (F4/T184): ONE UPDATE over id = ANY($ids) + ONE multi-row INSERT via
  // parallel-array unnest, instead of 2N per-row round-trips (Neon = 1 HTTP/stmt).
  const chans = ids.map(() => channel);
  const stamps = ids.map(() => ts);
  await exec`UPDATE events SET notified = 1, notified_at = ${ts} WHERE id = ANY(${ids})`;
  await exec`
    INSERT INTO notifications (event_id, sent_at, channel)
    SELECT * FROM unnest(${ids}::int[], ${stamps}::text[], ${chans}::text[])
  `;
  return ids.length;
}

export async function markPlacesNotified(
  ids: number[],
  { exec = sql, channel = "digest" }: { exec?: typeof sql; channel?: string } = {},
): Promise<number> {
  if (ids.length === 0) return 0;
  const ts = nowIso();
  const chans = ids.map(() => channel);
  const stamps = ids.map(() => ts);
  await exec`UPDATE places SET notified = 1, notified_at = ${ts} WHERE id = ANY(${ids})`;
  await exec`
    INSERT INTO notifications (place_id, sent_at, channel)
    SELECT * FROM unnest(${ids}::int[], ${stamps}::text[], ${chans}::text[])
  `;
  return ids.length;
}

// Mark recurring SERIES as notified + log a notifications row each via series_id, so a
// later digest never repeats the series card (SC-002, T073). One row per series — NOT
// per occurrence — mirroring the one-card render. Injectable exec.
export async function markSeriesNotified(
  ids: number[],
  { exec = sql, channel = "digest" }: { exec?: typeof sql; channel?: string } = {},
): Promise<number> {
  if (ids.length === 0) return 0;
  const ts = nowIso();
  const chans = ids.map(() => channel);
  const stamps = ids.map(() => ts);
  await exec`UPDATE event_series SET notified = 1, notified_at = ${ts} WHERE id = ANY(${ids})`;
  await exec`
    INSERT INTO notifications (series_id, sent_at, channel)
    SELECT * FROM unnest(${ids}::int[], ${stamps}::text[], ${chans}::text[])
  `;
  return ids.length;
}
