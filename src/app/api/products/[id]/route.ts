import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { REPORT_CACHE_TAG } from "@/lib/reports/cache";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { updateProduct, type ProductPatch } from "@/lib/products/catalog";

export const dynamic = "force-dynamic";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const role = verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);
  if (role !== "owner") {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 403 });
  }

  const { id } = await params;
  const productId = Number(id);
  if (!Number.isFinite(productId)) {
    return NextResponse.json({ ok: false, error: "Invalid id" }, { status: 400 });
  }

  const body = await request.json();
  const patch: ProductPatch = {};

  // Only fields actually present are copied across, so a request that sets the
  // cost leaves the category alone rather than nulling it.
  if ("modelGroupId" in body) {
    if (body.modelGroupId !== null && typeof body.modelGroupId !== "number") {
      return NextResponse.json({ ok: false, error: "Invalid model group" }, { status: 400 });
    }
    patch.modelGroupId = body.modelGroupId;
  }
  if ("unitCostOverride" in body) {
    if (body.unitCostOverride !== null && (typeof body.unitCostOverride !== "number" || !Number.isFinite(body.unitCostOverride))) {
      return NextResponse.json({ ok: false, error: "Cost must be a number" }, { status: 400 });
    }
    if (typeof body.unitCostOverride === "number" && body.unitCostOverride < 0) {
      return NextResponse.json({ ok: false, error: "Cost cannot be negative" }, { status: 400 });
    }
    patch.unitCostOverride = body.unitCostOverride;
  }
  for (const field of ["category", "subCategory"] as const) {
    if (field in body) {
      if (body[field] !== null && typeof body[field] !== "string") {
        return NextResponse.json({ ok: false, error: `Invalid ${field}` }, { status: 400 });
      }
      patch[field] = body[field];
    }
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, error: "Nothing to update" }, { status: 400 });
  }

  try {
    await updateProduct(productId, patch);
    // The figures behind the Income Statement just changed - drop the cached
    // reports so the next page load rebuilds with this in it.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}
