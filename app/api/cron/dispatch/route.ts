import { NextRequest, NextResponse } from "next/server";
import { dispatch } from "@/lib/pipeline/dispatcher";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Adaptive ingest dispatcher tick (sub-area A; research A6). The GitHub Actions
// scheduler POSTs here every */15 minutes; per-source cadence does the fine
// throttling so only DUE sources are actually fetched. FAIL-CLOSED (Constitution V,
// mirrors /api/cron/digest): a configured CRON_SECRET + matching Bearer is REQUIRED.
//
//   POST /api/cron/dispatch        → poll only sources whose cadence says due
//   POST /api/cron/dispatch?force=1 → poll ALL enabled sources (still updates cadence)
//
// T198: the tick MATERIALIZES events, not just raw rows (a month of ingest-only
// prod = 5406 pending source_items, 0 events). After ingest it normalizes the
// just-ingested sources, dedups, and scores+tags — fail-soft, under a ~45s soft
// budget (headroom below maxDuration=60); geo/enrich stay OUT of the tick
// (Nominatim latency / AI-less prod, T162). DISPATCH_INGEST_ONLY=1 restores the
// old ingest-only behavior.
//
// GET is accepted too (same fail-closed auth): VERCEL CRON invokes cron paths with a
// GET carrying "Authorization: Bearer <CRON_SECRET>" — without this the daily
// vercel.json cron got a 405 and never ran (found at launch, 2026-07-05).
export async function GET(req: NextRequest) {
  return POST(req);
}

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";

  try {
    const result = await dispatch({ force });
    return NextResponse.json({
      ok: true,
      total: result.total,
      ok_count: result.okCount,
      error: result.error,
      items: result.items,
      // T198 materialization summary (null when DISPATCH_INGEST_ONLY=1).
      ingest_only: result.ingestOnly,
      normalize: result.materialize?.normalize ?? null,
      dedup: result.materialize?.dedup ?? null,
      score: result.materialize?.score ?? null,
      tag: result.materialize?.tag ?? null,
      stage_errors: result.materialize?.errors ?? null,
      budget: result.budget,
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}
