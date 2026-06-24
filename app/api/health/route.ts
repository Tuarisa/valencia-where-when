import { NextResponse } from "next/server";
import { sql, nowIso } from "@/lib/db";
import {
  sourceStale,
  pipelineWarnings,
  enrichStalled,
  type StaleSource,
} from "@/lib/pipeline/health";

export const dynamic = "force-dynamic";

// Production verification / health-check surface (sub-area I, T138).
//
//   GET /api/health
//
// PUBLIC (no Bearer): it returns ONLY non-sensitive AGGREGATES — row counts, run
// freshness timestamps, and stale-source flags. No event/place payloads, no secrets,
// no source URLs beyond the source key. READ-ONLY: every query is a SELECT; the route
// NEVER writes (no run logging, no cadence updates, no migrations).
//
// `ok` is false (HTTP 503) when a HARD warning fires: no successful pipeline run in
// 48h, 0 upcoming events, or a DB error. Otherwise 200.
//
// ENRICH staleness is INFO ONLY, never a hard fail: the default enrich engine is
// `claude -p` (a Claude *subscription* CLI) which is ABSENT on Vercel serverless, so
// prod enrich legitimately may not run there (it must use the SDK path or run
// off-prod). We surface "enrich stalled" as a warning so the site stays green.
export async function GET() {
  const now = nowIso();

  try {
    // All read-only aggregates, issued in parallel.
    const [
      countsRows,
      sourcesRows,
      lastSourceRunRows,
      lastDigestRows,
      enrichRows,
      lastStatusRows,
    ] = await Promise.all([
      // Aggregate counts (no payloads).
      sql`
        SELECT
          (SELECT COUNT(*) FROM events
             WHERE (status = 'upcoming' OR status IS NULL)) AS events_upcoming,
          (SELECT COUNT(*) FROM event_series
             WHERE (status = 'upcoming' OR status IS NULL)) AS series,
          (SELECT COUNT(*) FROM event_occurrences
             WHERE (status = 'upcoming' OR status IS NULL)) AS occurrences,
          (SELECT COUNT(*) FROM places) AS places,
          (SELECT COUNT(*) FROM places WHERE lat IS NOT NULL AND lng IS NOT NULL)
            AS mapped_places
      ` as Promise<Record<string, any>[]>,

      // Per-source state + its most recent run's status (LATERAL = read-only join).
      sql`
        SELECT s.key, s.enabled, s.next_due_at, s.fail_count,
               r.status AS last_status, r.finished_at AS last_finished_at
        FROM sources s
        LEFT JOIN LATERAL (
          SELECT status, finished_at
          FROM source_runs sr
          WHERE sr.source_key = s.key
          ORDER BY sr.started_at DESC
          LIMIT 1
        ) r ON TRUE
        ORDER BY s.key
      ` as Promise<Record<string, any>[]>,

      // Most recent SUCCESSFUL source run (any source) — the "pipeline ran" signal.
      sql`
        SELECT MAX(finished_at) AS last_ok_finished
        FROM source_runs
        WHERE status = 'ok' AND finished_at IS NOT NULL
      ` as Promise<Record<string, any>[]>,

      // Most recent digest/notification dispatch.
      sql`SELECT MAX(sent_at) AS last_sent FROM notifications` as Promise<
        Record<string, any>[]
      >,

      // Enrichment freshness across events + series.
      sql`
        SELECT GREATEST(
          (SELECT MAX(enriched_at) FROM events),
          (SELECT MAX(enriched_at) FROM event_series)
        ) AS last_enriched_at
      ` as Promise<Record<string, any>[]>,

      // Most recent run of ANY status (ingest_any freshness).
      sql`
        SELECT MAX(finished_at) AS last_finished
        FROM source_runs
        WHERE finished_at IS NOT NULL
      ` as Promise<Record<string, any>[]>,
    ]);

    const c = countsRows[0] || {};
    const counts = {
      events_upcoming: Number(c.events_upcoming || 0),
      series: Number(c.series || 0),
      occurrences: Number(c.occurrences || 0),
      places: Number(c.places || 0),
      mapped_places: Number(c.mapped_places || 0),
    };

    // Source staleness via the pure helper.
    const stale: Array<{
      key: string;
      last_finished_at: string | null;
      last_status: string | null;
      reason: string;
    }> = [];
    let enabledCount = 0;
    for (const row of sourcesRows) {
      const enabled = row.enabled === 1 || row.enabled === true;
      if (enabled) enabledCount++;
      const s: StaleSource = {
        enabled: row.enabled,
        next_due_at: row.next_due_at ?? null,
        fail_count: row.fail_count ?? null,
        last_status: row.last_status ?? null,
      };
      const res = sourceStale(s, now);
      if (res.stale) {
        stale.push({
          key: row.key,
          last_finished_at: row.last_finished_at ?? null,
          last_status: row.last_status ?? null,
          reason: res.reason || "stale",
        });
      }
    }

    const lastOk: string | null = lastSourceRunRows[0]?.last_ok_finished ?? null;
    const lastAny: string | null = lastStatusRows[0]?.last_finished ?? null;
    const lastDigest: string | null = lastDigestRows[0]?.last_sent ?? null;
    const lastEnriched: string | null = enrichRows[0]?.last_enriched_at ?? null;

    // dispatch/refresh aren't recorded as their own source_runs rows — both manifest
    // as per-source ingest runs. We surface the most recent successful run as the
    // freshness proxy for both, and the most recent run (any status) as ingest_any.
    const last_runs = {
      dispatch: lastOk,
      refresh: lastOk,
      digest: lastDigest,
      ingest_any: lastAny,
    };

    const warnings = pipelineWarnings({
      lastSuccessIso: lastOk,
      upcomingCount: counts.events_upcoming,
      nowIso: now,
    });

    const enrich = {
      last_enriched_at: lastEnriched,
      stalled: enrichStalled({
        lastEnrichedIso: lastEnriched,
        hasEvents: counts.events_upcoming > 0 || counts.series > 0,
        nowIso: now,
      }),
    };
    // INFO-only — does NOT flip `ok`.
    if (enrich.stalled) warnings.push("enrich stalled (info)");

    // `ok` is driven by HARD warnings only. Any warning suffixed "(info)" is
    // informational and does NOT flip ok — currently "enrich stalled (info)" and the
    // seed-only "no pipeline run yet (info)" (T143).
    const hard = warnings.filter((w) => !w.endsWith("(info)"));
    const ok = hard.length === 0;

    return NextResponse.json(
      {
        ok,
        now,
        counts,
        sources: { total: sourcesRows.length, enabled: enabledCount, stale },
        last_runs,
        enrich,
        warnings,
      },
      { status: ok ? 200 : 503 },
    );
  } catch (err: any) {
    return NextResponse.json(
      {
        ok: false,
        now,
        error: String(err?.message || err),
        warnings: ["database error"],
      },
      { status: 503 },
    );
  }
}
