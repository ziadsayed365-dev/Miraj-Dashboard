import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { REPORT_CACHE_TAG } from "@/lib/reports/cache";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const role = verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);
  if (role !== "owner") return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 403 });

  let body: { month?: string; account?: string; amount?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid body" }, { status: 400 });
  }

  const month = String(body.month ?? "").slice(0, 7); // YYYY-MM
  const account = String(body.account ?? "");
  const amount = Number(body.amount);
  if (!/^\d{4}-\d{2}$/.test(month) || !account || !Number.isFinite(amount)) {
    return NextResponse.json({ ok: false, error: "bad params" }, { status: 400 });
  }

  const { error } = await supabase
    .from("monthly_manual_expenses")
    .upsert({ month: `${month}-01`, account, amount, updated_at: new Date().toISOString() }, { onConflict: "month,account" });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  // The figures behind the Income Statement just changed - drop the cached
  // reports so the next page load rebuilds with this in it.
  revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

  return NextResponse.json({ ok: true });
}
