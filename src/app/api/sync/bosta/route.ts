import { NextRequest, NextResponse } from "next/server";
import { syncBostaDeliveries } from "@/lib/sync/bosta-deliveries";

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

  const result = await syncBostaDeliveries();
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
