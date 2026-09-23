import { NextRequest, NextResponse } from "next/server";
import { syncShopifyOrders } from "@/lib/sync/shopify-orders";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ ok: false, error: "CRON_SECRET not configured" }, { status: 403 });
  }
  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const result = await syncShopifyOrders();
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
