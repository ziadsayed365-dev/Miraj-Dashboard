import { NextRequest, NextResponse } from "next/server";
import { dropReportCache } from "@/lib/reports/cache";
import { syncShopifyAttribution } from "@/lib/sync/shopify-attribution";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// GET /api/engine/backfill-attribution?from=2026-09-01&to=2026-09-07
//
// Reads which ad each order came from for a past window. The sync only re-reads
// the last few days, so history before the Campaigns P&L existed comes in
// through here - a week or so per call keeps it well inside the time limit.
// Writes nothing but the orders' utm_* / meta_* / attribution_synced_at columns.
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ ok: false, error: "CRON_SECRET not configured" }, { status: 403 });
  }
  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const from = request.nextUrl.searchParams.get("from");
  const to = request.nextUrl.searchParams.get("to");
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (!from || !to || !day.test(from) || !day.test(to) || from > to) {
    return NextResponse.json({ ok: false, error: "Pass from and to as YYYY-MM-DD, from <= to" }, { status: 400 });
  }

  const startedAt = Date.now();
  const result = await syncShopifyAttribution({ from, to });
  if (result.ok) dropReportCache();

  return NextResponse.json({ ...result, from, to, elapsedMs: Date.now() - startedAt }, { status: result.ok ? 200 : 500 });
}
