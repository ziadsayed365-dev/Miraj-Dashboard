import "server-only";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";
import { egyptToday, addDays, firstOfMonth, firstOfNextMonth } from "@/lib/dates";
import { HANDED_TO_COURIER_FILTER } from "@/lib/reports/actual-mode";

const RESOLVED_OUTCOMES = ["delivered", "failed_rto"];
// How long after a month ends its last stragglers are still worth waiting for.
// Past this the month closes on the outcomes it has, reports real per-order
// figures, and becomes the source of the projection rate for the months still
// open behind it.
//
// 10 days, not the 15 this used to be: in practice an order with no outcome by
// then is one that will never get one, and holding a whole month on a handful
// of stuck orders costs far more than it saves. calibration.ts keeps its own
// 15-day buffer - that one is about trusting a single order's outcome, a
// different question from when a month's books close.
const MATURITY_DAYS = 10;

// `asOf` lets a caller ask what was mature on an earlier day - a projected day
// keeps the rate that was current when it was first reported.
export function isMonthMature(month: string, asOf: string = egyptToday()): boolean {
  return asOf >= addDays(firstOfNextMonth(month), MATURITY_DAYS);
}

// The newest calendar month already mature on `asOf`, as "YYYY-MM-01". Two days
// that agree on it are projected at the same rate.
export function latestMatureMonth(asOf: string): string {
  let month = firstOfMonth(asOf);
  while (!isMonthMature(month, asOf)) month = firstOfMonth(addDays(month, -1));
  return month;
}

// Computes and stores the real store-wide delivery rate for every calendar
// month that has just matured but doesn't have a row yet. Always inserts
// exactly one row per mature month (falling back to the settings default
// if a month happens to have zero resolved orders), so the loop is
// guaranteed to terminate and never re-checks an already-finalized month.
export async function finalizeMonthlyRates(): Promise<{ ok: boolean; monthsFinalized: number; error?: string }> {
  try {
    const { data: settingsRow, error: settingsErr } = await supabase
      .from("settings")
      .select("default_success_rate_estimate")
      .eq("id", 1)
      .single();
    if (settingsErr || !settingsRow) throw new Error(`Failed to load settings: ${settingsErr?.message}`);
    const fallbackRate = Number(settingsRow.default_success_rate_estimate);

    const { data: latestFinalized, error: latestErr } = await supabase
      .from("monthly_delivery_rates")
      .select("month")
      .order("month", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestErr) throw new Error(`Failed to load monthly_delivery_rates: ${latestErr.message}`);

    let month: string;
    if (latestFinalized) {
      month = firstOfNextMonth(latestFinalized.month);
    } else {
      const { data: earliestOrder, error: earliestErr } = await supabase
        .from("orders")
        .select("egypt_day")
        .order("egypt_day", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (earliestErr) throw new Error(`Failed to load earliest order: ${earliestErr.message}`);
      if (!earliestOrder) return { ok: true, monthsFinalized: 0 };
      month = firstOfMonth(earliestOrder.egypt_day);
    }

    let monthsFinalized = 0;
    while (isMonthMature(month)) {
      const monthEnd = firstOfNextMonth(month);

      // The owner's definition, stated plainly: of 100 orders with 10 returned
      // and 10 cancelled, 80 delivered is an 80% rate. So the denominator is
      //
      //     delivered + returned + EVERY cancellation
      //
      // including the ~75% of cancellations that never reached a courier. This
      // is a commercial rate - of the orders taken, how many turned into cash -
      // and it is what revenue and COGS are scaled by.
      //
      // Note it is NOT the basis the courier-cost lines use: Bosta Penalty and
      // the open-package fee are charged per SHIPPED order only (see margin.ts),
      // because a cancellation that never left the building was never billed.
      const [resolvedRes, cancelledRes, deliveredRes] = await Promise.all([
        supabase
          .from("orders")
          .select("id", { count: "exact", head: true })
          .is("cancelled_at", null)
          .gte("egypt_day", month)
          .lt("egypt_day", monthEnd)
          .in("outcome", RESOLVED_OUTCOMES),
        supabase
          .from("orders")
          .select("id", { count: "exact", head: true })
          .not("cancelled_at", "is", null)
          .gte("egypt_day", month)
          .lt("egypt_day", monthEnd),
        supabase
          .from("orders")
          .select("id", { count: "exact", head: true })
          .is("cancelled_at", null)
          .gte("egypt_day", month)
          .lt("egypt_day", monthEnd)
          .eq("outcome", "delivered"),
      ]);
      if (resolvedRes.error) throw new Error(`Failed to count resolved orders for ${month}: ${resolvedRes.error.message}`);
      if (cancelledRes.error) throw new Error(`Failed to count cancelled orders for ${month}: ${cancelledRes.error.message}`);
      if (deliveredRes.error) throw new Error(`Failed to count delivered orders for ${month}: ${deliveredRes.error.message}`);

      const resolvedCount = (resolvedRes.count ?? 0) + (cancelledRes.count ?? 0);
      const deliveredCount = deliveredRes.count ?? 0;

      const resolved = resolvedCount ?? 0;
      const delivered = deliveredCount ?? 0;
      const rate = resolved > 0 ? delivered / resolved : fallbackRate;

      const { error: upsertErr } = await supabase.from("monthly_delivery_rates").upsert(
        { month, resolved_count: resolved, delivered_count: delivered, rate },
        { onConflict: "month" }
      );
      if (upsertErr) throw new Error(`Failed to upsert monthly_delivery_rates for ${month}: ${upsertErr.message}`);

      monthsFinalized++;
      month = monthEnd;
    }

    return { ok: true, monthsFinalized };
  } catch (err) {
    return { ok: false, monthsFinalized: 0, error: err instanceof Error ? err.message : "unknown error" };
  }
}

// `rate` is delivered / the orders that mode reports on. `returnRate` is the
// share of those same orders that was actually BILLED A RETURN - orders that
// came back, plus cancellations that had already shipped. The two are measured
// on one denominator but they are NOT complements: between them sit the
// cancellations that never reached a courier and the orders still unresolved
// when the month closed, and neither costs a return fee. Charging (1 - rate)
// as returns was double the truth in Aug 2026 (19.49% against 11.57%).
export type ProjectionRate = { rate: number; returnRate: number; sourceMonth: string | null };

export type DeliveryRateMode = "performance" | "actual";

// Delivered ÷ the orders that mode actually reports on, for one month:
//   performance - every order Shopify took that month, cancellations and
//                 never-shipped included. Deliberately the same denominator as
//                 the Income Statement's Delivery Rate row (ordersReceived), so
//                 the rate the daily view displays and the money projected
//                 underneath it can never tell different stories.
//   actual      - only orders handed to a courier, since that is the set Actual
//                 goes on to multiply. Using the business-wide rate for both
//                 would discount Actual twice: once by excluding the
//                 never-shipped orders, and again by a rate that already
//                 assumed they fail.
//
// Counted from the orders rather than read from monthly_delivery_rates, which
// stores a different definition - delivered / (resolved + cancelled) - and so
// cannot stand in for this one. That table is still written by the finalizers
// above as a historical record. Projections never read this live: they go
// through getFrozenMonthRate below.
async function countMonthDeliveries(
  month: string,
  mode: DeliveryRateMode
): Promise<{ delivered: number; returned: number; total: number }> {
  const monthEnd = firstOfNextMonth(month);
  const inMonth = () =>
    supabase.from("orders").select("id", { count: "exact", head: true }).gte("egypt_day", month).lt("egypt_day", monthEnd);
  const scoped = () => (mode === "actual" ? inMonth().or(HANDED_TO_COURIER_FILTER) : inMonth());

  // Billed a return: came back from a delivery attempt, or was cancelled after
  // it had already shipped - that package went out and came back too, and
  // migration 0075 charges it a return in the closed months. An order that is
  // both is counted once (PostgREST 'or' is a union). Cancellations that never
  // reached a courier are deliberately absent: Bosta never billed them.
  const RETURNED_FILTER = "outcome.eq.failed_rto,and(cancelled_at.not.is.null,bosta_tracking_number.not.is.null)";

  const [denominator, numerator, returned] = await Promise.all([
    scoped(),
    scoped().eq("outcome", "delivered"),
    scoped().or(RETURNED_FILTER),
  ]);
  if (denominator.error) throw new Error(`Failed to count ${mode} orders for ${month}: ${denominator.error.message}`);
  if (numerator.error) throw new Error(`Failed to count delivered orders for ${month}: ${numerator.error.message}`);
  if (returned.error) throw new Error(`Failed to count returned orders for ${month}: ${returned.error.message}`);

  return { delivered: numerator.count ?? 0, returned: returned.count ?? 0, total: denominator.count ?? 0 };
}

export async function getMonthDeliveryRate(month: string, mode: DeliveryRateMode): Promise<number | null> {
  const { delivered, total } = await countMonthDeliveries(month, mode);
  return total === 0 ? null : delivered / total;
}

// The live (unfrozen) pair, for a month nothing has frozen yet.
async function getMonthRates(month: string, mode: DeliveryRateMode): Promise<{ rate: number; returnRate: number } | null> {
  const { delivered, returned, total } = await countMonthDeliveries(month, mode);
  if (total === 0) return null;
  return { rate: delivered / total, returnRate: returned / total };
}

// A mature month's rate as projections use it: frozen in projection_rates the
// first time anything asks for it, and never recomputed (migration 0078). Read
// live, every late outcome synced onto the source month nudged every projected
// day that had already been reported.
async function getFrozenMonthRate(month: string, mode: DeliveryRateMode): Promise<{ rate: number; returnRate: number } | null> {
  const read = () =>
    supabase.from("projection_rates").select("rate, return_rate").eq("month", month).eq("mode", mode).maybeSingle();
  const { data: frozen, error } = await read();
  // Table not installed yet: stay on the live figures rather than break the report.
  if (error) return getMonthRates(month, mode);
  // return_rate arrives null only from a row frozen before migration 0082; fall
  // back to that row's own live return rate rather than to (1 - rate), which is
  // the overcharge this replaced.
  if (frozen) {
    if (frozen.return_rate !== null) return { rate: Number(frozen.rate), returnRate: Number(frozen.return_rate) };
    const live = await getMonthRates(month, mode);
    return { rate: Number(frozen.rate), returnRate: live?.returnRate ?? 0 };
  }

  const { delivered, returned, total } = await countMonthDeliveries(month, mode);
  if (total === 0) return null;
  // Two requests can race to freeze the same month. ignoreDuplicates keeps
  // whichever landed first, and the read-back hands that one to both. Both
  // rates are frozen together, so a reported day can never end up with one
  // month's delivery rate and another's return rate.
  const { error: insertErr } = await supabase
    .from("projection_rates")
    .upsert(
      {
        month,
        mode,
        delivered_count: delivered,
        returned_count: returned,
        order_count: total,
        rate: delivered / total,
        return_rate: returned / total,
      },
      { onConflict: "month,mode", ignoreDuplicates: true }
    );
  if (insertErr) throw new Error(`Failed to freeze projection rate for ${month}: ${insertErr.message}`);
  const { data: stored } = await read();
  return stored && stored.return_rate !== null
    ? { rate: Number(stored.rate), returnRate: Number(stored.return_rate) }
    : { rate: delivered / total, returnRate: returned / total };
}

// The rate a not-yet-mature day is projected at: the most recent month that was
// already MATURE on `asOf`, for the requested mode, as frozen. Falls back to the
// last finalized month's stored rate, then to the owner's estimate in Settings,
// for a store too new to have a mature month at all.
export async function getProjectionRate(
  mode: DeliveryRateMode = "performance",
  asOf: string = egyptToday()
): Promise<ProjectionRate> {
  // Walks back from asOf's month rather than off any requested range, so the
  // daily view gets a real expected rate even when its window covers only the
  // last few days. Bounded so a store with no mature month cannot loop.
  let month = firstOfMonth(asOf);
  for (let i = 0; i < 24; i++) {
    if (isMonthMature(month, asOf)) {
      const frozen = await getFrozenMonthRate(month, mode);
      if (frozen !== null) return { ...frozen, sourceMonth: month };
    }
    month = firstOfMonth(addDays(month, -1));
  }

  // Fallbacks for a store too new to have a mature month. Neither source knows
  // anything about returns, and (1 - rate) is exactly the overcharge migration
  // 0082 removed, so they project no penalty at all rather than a wrong one.
  // Miraj has never reached either branch - there has been a mature month since
  // Aug 2025 - so this is a safety net, not a live path.
  const { data: latest, error } = await supabase
    .from("monthly_delivery_rates")
    .select("month, rate")
    .order("month", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to load monthly_delivery_rates: ${error.message}`);
  if (latest) return { rate: Number(latest.rate), returnRate: 0, sourceMonth: latest.month };

  const { data: settingsRow, error: settingsErr } = await supabase
    .from("settings")
    .select("default_success_rate_estimate")
    .eq("id", 1)
    .single();
  if (settingsErr || !settingsRow) throw new Error(`Failed to load settings: ${settingsErr?.message}`);
  return { rate: Number(settingsRow.default_success_rate_estimate), returnRate: 0, sourceMonth: null };
}

// Per-SKU (individual color/variant) analog of finalizeMonthlyRates - same
// month-by-month maturity walk, but counted per product instead of
// store-wide. A SKU with zero resolved orders in a given month has no
// rate of its own (mathematically undefined), so it falls back to that
// exact month's store-wide rate rather than the store-wide rate of the
// month it shipped in being blended/guessed.
export async function finalizeSkuMonthlyRates(): Promise<{ ok: boolean; monthsFinalized: number; error?: string }> {
  try {
    const { data: settingsRow, error: settingsErr } = await supabase
      .from("settings")
      .select("default_success_rate_estimate")
      .eq("id", 1)
      .single();
    if (settingsErr || !settingsRow) throw new Error(`Failed to load settings: ${settingsErr?.message}`);
    const globalFallbackRate = Number(settingsRow.default_success_rate_estimate);

    const { data: latestFinalized, error: latestErr } = await supabase
      .from("sku_monthly_delivery_rates")
      .select("month")
      .order("month", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestErr) throw new Error(`Failed to load sku_monthly_delivery_rates: ${latestErr.message}`);

    let month: string;
    if (latestFinalized) {
      month = firstOfNextMonth(latestFinalized.month);
    } else {
      const { data: earliestOrder, error: earliestErr } = await supabase
        .from("orders")
        .select("egypt_day")
        .order("egypt_day", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (earliestErr) throw new Error(`Failed to load earliest order: ${earliestErr.message}`);
      if (!earliestOrder) return { ok: true, monthsFinalized: 0 };
      month = firstOfMonth(earliestOrder.egypt_day);
    }

    const { data: products, error: productsErr } = await supabase.from("products").select("id");
    if (productsErr) throw new Error(`Failed to load products: ${productsErr.message}`);

    let monthsFinalized = 0;
    while (isMonthMature(month)) {
      const monthEnd = firstOfNextMonth(month);

      const { data: storeRateRow, error: storeRateErr } = await supabase
        .from("monthly_delivery_rates")
        .select("rate")
        .eq("month", month)
        .maybeSingle();
      if (storeRateErr) throw new Error(`Failed to load monthly_delivery_rates for ${month}: ${storeRateErr.message}`);
      const fallbackRate = storeRateRow ? Number(storeRateRow.rate) : globalFallbackRate;

      // Same denominator as the store-wide rate above: delivered + returned +
      // every cancellation. A per-product rate has to be measured on the same
      // population as the store rate it falls back to, or a product would look
      // better or worse than the store purely from how the two were counted.
      const lineItems = await fetchAllRows<{
        product_id: number | null;
        orders: { outcome: string | null; cancelled_at: string | null } | null;
      }>(
        supabase,
        "order_line_items",
        "id, product_id, orders!inner(egypt_day, outcome, cancelled_at)",
        (query) => query.gte("orders.egypt_day", month).lt("orders.egypt_day", monthEnd)
      );

      const byProduct = new Map<number, { resolved: number; delivered: number }>();
      for (const li of lineItems) {
        if (!li.product_id) continue;
        const cancelled = Boolean(li.orders?.cancelled_at);
        const outcome = li.orders?.outcome ?? null;
        // A cancellation counts against the product whatever its outcome; a
        // live order only counts once it has actually resolved.
        if (!cancelled && !RESOLVED_OUTCOMES.includes(outcome ?? "")) continue;
        if (!byProduct.has(li.product_id)) byProduct.set(li.product_id, { resolved: 0, delivered: 0 });
        const entry = byProduct.get(li.product_id)!;
        entry.resolved++;
        if (!cancelled && outcome === "delivered") entry.delivered++;
      }

      const rows = (products ?? []).map((p) => {
        const stats = byProduct.get(p.id) ?? { resolved: 0, delivered: 0 };
        const rate = stats.resolved > 0 ? stats.delivered / stats.resolved : fallbackRate;
        return {
          product_id: p.id,
          month,
          resolved_count: stats.resolved,
          delivered_count: stats.delivered,
          rate,
          created_at: new Date().toISOString(),
        };
      });

      if (rows.length > 0) {
        const { error: upsertErr } = await supabase
          .from("sku_monthly_delivery_rates")
          .upsert(rows, { onConflict: "product_id,month" });
        if (upsertErr) throw new Error(`Failed to upsert sku_monthly_delivery_rates for ${month}: ${upsertErr.message}`);
      }

      monthsFinalized++;
      month = monthEnd;
    }

    return { ok: true, monthsFinalized };
  } catch (err) {
    return { ok: false, monthsFinalized: 0, error: err instanceof Error ? err.message : "unknown error" };
  }
}

export type SkuProjectionRate = { rate: number; sourceMonth: string | null };

// The rate used to project each SKU's own open-month revenue/COGS: that
// SKU's most recently finalized month, or the store-wide projection rate
// if the SKU has never had a finalized month (e.g. a brand new product).
export async function getSkuProjectionRates(): Promise<{
  ratesByProduct: Map<number, SkuProjectionRate>;
  fallback: SkuProjectionRate;
}> {
  const fallback = await getProjectionRate();

  const rows = await fetchAllRows<{ product_id: number; month: string; rate: number }>(
    supabase,
    "sku_monthly_delivery_rates",
    "product_id, month, rate",
    undefined,
    ["product_id", "month"] // no id column - composite primary key is (product_id, month)
  );

  const ratesByProduct = new Map<number, SkuProjectionRate>();
  for (const row of rows) {
    const existing = ratesByProduct.get(row.product_id);
    if (!existing || row.month > existing.sourceMonth!) {
      ratesByProduct.set(row.product_id, { rate: Number(row.rate), sourceMonth: row.month });
    }
  }

  return { ratesByProduct, fallback };
}
