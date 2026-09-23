import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { REPORT_CACHE_TAG } from "@/lib/reports/cache";
import { syncShopifyOrders } from "@/lib/sync/shopify-orders";
import { syncShopifyProducts } from "@/lib/sync/shopify-products";
import { syncMetaSpend } from "@/lib/sync/meta-spend";
import { syncTikTokSpend } from "@/lib/sync/tiktok-spend";
import { runCalibration } from "@/lib/engine/calibration";
import { computeMargins } from "@/lib/engine/margin";
import { finalizeMonthlyRates, finalizeSkuMonthlyRates } from "@/lib/engine/monthly-rate";
import { markRecordDataSynced } from "@/lib/record-data/expenses";

// 300s, not 60: a step normally takes well under a minute, but one slow Meta
// response can push it past 60s (HTTP 504), as it did for IZAR.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Steps run in this order - shopify before shopify-products (so newly-mapped
// line items still get this same pass's margin recompute), monthly-rate
// before sku-monthly-rate (which falls back to it), and margins last (after
// every other input is settled). Split into one request per step, rather
// than one request doing all of them, because the combined runtime (~80s
// for the full pipeline) exceeds a single serverless function's budget -
// each step on its own comfortably fits, even the slowest (Bosta, ~45s).
// NOTE: no "bosta" step, unlike the nightly cron, which syncs the courier too.
// Inherited from an upstream clone whose courier was not Bosta. Adding "bosta"
// here would make the manual sync refresh delivery outcomes as well.
const STEPS = ["shopify", "shopify-products", "meta", "tiktok", "calibrate", "monthly-rate", "sku-monthly-rate", "margins"] as const;
type Step = (typeof STEPS)[number];

async function runStep(step: Step) {
  switch (step) {
    case "shopify":
      return syncShopifyOrders();
    case "shopify-products":
      return syncShopifyProducts();
    case "meta":
      return syncMetaSpend();
    case "tiktok":
      return syncTikTokSpend();
    case "calibrate":
      return runCalibration();
    case "monthly-rate":
      return finalizeMonthlyRates();
    case "sku-monthly-rate":
      return finalizeSkuMonthlyRates();
    case "margins": {
      const result = await computeMargins();
      await markRecordDataSynced(); // advances the report cutoff (Shipping Orders / Movers report) up to this point
      return result;
    }
  }
}

export async function POST(request: NextRequest) {
  const sessionSecret = process.env.SESSION_SECRET;
  const role = verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value, sessionSecret);
  // AI MIRAJ's nightly run presses Sync with CRON_SECRET instead of a login.
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && request.headers.get("authorization") === `Bearer ${cronSecret}`;

  if (role !== "owner" && !isCron) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 403 });
  }

  const step = request.nextUrl.searchParams.get("step") as Step | null;
  if (!step || !STEPS.includes(step)) {
    return NextResponse.json({ ok: false, error: `Invalid or missing step (expected one of ${STEPS.join(", ")})` }, { status: 400 });
  }

  const result = await runStep(step);
  // The reports are cached for a short window (see src/lib/reports/cache.ts), so
  // drop them here - otherwise a finished Sync would appear to have done nothing
  // until the cache expired on its own.
  // `{ expire: 0 }` rather than the recommended "max": "max" is
  // stale-while-revalidate, which would still show the pre-sync numbers on the
  // first load after a sync. Expiring outright makes that next load fetch fresh.
  if (result.ok) revalidateTag(REPORT_CACHE_TAG, { expire: 0 });
  return NextResponse.json({ step, ...result }, { status: result.ok ? 200 : 500 });
}
