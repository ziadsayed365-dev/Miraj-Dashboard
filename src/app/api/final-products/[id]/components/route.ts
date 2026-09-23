import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { REPORT_CACHE_TAG } from "@/lib/reports/cache";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { deleteProductComponentMapping, upsertProductComponentMapping } from "@/lib/products/final-products";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const role = verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);
  if (role !== "owner") {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 403 });
  }

  const { id } = await params;
  const productId = Number(id);
  const body = await request.json();
  const componentId = Number(body.componentId);
  const quantity = Number(body.quantity);
  // Absent variantId = the product-level BOM shared by every variant.
  const variantId = body.variantId == null ? null : Number(body.variantId);

  if (!Number.isFinite(productId) || !Number.isFinite(componentId) || !Number.isFinite(quantity) || quantity < 0) {
    return NextResponse.json({ ok: false, error: "Invalid input" }, { status: 400 });
  }
  if (variantId !== null && !Number.isFinite(variantId)) {
    return NextResponse.json({ ok: false, error: "Invalid variant" }, { status: 400 });
  }

  try {
    await upsertProductComponentMapping(productId, componentId, quantity, variantId);
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
  const productId = Number(id);
  const body = await request.json();
  const componentId = Number(body.componentId);
  const variantId = body.variantId == null ? null : Number(body.variantId);

  if (!Number.isFinite(productId) || !Number.isFinite(componentId)) {
    return NextResponse.json({ ok: false, error: "Invalid input" }, { status: 400 });
  }
  if (variantId !== null && !Number.isFinite(variantId)) {
    return NextResponse.json({ ok: false, error: "Invalid variant" }, { status: 400 });
  }

  try {
    await deleteProductComponentMapping(productId, componentId, variantId);
    // The figures behind the Income Statement just changed - drop the cached
    // reports so the next page load rebuilds with this in it.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}
