import { NextRequest, NextResponse } from "next/server";
import { askOrReport, sendTestRequests, followUp } from "@/lib/agent/requests";
import { renderReportPdf } from "@/lib/report-pdf";
import { egyptToday, addDays } from "@/lib/dates";

// Long enough to render the report PDF when nothing is missing.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

// AI MIRAJ's nightly step, run by the agent right after its sync: ask on
// Telegram for everything the report is waiting on (one message per item), or,
// when nothing is, send the report. ?day=YYYY-MM-DD picks the day; default is
// yesterday in Egypt time. ?test=1 sends one test question of each kind
// instead, answered like real ones but saving nothing. ?pdf=1 returns the
// day's report PDF and sends nothing; ?send=1 sends the report on Telegram now,
// as "pdf" in the chat does.
export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const dayParam = request.nextUrl.searchParams.get("day");
  const day = dayParam && /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam : addDays(egyptToday(), -1);
  const origin = request.nextUrl.origin;
  try {
    if (request.nextUrl.searchParams.get("pdf") === "1") {
      const pdf = await renderReportPdf(origin, day);
      return new NextResponse(new Uint8Array(pdf), { headers: { "content-type": "application/pdf" } });
    }
    if (request.nextUrl.searchParams.get("send") === "1") {
      await followUp({ day, recomputeMargins: false, pdf: true }, origin);
      return NextResponse.json({ ok: true, day, sent: true });
    }
    if (request.nextUrl.searchParams.get("test") === "1") {
      return NextResponse.json({ ok: true, day, test: true, ...(await sendTestRequests(day)) });
    }
    return NextResponse.json({ ok: true, day, ...(await askOrReport(day, request.nextUrl.origin)) });
  } catch (err) {
    return NextResponse.json({ ok: false, day, error: err instanceof Error ? err.message : "failed" }, { status: 500 });
  }
}
