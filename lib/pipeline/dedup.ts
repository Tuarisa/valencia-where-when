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
  url?: string | null; // canonical event URL (events.url) — strong-match key
  external_ref?: string | null; // stable per-source external id — strong-match key
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
  // Transliterated RU framing/noise words (mirror of the EN/ES set above), so a
  // Cyrillic title's framing doesn't add a spurious token that breaks the match
  // (e.g. "стендап"→"stendap", "концерт"→"kontsert").
  "stendap", "standap", "kontsert", "kontserty", "shou", "spektakl", "vecher", "na",
]);

// Russian Cyrillic → Latin map. CRITICAL for this RU-focused app: bare `slugify`
// strips non-ASCII, so every Cyrillic title (e.g. "Моргенштерн", "Антон Лирник")
// collapsed to the empty slug → the "untitled" signature → ALL RU events grouped
// as one. Transliterating first gives each RU title a real signature AND lets a
// Cyrillic title match its Latin transliteration ("Слава Комиссаренко" ↔
// "Slava Komissarenko").
const RU_TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

// PURE: lower-case + transliterate Cyrillic to Latin (other scripts pass through).
export function transliterate(value?: string | null): string {
  if (!value) return "";
  let out = "";
  for (const ch of value.toLowerCase()) out += RU_TRANSLIT[ch] ?? ch;
  return out;
}

// PURE: order-independent significant-token signature of a title. Transliterate
// Cyrillic first, then slugify (ascii-fold), split on "-", drop stopwords + 1-char
// noise, then SORT the remaining tokens so word order and trailing suffixes don't
// break the match. Returns "untitled" when nothing slug-able remains (degenerate —
// see isMergeableGroup, which refuses to merge on it).
export function titleSignature(title?: string | null): string {
  const slug = slugify(transliterate(title));
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

// PURE: strong-match key for an event — the FIRST non-empty of url / external_ref
// (research D2; schema entity_sources.match_method "url | external_id | ..."). A
// shared strong key is a DETERMINISTIC duplicate: the same canonical link (or the
// same per-source external id) is, by construction, the same listing — so it
// collapses BEFORE the fuzzy title/date pass, with no risk of the over-merge the
// fuzzy guards exist to prevent. Returns null when the event carries neither key
// (those rows fall through untouched to the fuzzy pass). Normalised: trimmed +
// lower-cased so trailing-slash / case variants of the same URL still collide.
//
// IMPORTANT — multi-event-per-page sources (lacotorra, eventbrite, hoyvalencia)
// emit MANY distinct dated events that all share ONE listing/snapshot page url.
// Keying on the url ALONE collapsed all of them into one (e.g. lacotorra's 56
// distinct events → 1, 55 wrongly marked duplicate). So the url key also folds in
// the title signature AND the start_date: same url + same title + same date → SAME
// key (a genuine re-fetch of one event still collapses, intended); same url +
// DIFFERENT title/date → DIFFERENT keys (distinct events on a shared page stay
// separate). The ext: branch is unchanged.
export function strongMatchKey(event: DedupEvent): string | null {
  const url = (event.url ?? "").trim().toLowerCase().replace(/\/+$/, "");
  if (url) return `url:${url}|${titleSignature(event.title)}|${event.start_date ?? ""}`;
  const ext = typeof event.external_ref === "string" ? event.external_ref.trim() : "";
  const src = typeof event.source === "string" ? event.source.trim() : "";
  // external_ref is only unique WITHIN a source, so scope it by source.
  if (ext) return `ext:${src}|${ext}`;
  return null;
}

// PURE pre-pass: collapse events that share a non-empty strongMatchKey into ONE
// representative each, BEFORE the fuzzy title/date grouping. Each collision group
// is merged via mergeGroup (survivor keeps every member's source link in
// metadata_json.sources[]); its losers are accumulated so the orchestrator can
// soft-collapse them. Returns { survivors, collapses }: `survivors` is the reduced
// event list (strong-collapsed reps + every key-less passthrough, original order
// preserved) to feed into groupByKey; `collapses` pairs each loser with its
// survivor id for the DB write. Idempotent — a re-run finds each survivor alone.
export interface StrongCollapse {
  loser: DedupEvent;
  survivorId: number | null;
}

// PURE guard: may a strong-key collision group actually collapse? A shared strong
// key (url|titleSignature|start_date, or source-scoped external_ref) is normally a
// deterministic duplicate. The one EXCEPTION the constitution forces (recurring
// occurrences are NOT duplicates): a SAME-SOURCE group whose title carries no
// identity content (signature === "untitled"). Such a group keyed on a shared url +
// date — with no distinguishing title — would fuse genuinely distinct occurrences,
// so it is RELEASED to the fuzzy pass instead (where isMergeableGroup's ≥2-source
// guard protects it). Cross-source groups (≥2 distinct sources) always collapse —
// two independent sources emitting the same strong key is the strongest dup signal,
// and is exactly the legitimate cross-source merge (worldafisha+concerten) we keep.
export function isStrongCollapsible(group: DedupEvent[]): boolean {
  if (group.length < 2) return false;
  if (distinctSourceCount(group) >= 2) return true;
  // single-source: collapse only when the title is non-degenerate (a real re-fetch
  // of one identifiable listing), never on an "untitled" signature.
  return titleSignature(group[0]?.title) !== "untitled";
}

export function strongMatchPrePass(events: DedupEvent[]): {
  survivors: DedupEvent[];
  collapses: StrongCollapse[];
} {
  const groups = new Map<string, DedupEvent[]>();
  const order: Array<{ key: string | null; event: DedupEvent }> = [];
  for (const ev of events) {
    const key = strongMatchKey(ev);
    order.push({ key, event: ev });
    if (key == null) continue;
    const bucket = groups.get(key);
    if (bucket) bucket.push(ev);
    else groups.set(key, [ev]);
  }

  const repFor = new Map<string, DedupEvent>();
  const collapses: StrongCollapse[] = [];
  // Strong keys that must NOT collapse (degenerate — see isStrongCollapsible):
  // their members are released to the fuzzy pass as individual passthroughs, so
  // a degenerate url+date group (e.g. untitled, single-source) never fuses.
  const released = new Set<string>();
  for (const [key, members] of groups) {
    if (members.length < 2) {
      repFor.set(key, members[0]);
      continue;
    }
    if (!isStrongCollapsible(members)) {
      released.add(key);
      continue;
    }
    const { survivor, losers } = mergeGroup(members);
    repFor.set(key, survivor);
    for (const loser of losers) collapses.push({ loser, survivorId: survivor.id ?? null });
  }

  // Rebuild the list in original order: emit each strong-key group's survivor once
  // (at the position of its first member), pass key-less events through unchanged.
  // Members of a RELEASED degenerate group are emitted individually (each kept).
  const emitted = new Set<string>();
  const survivors: DedupEvent[] = [];
  for (const { key, event } of order) {
    if (key == null || released.has(key)) {
      survivors.push(event);
      continue;
    }
    if (emitted.has(key)) continue;
    emitted.add(key);
    survivors.push(repFor.get(key) ?? event);
  }
  return { survivors, collapses };
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

// PURE: count distinct non-empty source keys in a candidate group.
export function distinctSourceCount(group: DedupEvent[]): number {
  const seen = new Set<string>();
  for (const ev of group) {
    if (typeof ev.source === "string" && ev.source) seen.add(ev.source);
  }
  return seen.size;
}

// PURE: is this dedupKey cluster eligible to MERGE? Two guards kill the over-merges
// seen on real data (a diagnostic run collapsed 75 events into 11):
//   1. Degenerate signature ("untitled" — the title had no transliterable/slug-able
//      content) → never merge; it would fuse unrelated events.
//   2. Cross-source requirement: a genuine duplicate is reported by ≥2 DISTINCT
//      sources. Same-source rows sharing a signature on nearby dates are recurring
//      occurrences (e.g. a daily show) — owned by the series model (sub-area D),
//      NOT duplicates.
export function isMergeableGroup(group: DedupEvent[]): boolean {
  if (group.length < 2) return false;
  if (titleSignature(group[0]?.title) === "untitled") return false;
  return distinctSourceCount(group) >= 2;
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

// ===================== T033 provenance: entity_sources rows =====================
// Constitution non-negotiable: "dedup keeps a link to every source via
// `entity_sources`". After a group resolves to ONE survivor, we record one
// contributor row per member that carries a source_item_id — so the survivor's
// provenance (every raw `source_items` row that fed it) stays queryable even
// though the losers are soft-collapsed to status='duplicate'.

// One contributor row destined for the entity_sources table. Pure data — the
// orchestrator turns each into an idempotent UPSERT (guarded by an FK existence
// check on source_item_id).
export interface EntitySourceRow {
  entity_type: "event";
  entity_id: number; // survivor events.id
  source_item_id: number; // member's raw source_items.id
  source_key: string | null;
  source_url: string | null;
  role: "primary" | "duplicate";
  match_method: string; // 'self' | 'strong' | 'fuzzy'
  match_score: number | null;
}

// PURE: build the entity_sources rows for one resolved merge. `survivor` must
// carry a numeric id; `members` is the FULL contributing group (survivor +
// losers). Emits ONE row per member that HAS a numeric source_item_id — the
// survivor as role='primary', every other member as role='duplicate'. Members
// without a source_item_id (seed-only events) are SKIPPED silently. De-dups on
// source_item_id (a member appearing twice yields one row). The FK existence
// guard lives in the orchestrator (this stays DB-free + unit-testable).
export function entitySourceRows(
  survivor: DedupEvent,
  members: DedupEvent[],
  matchMethod: string,
): EntitySourceRow[] {
  const entityId = survivor.id;
  if (entityId == null) return [];
  const out: EntitySourceRow[] = [];
  const seen = new Set<number>();
  for (const m of members) {
    const sid = typeof m.source_item_id === "number" ? m.source_item_id : null;
    if (sid == null || seen.has(sid)) continue;
    seen.add(sid);
    const isSurvivor = m.id != null && m.id === entityId;
    out.push({
      entity_type: "event",
      entity_id: entityId,
      source_item_id: sid,
      source_key: typeof m.source === "string" && m.source ? m.source : null,
      source_url: typeof m.source_url === "string" && m.source_url ? m.source_url : null,
      role: isSurvivor ? "primary" : "duplicate",
      match_method: isSurvivor ? "self" : matchMethod,
      match_score: typeof m.match_score === "number" ? m.match_score : null,
    });
  }
  return out;
}

// Persist one entity_sources row, idempotently + FK-safe. The WHERE EXISTS guard
// makes the INSERT a no-op when the referenced source_items row is absent
// (dangling id) — so a seed/offline event whose source_item_id points at nothing
// never raises an FK violation; it is simply skipped. ON CONFLICT keeps the row
// idempotent across re-runs and promotes role/method/score if a later pass has a
// stronger signal.
async function writeEntitySource(row: EntitySourceRow, ts: string, exec: typeof sql): Promise<void> {
  await exec`
    INSERT INTO entity_sources
      (entity_type, entity_id, source_item_id, source_key, source_url, role, match_method, match_score, created_at)
    SELECT ${row.entity_type}, ${row.entity_id}, ${row.source_item_id}, ${row.source_key},
           ${row.source_url}, ${row.role}, ${row.match_method}, ${row.match_score}, ${ts}
    WHERE EXISTS (SELECT 1 FROM source_items WHERE id = ${row.source_item_id})
    ON CONFLICT (entity_type, entity_id, source_item_id) DO UPDATE
      SET role = EXCLUDED.role, match_method = EXCLUDED.match_method, match_score = EXCLUDED.match_score`;
}

export interface DedupResult {
  groups: number;
  merged: number;
  collapsed: number;
  provenanceRows: number;
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

  const ts = nowIso();
  let merged = 0;
  let collapsed = 0;
  let provenanceRows = 0;

  // T033: write the survivor's entity_sources provenance for one resolved group.
  // PURE entitySourceRows() builds the rows (survivor='primary', losers='duplicate',
  // members without a source_item_id skipped); writeEntitySource() then UPSERTs each
  // behind an FK-existence guard, so dangling/seed-only ids are skipped silently.
  const persistProvenance = async (
    survivor: DedupEvent,
    members: DedupEvent[],
    matchMethod: string,
  ) => {
    for (const row of entitySourceRows(survivor, members, matchMethod)) {
      await writeEntitySource(row, ts, exec);
      provenanceRows++;
    }
  };

  // T035 strong-match pre-pass: deterministically collapse exact-equal url /
  // (source, external_ref) rows FIRST, then run the fuzzy title/date pass on the
  // reduced survivor set. Strong survivors carry every collapsed source link.
  const { survivors, collapses } = strongMatchPrePass(rows);
  for (const { loser, survivorId } of collapses) {
    await exec`UPDATE events
      SET status = 'duplicate', metadata_json = ${mergeLoserMetadata(loser, survivorId)}, last_seen = ${ts}
      WHERE id = ${loser.id ?? null}`;
    collapsed++;
  }
  // Persist strong survivors' accumulated metadata_json.sources[] before fuzzy,
  // plus the entity_sources provenance for each strong-collapsed survivor (its
  // own row + one per collapsed loser that carries a source_item_id).
  for (const ev of survivors) {
    if (ev.id == null) continue;
    const groupCollapses = collapses.filter((c) => c.survivorId === ev.id);
    if (groupCollapses.length) {
      await exec`UPDATE events
        SET metadata_json = ${ev.metadata_json ?? null}, last_seen = ${ts}
        WHERE id = ${ev.id}`;
      merged++;
      await persistProvenance(ev, [ev, ...groupCollapses.map((c) => c.loser)], "strong");
    }
  }

  const groups = groupByKey(survivors);

  for (const members of groups.values()) {
    if (!isMergeableGroup(members)) continue;
    const { survivor, losers } = mergeGroup(members);
    merged++;

    await exec`UPDATE events
      SET metadata_json = ${survivor.metadata_json}, last_seen = ${ts}
      WHERE id = ${survivor.id ?? null}`;

    for (const loser of losers) {
      // Convention (research R2): losers carry status='duplicate' + merged_into
      // (matches the seed/render path + the 90 existing seed rows); the survivor
      // keeps metadata_json.sources[] for attribution. The loader's
      // status='upcoming' filter then excludes these on re-run (idempotent).
      await exec`UPDATE events
        SET status = 'duplicate', metadata_json = ${mergeLoserMetadata(loser, survivor.id ?? null)}, last_seen = ${ts}
        WHERE id = ${loser.id ?? null}`;
      collapsed++;
    }
    // T033 provenance: survivor + every fuzzy-merged loser (each with a
    // source_item_id) → one entity_sources row apiece, FK-guarded + idempotent.
    await persistProvenance(survivor, members, "fuzzy");
  }

  return { groups: groups.size, merged, collapsed, provenanceRows };
}

// Record on a soft-collapsed loser which survivor it merged into. Pure helper.
function mergeLoserMetadata(loser: DedupEvent, survivorId: number | null): string {
  const metadata = parseMetadata(loser.metadata_json);
  metadata.merged_into = survivorId;
  return JSON.stringify(metadata);
}

// ===================== Places dedup primitives (sub-area C — T036/T037) =====================
// Pure, dependency-free building blocks (research C2/C3/C4). The DB orchestrator
// (writing status='duplicate'+merged_into and unioning recommended_by) lands with
// the place-mining task T064, once normalizers actually produce duplicate places;
// the seed's 14 places have no true duplicates. These predicates are what guarantee
// the must-NOT-merge cases (distinct venues stacked on a geocoder fallback centroid).

// PURE: Jaro-Winkler similarity in [0,1] (1 = identical). Gates place-NAME fuzzy
// matches; events use the token-signature path instead. ~standard implementation.
export function jaroWinkler(a: string, b: string): number {
  const s1 = a ?? "";
  const s2 = b ?? "";
  if (s1 === s2) return s1.length ? 1 : 0;
  if (!s1.length || !s2.length) return 0;
  const matchDist = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);
  const s1m = new Array(s1.length).fill(false);
  const s2m = new Array(s2.length).fill(false);
  let matches = 0;
  for (let i = 0; i < s1.length; i++) {
    const lo = Math.max(0, i - matchDist);
    const hi = Math.min(i + matchDist + 1, s2.length);
    for (let j = lo; j < hi; j++) {
      if (s2m[j] || s1[i] !== s2[j]) continue;
      s1m[i] = true;
      s2m[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1m[i]) continue;
    while (!s2m[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  transpositions /= 2;
  const m = matches;
  const jaro = (m / s1.length + m / s2.length + (m - transpositions) / m) / 3;
  let prefix = 0;
  const maxPrefix = Math.min(4, s1.length, s2.length);
  for (let i = 0; i < maxPrefix; i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

// PURE: great-circle distance in metres between two lat/lng points (haversine).
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Geocoder fallback centroids where DISTINCT entities pile up when geocoding fails.
// Coordinates at (≈) these points must NEVER vote in a merge. [lat, lng].
export const CENTROID_BLACKLIST: ReadonlyArray<readonly [number, number]> = [
  [40.4168, -3.7035], // Madrid, Puerta del Sol — Nominatim "Spain"/"Madrid" fallback
  [39.4697065, -0.3763353], // València generic-centre fallback (seed places 4/7/8)
];

// PURE: is a coordinate at (~60 m of) a blacklisted fallback centroid?
export function isCentroid(lat?: number | null, lng?: number | null): boolean {
  if (lat == null || lng == null) return false;
  return CENTROID_BLACKLIST.some(([clat, clng]) => haversineMeters(lat, lng, clat, clng) <= 60);
}

const GEO_CORROBORATION_M = 100;

export interface GeoPoint {
  lat?: number | null;
  lng?: number | null;
  geo_source?: string | null;
}

// PURE: may geographic proximity CORROBORATE that two places are the same? Geo NEVER
// merges alone — this only adds a signal, and ONLY when both points are real venue
// pins (geo_source='map_url'), neither sits on a blacklisted centroid, and they are
// within ~100 m. 'nominatim'/area-fallback coords (all the seed places) never vote.
export function geoCorroborates(a: GeoPoint, b: GeoPoint, radiusM = GEO_CORROBORATION_M): boolean {
  if (a.geo_source !== "map_url" || b.geo_source !== "map_url") return false;
  if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return false;
  if (isCentroid(a.lat, a.lng) || isCentroid(b.lat, b.lng)) return false;
  return haversineMeters(a.lat, a.lng, b.lat, b.lng) <= radiusM;
}

// A candidate place row for dedup (loose by design, like DedupEvent).
export interface DedupPlace {
  id?: number | null;
  name?: string | null;
  area?: string | null;
  district?: string | null;
  category?: string | null;
  lat?: number | null;
  lng?: number | null;
  geo_source?: string | null;
  maps_url?: string | null;
  external_ref?: string | null;
  source?: string | null;
  [key: string]: unknown;
}

const PLACE_NAME_TAU = 0.9;

function normName(name?: string | null): string {
  return slugify(transliterate(name));
}

// PURE: place blocking key — name signature + area/district + category. Mirrors the
// events dedupKey idea (reuses the translit token signature for the name).
export function placeKey(p: DedupPlace): string {
  const sig = titleSignature(p.name);
  const area = slugify(p.area || p.district) || "unknown";
  const cat = slugify(p.category) || "unknown";
  return `${sig}|${area}|${cat}`;
}

// PURE: are two places the same real-world venue? (research C2.)
//   STRONG: identical maps_url, or identical (source, external_id) → yes.
//   FUZZY:  same placeKey AND Jaro-Winkler(name) >= tau AND >=1 corroborating signal
//           beyond the name — a DIFFERENT source (cross-source) OR geoCorroborates
//           (map_url pins within ~100 m, centroid-guarded). Geo never merges alone.
export function arePlacesDuplicate(a: DedupPlace, b: DedupPlace, tau = PLACE_NAME_TAU): boolean {
  if (a === b) return false;
  const am = (a.maps_url || "").trim().toLowerCase();
  const bm = (b.maps_url || "").trim().toLowerCase();
  if (am && bm && am === bm) return true;
  if (a.external_ref && b.external_ref && a.source && a.source === b.source && a.external_ref === b.external_ref) {
    return true;
  }
  if (placeKey(a) !== placeKey(b)) return false;
  if (jaroWinkler(normName(a.name), normName(b.name)) < tau) return false;
  const crossSource = !!(a.source && b.source && a.source !== b.source);
  return crossSource || geoCorroborates(a, b);
}
