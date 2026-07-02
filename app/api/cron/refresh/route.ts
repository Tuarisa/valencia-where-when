import { NextRequest, NextResponse } from "next/server";
import { runPipeline } from "@/lib/pipeline/run";

export const dynamic = "force-dynamic";
// 60s = the Vercel HOBBY plan ceiling (T192): a higher value FAILS the deploy on Hobby
// ("maxDuration exceeds plan limit"). The full pipeline can exceed 60s — that's fine:
// the LIVE refresh path is the adaptive /api/cron/dispatch (also 60s, polls only due
// sources), while this legacy full-refresh route is for manual/Pro use. On Pro, bump
// back to 300 if a synchronous full run is wanted.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  // Vercel Cron sends "Authorization: Bearer <CRON_SECRET>" when CRON_SECRET is set.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  try {
    const result = await runPipeline();
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}
