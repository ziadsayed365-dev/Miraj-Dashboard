import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { REPORT_CACHE_TAG } from "@/lib/reports/cache";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { createAnalysisAccount } from "@/lib/reports/expenses-ledger";

export const dynamic = "force-dynamic";

// Create an owner-defined account, income or expense. Always shows in Expense
// Analysis; `inIncomeStatement` additionally gives it its own named line on the
// Income Statement. Defaults to false, so an account added without the flag
// cannot move Net Income.
export async function POST(request: NextRequest) {
  const role = verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);
  if (role !== "owner") {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 403 });
  }

  const body = await request.json();
  const name = typeof body.name === "string" ? body.name : "";
  const kind = body.kind === "income" ? "income" : "expense";
  const inIncomeStatement = body.inIncomeStatement === true;

  try {
    const id = await createAnalysisAccount(name, kind, inIncomeStatement);
    // The figures behind the Income Statement just changed - drop the cached
    // reports so the next page load rebuilds with this in it.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true, id });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 400 });
  }
}
