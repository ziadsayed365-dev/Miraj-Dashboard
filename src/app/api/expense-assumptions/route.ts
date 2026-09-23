import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { REPORT_CACHE_TAG } from "@/lib/reports/cache";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { setExpenseAssumption } from "@/lib/reports/expenses-ledger";

export const dynamic = "force-dynamic";

// Set one expense account's monthly assumption (used for the open calendar month).
export async function POST(request: NextRequest) {
  const role = verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);
  if (role !== "owner") return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 403 });

  const body = await request.json();
  const { accountId, monthlyAmount } = body;
  if (typeof accountId !== "number" || typeof monthlyAmount !== "number") {
    return NextResponse.json({ ok: false, error: "Invalid input" }, { status: 400 });
  }

  try {
    await setExpenseAssumption(accountId, monthlyAmount);
    // The figures behind the Income Statement just changed - drop the cached
    // reports so the next page load rebuilds with this in it.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}
