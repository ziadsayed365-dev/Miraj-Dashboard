import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { REPORT_CACHE_TAG } from "@/lib/reports/cache";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { flagOrderAsMovers, unflagMoversOrders } from "@/lib/movers/orders";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const role = verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);
  if (!role) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { orderNumber, date } = body;
  if (typeof orderNumber !== "string" || !orderNumber.trim()) {
    return NextResponse.json({ ok: false, error: "Order number is required" }, { status: 400 });
  }

  try {
    const order = await flagOrderAsMovers(orderNumber, typeof date === "string" && date ? date : undefined);
    // The figures behind the Income Statement just changed - drop the cached
    // reports so the next page load rebuilds with this in it.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true, order });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const role = verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);
  if (!role) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isFinite) : [];
  if (ids.length === 0) {
    return NextResponse.json({ ok: false, error: "No ids provided" }, { status: 400 });
  }

  try {
    await unflagMoversOrders(ids);
    // The figures behind the Income Statement just changed - drop the cached
    // reports so the next page load rebuilds with this in it.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}
