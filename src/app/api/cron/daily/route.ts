import { NextRequest, NextResponse } from "next/server";
import { syncShopifyOrders } from "@/lib/sync/shopify-orders";
import { syncShopifyProducts } from "@/lib/sync/shopify-products";
import { syncMetaSpend } from "@/lib/sync/meta-spend";
import { syncTikTokSpend } from "@/lib/sync/tiktok-spend";
import { syncBostaDeliveries } from "@/lib/sync/bosta-deliveries";
import { runCalibration } from "@/lib/engine/calibration";
import { computeMargins } from "@/lib/engine/margin";
import { finalizeMonthlyRates, finalizeSkuMonthlyRates } from "@/lib/engine/monthly-rate";
import { dropReportCache } from "@/lib/reports/cache";
import { markRecordDataSynced } from "@/lib/record-data/expenses";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Daily cron: runs the whole pipeline in one call (Vercel crons hit a single
// URL on a schedule). Miraj's courier is Bosta, so delivery outcomes come from
// the "bosta" step below rather than from Shopify fulfillments. Vercel
// automatically sends `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is
// set as an env var.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const results: Record<string, unknown> = {};
  const startedAt = Date.now();

  // Orders are high-volume here (~280/day plus re-pulled status updates), and
  // each syncShopifyOrders pass self-caps at ~45s. A single pass can't clear a
  // day's delta, so loop until reachedEnd, budgeting wall-clock so the rest of
  // the pipeline still runs within the 300s function limit.
  //
  // A failed pass no longer ends the loop. It used to, which meant one
  // transient Supabase 5xx aborted the entire night's order sync and left the
  // dashboard silently stale until someone noticed a wrong number. Each pass
  // checkpoints its cursor, so retrying simply resumes. Only a run of
  // back-to-back failures (a real outage, not a blip) gives up.
  const SHOPIFY_BUDGET_MS = 210_000;
  const MAX_CONSECUTIVE_FAILURES = 3;
  let shopifyPasses = 0;
  let consecutiveFailures = 0;
  let shopifyCompleted = false;
  for (let i = 0; i < 12; i++) {
    const r = await syncShopifyOrders();
    shopifyPasses++;
    results.shopify = r;
    if (r.ok) {
      consecutiveFailures = 0;
      if (r.reachedEnd) {
        shopifyCompleted = true;
        break;
      }
    } else if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      break;
    }
    if (Date.now() - startedAt > SHOPIFY_BUDGET_MS) break;
  }
  // Surfaced so a run that never drained the backlog is visible in the cron
  // response instead of looking identical to a clean night.
  results.shopifyPasses = shopifyPasses;
  results.shopifyCompleted = shopifyCompleted;
  results.products = await syncShopifyProducts();
  for (let i = 0; i < 3; i++) {
    const r = await syncMetaSpend();
    results.meta = r;
    if (!r.ok || r.reachedEnd) break;
  }
  // A no-op (skipped: true) until the TIKTOK_* env vars are set.
  for (let i = 0; i < 3; i++) {
    const r = await syncTikTokSpend();
    results.tiktok = r;
    if (!r.ok || r.reachedEnd) break;
  }
  // Bosta delivery outcomes. Each pass self-caps at ~45s and refreshes the 150
  // least-recently-synced orders (new orders, last_bosta_sync_at null, come
  // first). Loop a few passes within an overall wall-clock budget so the engine
  // steps below still run comfortably inside the 300s function limit, and so
  // outcomes are fresh before calibration/rates/margins consume them.
  const BOSTA_BUDGET_MS = 250_000;
  for (let i = 0; i < 8; i++) {
    const r = await syncBostaDeliveries();
    results.bosta = { passes: i + 1, last: r };
    // Stop on failure as well as on the budget, the same way the Meta loop
    // above does. Without this a persistent fault - a missing or revoked
    // BOSTA_API_KEY being the obvious one - burns all 8 passes every night for
    // nothing, and the engine steps below (calibration, rates, margins) are
    // what pay for it, since they run afterwards inside the same 300s function.
    if (!r.ok) break;
    if (Date.now() - startedAt > BOSTA_BUDGET_MS) break;
  }
  results.calibrate = await runCalibration();
  results.monthlyRate = await finalizeMonthlyRates();
  results.skuMonthlyRate = await finalizeSkuMonthlyRates();
  results.margins = await computeMargins();
  await markRecordDataSynced();

  // Once, at the end, rather than after each step: the whole nightly pipeline
  // rewrites the numbers the reports are built from, and without this the first
  // visitor each morning could still be served the previous day's figures for
  // up to REPORT_CACHE_SECONDS.
  dropReportCache();

  return NextResponse.json({ ok: true, ranAt: new Date().toISOString(), results });
}
