import { NextRequest, NextResponse } from "next/server";
import { runNightlyAudit } from "@/lib/reports/nightly-audit";
import { egyptToday, addDays } from "@/lib/dates";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// AI MIRAJ's nightly check, run right after its sync. ?day=YYYY-MM-DD picks
// the day to report on; default is yesterday in Egypt time, the day the nightly
// PDF covers.
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ ok: false, error: "CRON_SECRET not configured" }, { status: 403 });
  }
  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const dayParam = request.nextUrl.searchParams.get("day");
  const day = dayParam && /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam : addDays(egyptToday(), -1);

  try {
    return NextResponse.json(await runNightlyAudit(day));
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "audit failed" }, { status: 500 });
  }
}
