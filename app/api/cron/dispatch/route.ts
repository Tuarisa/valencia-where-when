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
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}
