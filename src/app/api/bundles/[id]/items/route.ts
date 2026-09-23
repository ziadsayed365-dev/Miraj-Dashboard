import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { REPORT_CACHE_TAG } from "@/lib/reports/cache";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { deleteBundleItem, upsertBundleItem } from "@/lib/products/final-products";

export const dynamic = "force-dynamic";

type Ref = { memberProductId?: number | null; memberVariantId?: number | null; componentId?: number | null };

function readRef(body: Record<string, unknown>): Ref {
  const ref: Ref = {};
  if (body.memberProductId !== undefined && body.memberProductId !== null) ref.memberProductId = Number(body.memberProductId);
  if (body.memberVariantId !== undefined && body.memberVariantId !== null) ref.memberVariantId = Number(body.memberVariantId);
  if (body.componentId !== undefined && body.componentId !== null) ref.componentId = Number(body.componentId);
  return ref;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const role = verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);
  if (role !== "owner") {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 403 });
  }

  const { id } = await params;
  const bundleId = Number(id);
  const body = await request.json();
  const quantity = Number(body.quantity);
  const ref = readRef(body);

  if (!Number.isFinite(bundleId) || !Number.isFinite(quantity) || quantity < 0) {
    return NextResponse.json({ ok: false, error: "Invalid input" }, { status: 400 });
  }

  try {
    await upsertBundleItem(bundleId, ref, quantity);
    // The figures behind the Income Statement just changed - drop the cached
    // reports so the next page load rebuilds with this in it.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const role = verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);
  if (role !== "owner") {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 403 });
  }

  const { id } = await params;
  const bundleId = Number(id);
  const body = await request.json();
  const ref = readRef(body);

  if (!Number.isFinite(bundleId) || (ref.memberProductId == null && ref.memberVariantId == null && ref.componentId == null)) {
    return NextResponse.json({ ok: false, error: "Invalid input" }, { status: 400 });
  }

  try {
    await deleteBundleItem(bundleId, ref);
    // The figures behind the Income Statement just changed - drop the cached
    // reports so the next page load rebuilds with this in it.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}
