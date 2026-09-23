import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { REPORT_CACHE_TAG } from "@/lib/reports/cache";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { bulkRecordOrders, type ShippingCourier } from "@/lib/shipping/orders";

export const dynamic = "force-dynamic";

function parseCourier(value: unknown): ShippingCourier | null {
  return value === "movers" || value === "bosta" ? value : null;
}

export async function POST(request: NextRequest) {
  const role = verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);
  if (!role) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const courier = parseCourier(body.courier);
  if (!courier) {
    return NextResponse.json({ ok: false, error: "courier must be 'movers' or 'bosta'" }, { status: 400 });
  }
  // Recording Bosta orders is owner-only; Movers stays available to any signed-in role.
  if (courier === "bosta" && role !== "owner") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const numbers = body.numbers;
  if (typeof numbers !== "string" && !Array.isArray(numbers)) {
    return NextResponse.json({ ok: false, error: "numbers is required" }, { status: 400 });
  }
  const date = typeof body.date === "string" && body.date ? body.date : undefined;

  try {
    const summary = await bulkRecordOrders(numbers, courier, date);
    // The figures behind the Income Statement just changed - drop the cached
    // reports so the next page load rebuilds with this in it.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true, summary });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}
