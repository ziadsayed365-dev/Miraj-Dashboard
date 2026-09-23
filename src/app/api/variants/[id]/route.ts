import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { REPORT_CACHE_TAG } from "@/lib/reports/cache";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { setVariantUnitCost } from "@/lib/products/catalog";

export const dynamic = "force-dynamic";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const role = verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);
  if (role !== "owner") {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 403 });
  }

  const { id } = await params;
  const variantId = Number(id);
  if (!Number.isFinite(variantId)) {
    return NextResponse.json({ ok: false, error: "Invalid id" }, { status: 400 });
  }

  const body = await request.json();
  const { unitCostOverride } = body;
  if (unitCostOverride !== null && (typeof unitCostOverride !== "number" || !Number.isFinite(unitCostOverride))) {
    return NextResponse.json({ ok: false, error: "Cost must be a number" }, { status: 400 });
  }
  if (typeof unitCostOverride === "number" && unitCostOverride < 0) {
    return NextResponse.json({ ok: false, error: "Cost cannot be negative" }, { status: 400 });
  }

  try {
    await setVariantUnitCost(variantId, unitCostOverride);
    // The figures behind the Income Statement just changed - drop the cached
    // reports so the next page load rebuilds with this in it.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}
