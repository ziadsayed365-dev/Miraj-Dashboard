import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { getProductDailyRollforward, type PerProductMode } from "@/lib/reports/per-product";
import { addDays } from "@/lib/dates";

export const dynamic = "force-dynamic";

const WINDOW = 7; // fixed 7 date columns

export async function GET(request: NextRequest) {
  const role = verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);
  if (!role) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const productId = Number(url.searchParams.get("productId"));
  if (!Number.isInteger(productId) || productId <= 0) {
    return NextResponse.json({ ok: false, error: "productId must be a positive integer" }, { status: 400 });
  }

  const to = url.searchParams.get("to") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return NextResponse.json({ ok: false, error: "to must be YYYY-MM-DD" }, { status: 400 });
  }

  const mode: PerProductMode = url.searchParams.get("mode") === "actual" ? "actual" : "performance";
  const from = addDays(to, -(WINDOW - 1));

  try {
    const { rows, deliveryRate, rateSourceMonth } = await getProductDailyRollforward(productId, from, to, mode);
    return NextResponse.json({ ok: true, rows, deliveryRate, rateSourceMonth });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}
