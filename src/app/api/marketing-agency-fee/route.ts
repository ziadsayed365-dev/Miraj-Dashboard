import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { REPORT_CACHE_TAG } from "@/lib/reports/cache";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { setMarketingAgencyFeeMonthly } from "@/lib/reports/marketing-agency-fee";

export const dynamic = "force-dynamic";

// Set the flat monthly marketing-agency fee (applied from 2026-10-19 on, at
// amount / 30 per day).
export async function POST(request: NextRequest) {
  const role = verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);
  if (role !== "owner") return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 403 });

  const body = await request.json();
  const { monthlyAmount } = body;
  if (typeof monthlyAmount !== "number") {
    return NextResponse.json({ ok: false, error: "Invalid input" }, { status: 400 });
  }

  try {
    await setMarketingAgencyFeeMonthly(monthlyAmount);
    // The figures behind the Income Statement just changed - drop the cached
    // reports so the next page load rebuilds with this in it.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}
