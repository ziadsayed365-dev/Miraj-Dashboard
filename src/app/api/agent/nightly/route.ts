import { NextRequest, NextResponse } from "next/server";
import { askOrReport } from "@/lib/agent/requests";
import { egyptToday, addDays } from "@/lib/dates";

// Long enough to render the report PDF when nothing is missing.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

// AI MIRAJ's nightly step, run by the agent right after its sync: ask on
// Telegram for everything the report is waiting on (one message per item), or,
// when nothing is, send the report. ?day=YYYY-MM-DD picks the day; default is
// yesterday in Egypt time.
export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const dayParam = request.nextUrl.searchParams.get("day");
  const day = dayParam && /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam : addDays(egyptToday(), -1);
  try {
    return NextResponse.json({ ok: true, day, ...(await askOrReport(day, request.nextUrl.origin)) });
  } catch (err) {
    return NextResponse.json({ ok: false, day, error: err instanceof Error ? err.message : "failed" }, { status: 500 });
  }
}
