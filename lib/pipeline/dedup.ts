import { sql } from "../db";
import { slugify } from "../format";
import { nowIso } from "./util";

// Cross-source event dedup (research D2 / data-model "Dedup match & merge").
// Same real-world event (e.g. "Слава Комиссаренко" listed by three Telegram
// channels with conflicting dates) collapses to ONE survivor that keeps links to
// every contributing source. Pure helpers below are DB-free and unit-testable;
// the `dedup({ exec })` orchestrator takes an INJECTABLE sql executor (mirroring
// `markRawItem`) so the module compiles and runs without a live connection and
// NEVER opens a DB at import time. Soft-collapse only — never deletes
// `source_items` (constitution I: raw layer is append-only).

// Source weight authority (sources.weight). Higher rank wins a tie-break group.
export type SourceWeight = "gold" | "good" | "mine" | "off";

export const SOURCE_WEIGHT_RANK: Record<SourceWeight, number> = {
  gold: 3,
  good: 2,
  mine: 1,
  off: 0,
};

// Resolve a weight string (or unknown) to a numeric rank. Unknown/missing → 0.
export function sourceWeightRank(weight?: string | null): number {
  if (!weight) return 0;
  const r = SOURCE_WEIGHT_RANK[weight as SourceWeight];
  return typeof r === "number" ? r : 0;
}

// A candidate event row as loaded for dedup. Loose by design — only the fields
// the dedup stage reads/writes are typed; everything else passes through.
export interface DedupEvent {
  id?: number | null;
  title?: string | null;
  city?: string | null;
  start_date?: string | null;
  score?: number | null;
  source?: string | null;
  source_url?: string | null;
  source_weight?: string | null; // joined from sources.weight
  metadata_json?: string | null;
  [key: string]: unknown;
}

// One source link accumulated onto a survivor's metadata_json.sources[].
export interface SourceLink {
  source: string | null;
  source_url: string | null;
}

const DEFAULT_DATE_WINDOW_DAYS = 3;

// Generic words that carry no identity signal — dropped from the title
// signature so "Stand Up: Slava Komissarenko" and "Slava Komissarenko — stand-up"
// share a key. Covers EN/ES/RU framing terms common in event titles.
const TITLE_STOPWORDS = new Set<string>([
  "stand", "up", "standup", "show", "concierto", "concert", "concerto",
  "en", "in", "v", "de", "la", "el", "los", "las", "y", "and",
  "valencia", "valensii", "valensiya", "espectaculo", "live",
]);

// PURE: order-independent significant-token signature of a title. Slugify (which
// transliterates/strips to ASCII), split on "-", drop stopwords + 1-char noise,
// then SORT the remaining tokens so word order and trailing suffixes don't break
// the match. Falls back to the full slug when nothing significant remains.
export function titleSignature(title?: string | null): string {
  const slug = slugify(title);
  if (!slug) return "untitled";
  const tokens = slug
    .split("-")
    .filter((t) => t.length > 1 && !TITLE_STOPWORDS.has(t));
  if (tokens.length === 0) return slug;
  return tokens.sort().join("-");
}

// Calendar days since epoch for a YYYY-MM-DD date (null when unparseable).
function epochDay(startDate?: string | null): number | null {
  if (!startDate) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(startDate);
  if (!m) return null;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
}

// PURE coarse match key: title signature + city only (NO date). Events sharing
// this key are candidates for the same real-world event; the date-window check
// in `groupByKey` then splits genuinely different occurrences apart. Keeping the
// date OUT of the key avoids the bucket-boundary bug where adjacent days (the
// "one channel has the wrong day" case) fall into different fixed buckets.
export function dedupKey(event: DedupEvent): string {
  const sig = titleSignature(event.title);
  const city = slugify(event.city) || "unknown";
  return `${sig}|${city}`;
}

// PURE: group events by dedupKey, then within each candidate cluster split by a
// ±windowDays date proximity check (greedy, date-sorted). Two events merge only
// when their start dates are within `windowDays` of the cluster anchor — so a
// genuine series on far-apart dates stays separate, while conflicting dates for
// one occurrence collapse together. Members without a parseable date attach to
// the first sub-group of their cluster (they carry no date to contradict).
export function groupByKey(
  events: DedupEvent[],
  windowDays = DEFAULT_DATE_WINDOW_DAYS,
): Map<string, DedupEvent[]> {
  const clusters = new Map<string, DedupEvent[]>();
  for (const ev of events) {
    const key = dedupKey(ev);
    const bucket = clusters.get(key);
    if (bucket) bucket.push(ev);
    else clusters.set(key, [ev]);
  }

  const groups = new Map<string, DedupEvent[]>();
  for (const [key, members] of clusters) {
    // Date-sorted; undated members first so they anchor with the earliest dated.
    const sorted = [...members].sort((a, b) => {
      const da = epochDay(a.start_date);
      const db = epochDay(b.start_date);
      if (da == null && db == null) return 0;
      if (da == null) return -1;
      if (db == null) return 1;
      return da - db;
    });
    let sub = 0;
    let anchor: number | null = null;
    let current: DedupEvent[] = [];
    const flush = () => {
      if (current.length) groups.set(`${key}|${sub++}`, current);
    };
    for (const ev of sorted) {
      const d = epochDay(ev.start_date);
      if (current.length === 0) {
        current = [ev];
        anchor = d;
      } else if (d == null || anchor == null || Math.abs(d - anchor) <= windowDays) {
        current.push(ev);
        if (anchor == null) anchor = d; // first dated member sets the anchor
      } else {
        flush();
        current = [ev];
        anchor = d;
      }
    }
    flush();
  }
  return groups;
}

type RankFn = (weight?: string | null) => number;

// PURE: choose the surviving event by (source weight rank, score). Higher source
// weight wins; ties break on higher score; remaining ties keep the first member
// (stable). Returns the input member reference (not a copy).
export function chooseSurvivor(
  group: DedupEvent[],
  rankFn: RankFn = sourceWeightRank,
): DedupEvent {
  if (group.length === 0) throw new Error("chooseSurvivor: empty group");
  let best = group[0];
  let bestRank = rankFn(best.source_weight);
  let bestScore = best.score ?? 0;
  for (let i = 1; i < group.length; i++) {
    const cand = group[i];
    const r = rankFn(cand.source_weight);
    const s = cand.score ?? 0;
    if (r > bestRank || (r === bestRank && s > bestScore)) {
      best = cand;
      bestRank = r;
      bestScore = s;
    }
  }
  return best;
}

// Safely parse a survivor's metadata_json into an object. Malformed/empty → {}.
function parseMetadata(metadata?: string | null): Record<string, unknown> {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// Collect existing sources[] entries plus a fresh {source, source_url} per group
// member, de-duplicating on the source+url pair. Stable order: existing first.
function accumulateSources(group: DedupEvent[], existing: unknown): SourceLink[] {
  const out: SourceLink[] = [];
  const seen = new Set<string>();
  const add = (source: unknown, url: unknown) => {
    const s = typeof source === "string" && source ? source : null;
    const u = typeof url === "string" && url ? url : null;
    if (s == null && u == null) return;
    const k = `${s ?? ""}|${u ?? ""}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ source: s, source_url: u });
  };
  if (Array.isArray(existing)) {
    for (const e of existing) {
      if (e && typeof e === "object") {
        add((e as Record<string, unknown>).source, (e as Record<string, unknown>).source_url);
      }
    }
  }
  for (const ev of group) add(ev.source, ev.source_url);
  return out;
}

// Result of merging one group.
export interface MergeResult {
  survivor: DedupEvent;
  mergedSources: SourceLink[];
  losers: DedupEvent[];
}

// PURE: merge a group into one survivor. The survivor keeps its OWN start_date
// (conflicting dates resolve to the reliable, higher-weight source). Every group
// member's {source, source_url} accumulates into survivor.metadata_json.sources[]
// (parsed/stringified safely, duplicates dropped). Losers are returned for soft
// collapse — nothing is deleted here.
export function mergeGroup(group: DedupEvent[], rankFn: RankFn = sourceWeightRank): MergeResult {
  const survivor = chooseSurvivor(group, rankFn);
  const metadata = parseMetadata(survivor.metadata_json);
  const mergedSources = accumulateSources(group, metadata.sources);
  metadata.sources = mergedSources;

  const mergedSurvivor: DedupEvent = {
    ...survivor,
    metadata_json: JSON.stringify(metadata),
  };
  const losers = group.filter((ev) => ev !== survivor);
  return { survivor: mergedSurvivor, mergedSources, losers };
}

export interface DedupResult {
  groups: number;
  merged: number;
  collapsed: number;
}

// Async orchestrator. Loads candidate events (joined with their source weight),
// groups by dedupKey, and for every multi-member group: writes the survivor's
// updated metadata_json and soft-collapses losers (marks them merged into the
// survivor — never deletes). `exec` is INJECTABLE (defaults to the real client)
// so this is unit-testable without a live DB; no connection is opened at import.
export async function dedup({ exec = sql }: { exec?: typeof sql } = {}): Promise<DedupResult> {
  const rows = (await exec`
    SELECT e.*, s.weight AS source_weight
    FROM events e
    LEFT JOIN sources s ON s.key = e.source
    WHERE e.status = 'upcoming'
    ORDER BY e.id
  `) as unknown as DedupEvent[];

  const groups = groupByKey(rows);
  const ts = nowIso();
  let merged = 0;
  let collapsed = 0;

  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const { survivor, losers } = mergeGroup(members);
    merged++;

    await exec`UPDATE events
      SET metadata_json = ${survivor.metadata_json}, last_seen = ${ts}
      WHERE id = ${survivor.id ?? null}`;

    for (const loser of losers) {
      await exec`UPDATE events
        SET status = 'merged', metadata_json = ${mergeLoserMetadata(loser, survivor.id ?? null)}, last_seen = ${ts}
        WHERE id = ${loser.id ?? null}`;
      collapsed++;
    }
  }

  return { groups: groups.size, merged, collapsed };
}

// Record on a soft-collapsed loser which survivor it merged into. Pure helper.
function mergeLoserMetadata(loser: DedupEvent, survivorId: number | null): string {
  const metadata = parseMetadata(loser.metadata_json);
  metadata.merged_into = survivorId;
  return JSON.stringify(metadata);
}
