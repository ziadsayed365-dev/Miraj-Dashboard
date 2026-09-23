import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { resolveOrders } from "@/lib/bosta/unresolved";
import { RESOLVE_ACTIONS, type ResolveAction } from "@/lib/bosta/shared";
import { REPORT_CACHE_TAG } from "@/lib/reports/cache";

export const maxDuration = 300; // the margin rebuild behind this can span months of orders
export const dynamic = "force-dynamic";

// Records what really happened to orders Bosta never resolved - most often a
// private delivery. See src/lib/bosta/unresolved.ts.
export async function POST(request: NextRequest) {
  // Any signed-in role, same as the other order-recording screens.
  const role = verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);
  if (!role) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: { orderNumbers?: unknown; action?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid body" }, { status: 400 });
  }

  const orderNumbers = Array.isArray(body.orderNumbers) ? body.orderNumbers.filter((n): n is string => typeof n === "string") : [];
  if (orderNumbers.length === 0) {
    return NextResponse.json({ ok: false, error: "orderNumbers must be a non-empty array" }, { status: 400 });
  }
  if (!RESOLVE_ACTIONS.includes(body.action as ResolveAction)) {
    return NextResponse.json({ ok: false, error: `action must be one of ${RESOLVE_ACTIONS.join(", ")}` }, { status: 400 });
  }

  try {
    const result = await resolveOrders(orderNumbers, body.action as ResolveAction);
    // Revenue, COGS and the delivery rate all just moved - drop the cached
    // reports so the Income Statement reflects it immediately.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}
