import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { REPORT_CACHE_TAG } from "@/lib/reports/cache";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { createPurchase, deletePurchase, type PurchaseTargetKind } from "@/lib/purchases/purchases";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const role = verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);
  if (role !== "owner") return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid body" }, { status: 400 });
  }

  if (body.kind !== "component" && body.kind !== "product") {
    return NextResponse.json({ ok: false, error: "Pick a component or a product" }, { status: 400 });
  }

  try {
    const id = await createPurchase({
      kind: body.kind as PurchaseTargetKind,
      targetId: Number(body.targetId),
      date: String(body.date ?? ""),
      quantity: Number(body.quantity),
      totalAmount: Number(body.totalAmount),
    });
    // The figures behind the Income Statement just changed - drop the cached
    // reports so the next page load rebuilds with this in it.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true, id });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  const role = verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);
  if (role !== "owner") return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid body" }, { status: 400 });
  }

  try {
    await deletePurchase(Number(body.id));
    // The figures behind the Income Statement just changed - drop the cached
    // reports so the next page load rebuilds with this in it.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 400 });
  }
}
