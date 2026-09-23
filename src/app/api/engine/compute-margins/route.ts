import { NextRequest, NextResponse } from "next/server";
import { computeMargins } from "@/lib/engine/margin";
import { dropReportCache } from "@/lib/reports/cache";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// The daily cron calls this with no query params (default 60-day window). Pass
// ?since=YYYY-MM-DD to recompute from a specific date, or ?since=all for a full
// historical rebuild (e.g. after entering product costs). Owner-triggered
// full rebuilds are safe: computeMargins is idempotent.
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ ok: false, error: "CRON_SECRET not configured" }, { status: 403 });
  }
  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const since = request.nextUrl.searchParams.get("since");
  const opts = since ? { sinceDay: since === "all" ? null : since } : undefined;
  const result = await computeMargins(opts);
  // Every reported figure is derived from the margins this just rewrote, so the
  // cached reports are now wrong by definition.
  if (result.ok) dropReportCache();
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
