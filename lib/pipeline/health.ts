// Production verification / health-check logic (sub-area I, T138) — PURE module: no
// DB, no network, no clock except the now passed in. The /api/health route reads
// read-only aggregates from the DB and delegates the *decisions* (is a source stale?
// is the pipeline cold?) to these pure functions so they are unit-testable without a
// database. Keep all the time math here, parameterized on nowMs/nowIso.

// Default grace + thresholds (seconds). A source's next_due_at can slip a little
// behind a cron tick before we call it stale; fail_count and an errored last run are
// independent stale signals.
export const DEFAULT_STALE_GRACE_SEC = 6 * 3600; // 6h slack past next_due_at
export const DEFAULT_FAIL_COUNT_LIMIT = 5; // consecutive failures → stale
// A pipeline that hasn't had ANY successful source run in this window is "cold" and
// makes the whole health check fail (ok=false / HTTP 503).
export const DEFAULT_PIPELINE_COLD_SEC = 48 * 3600; // 48h

export interface StaleOpts {
  graceSec?: number;
  failCountLimit?: number;
}

export interface StaleSource {
  enabled?: number | boolean | null;
  next_due_at?: string | null;
  fail_count?: number | null;
  // Last run status for this source ('ok' | 'error' | null) — supplied by the route
  // from the most recent source_runs row.
  last_status?: string | null;
}

export interface StaleResult {
  stale: boolean;
  reason: string | null;
}

// Parse an ISO timestamp to epoch ms, tolerating the ms-stripped form (…Z) used by
// nowIso(). Returns null for null/empty/unparseable input.
export function isoToMs(iso?: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

// Is a single source stale? Stale ⇔ it is enabled AND any of:
//   • its next_due_at is in the past by more than the grace window (overdue), OR
//   • its consecutive fail_count has reached the limit, OR
//   • its most recent run errored.
// Disabled sources are NEVER stale (they're intentionally off). Pure: `nowIso` is the
// reference clock; ISO strings compare in UTC.
export function sourceStale(
  source: StaleSource,
  nowIso: string,
  opts: StaleOpts = {},
): StaleResult {
  const graceSec = opts.graceSec ?? DEFAULT_STALE_GRACE_SEC;
  const failLimit = opts.failCountLimit ?? DEFAULT_FAIL_COUNT_LIMIT;

  const enabled = source.enabled === 1 || source.enabled === true;
  if (!enabled) return { stale: false, reason: null };

  // Errored last run is the strongest signal — surface it first.
  if ((source.last_status || "").toLowerCase() === "error") {
    return { stale: true, reason: "last run errored" };
  }

  const failCount = source.fail_count ?? 0;
  if (failCount >= failLimit) {
    return { stale: true, reason: `fail_count ${failCount} ≥ ${failLimit}` };
  }

  const dueMs = isoToMs(source.next_due_at);
  const nowMs = isoToMs(nowIso);
  if (dueMs != null && nowMs != null) {
    const overdueSec = (nowMs - dueMs) / 1000;
    if (overdueSec > graceSec) {
      const overdueH = Math.round((overdueSec / 3600) * 10) / 10;
      return { stale: true, reason: `overdue ${overdueH}h past next_due_at` };
    }
  }

  return { stale: false, reason: null };
}

export interface WarningInput {
  // ISO of the most recent SUCCESSFUL pipeline/source run (null = never).
  lastSuccessIso?: string | null;
  // Count of upcoming events currently rendered on the site.
  upcomingCount: number;
  nowIso: string;
  coldSec?: number;
}

// Hard pipeline warnings (any one ⇒ ok=false / HTTP 503). Returns a list of
// human-readable strings (empty = healthy). Pure: clock is `nowIso`.
//   • no successful pipeline run in the cold window (default 48h), or never ran
//   • zero upcoming events (the site would render empty)
// NOTE: enrich staleness is deliberately NOT here — on Vercel serverless the default
// enrich engine (`claude -p`, a subscription CLI) is absent, so enrich legitimately
// may not run in prod. The route surfaces that as an INFO warning, never a hard fail.
export function pipelineWarnings(input: WarningInput): string[] {
  const coldSec = input.coldSec ?? DEFAULT_PIPELINE_COLD_SEC;
  const out: string[] = [];

  const lastMs = isoToMs(input.lastSuccessIso);
  const nowMs = isoToMs(input.nowIso);
  if (lastMs == null) {
    // NEVER ran (source_runs empty) is INFO, not a hard fail (T143): a freshly-seeded
    // DB renders fine from the seed and simply hasn't had a pipeline tick yet. If the DB
    // is ALSO empty the "0 upcoming events" HARD warning below fires and flips ok=false,
    // so a truly-broken deploy is still caught. A run that DID happen but went STALE
    // (>coldSec) stays HARD — that's the real "pipeline died on prod" signal. The route
    // treats any "(info)"-suffixed warning as non-hard.
    out.push("no pipeline run yet (info)");
  } else if (nowMs != null && (nowMs - lastMs) / 1000 > coldSec) {
    const ageH = Math.round(((nowMs - lastMs) / 3600000) * 10) / 10;
    const limitH = Math.round(coldSec / 3600);
    out.push(`no successful pipeline run in ${limitH}h (last ${ageH}h ago)`);
  }

  if (!input.upcomingCount || input.upcomingCount <= 0) {
    out.push("0 upcoming events");
  }

  return out;
}

// Is enrichment stalled? INFO-only (see route). Stalled when nothing has been enriched
// within the window (default 14 days) or nothing has ever been enriched while there
// are events to enrich. Pure: clock is `nowIso`.
export const DEFAULT_ENRICH_STALE_SEC = 14 * 24 * 3600;

export function enrichStalled(args: {
  lastEnrichedIso?: string | null;
  hasEvents: boolean;
  nowIso: string;
  staleSec?: number;
}): boolean {
  if (!args.hasEvents) return false;
  const staleSec = args.staleSec ?? DEFAULT_ENRICH_STALE_SEC;
  const lastMs = isoToMs(args.lastEnrichedIso);
  const nowMs = isoToMs(args.nowIso);
  if (lastMs == null) return true; // events exist but nothing ever enriched
  if (nowMs == null) return false;
  return (nowMs - lastMs) / 1000 > staleSec;
}
