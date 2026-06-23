import { NextRequest, NextResponse } from "next/server";
import { buildDigest, sendDigest, markEventsNotified, markPlacesNotified, markSeriesNotified } from "@/lib/pipeline/notify";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Weekly digest + rare-alert dispatch (sub-area G; contracts/pipeline-and-endpoints).
// Synchronous version (the Vercel Workflow wrapper is T022); the GitHub Actions
// scheduler POSTs here. FAIL-CLOSED (Constitution V / convergence T052): a configured
// CRON_SECRET + matching Bearer is REQUIRED — unlike the legacy /refresh optional guard.
//
//   POST /api/cron/digest?mode=weekly|alert[&dry=1]
//
// ?dry=1 builds + returns the digest without writing. Otherwise it sends via the
// pluggable sender (default = dry-run, delivers nothing) and marks notified ONLY when
// the transport actually delivered — so nothing is consumed until a real transport is
// configured (and SC-002 "no repeats" holds once it is).
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") === "alert" ? "alert" : "weekly";
  const dry = url.searchParams.get("dry") === "1";
  // "today" in the household's timezone (en-CA formats as YYYY-MM-DD).
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date());

  try {
    const payload = await buildDigest({ today, mode });
    if (dry) {
      return NextResponse.json({
        ok: true, mode, dry: true,
        selected: payload.events.length, places: payload.places.length,
        text: payload.text,
      });
    }

    const send = await sendDigest(payload);
    let markedEvents = 0;
    let markedPlaces = 0;
    let markedSeries = 0;
    if (send.delivered) {
      markedEvents = await markEventsNotified(payload.events.map((e) => e.id), { channel: send.transport });
      markedPlaces = await markPlacesNotified(payload.places.map((p) => p.id), { channel: send.transport });
      // Series are one card per run keyed on series_id (SC-002) — they were built into the
      // digest (payload.series) but never marked, so a real transport would repeat them
      // every week. Mark them too (F5, code-review finding).
      markedSeries = await markSeriesNotified(payload.series.map((s) => s.id), { channel: send.transport });
    }
    return NextResponse.json({
      ok: true, mode,
      selected: payload.events.length, places: payload.places.length, series: payload.series.length,
      delivered: send.delivered, transport: send.transport,
      markedEvents, markedPlaces, markedSeries,
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}
