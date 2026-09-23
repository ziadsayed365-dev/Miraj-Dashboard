import { NextRequest, NextResponse } from "next/server";
import { finalizeMonthlyRates } from "@/lib/engine/monthly-rate";
import { dropReportCache } from "@/lib/reports/cache";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ ok: false, error: "CRON_SECRET not configured" }, { status: 403 });
  }
  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const result = await finalizeMonthlyRates();
  // The open month's revenue, COGS and Bosta Penalty are all projected from
  // this rate, so a new one changes every figure on the page.
  if (result.ok) dropReportCache();
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
