import "server-only";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";
import { normalizeGovernorate } from "@/lib/governorates";
import { getProjectionRate, latestMatureMonth, type ProjectionRate } from "@/lib/engine/monthly-rate";
import { addDays, egyptToday } from "@/lib/dates";
import { loadBostaFeeBook, type FeeColumn } from "@/lib/bosta-fees";
import { isHandedToCourier } from "./actual-mode";
import type { DailyPnlMode, DailyPnlRow } from "./daily-pnl";

// Projects an Income Statement from a delivery rate applied uniformly across
// every included order - regardless of any individual order's real,
// already-known outcome. Used for the still-open (immature) month at last
// month's store-wide rate, and for the outcome-less Jul-Dec 2025 window at a
// fixed assumption (see getRateProjectedRows below for why both). Which
// orders are included still depends on mode ("actual" requires a courier
// to have actually picked the order up; see the filter below) - only the
// figures for those orders are projected uniformly, not the inclusion test.
// Revenue, COGS, shipping fee charged, and the delivered-side Bosta fees
// (courier + COD cash) all scale by `rate` - the "delivered" share of
// each. The courier RTO fee goes into bostaPenalty at the source month's
// measured RETURN rate, which is NOT `1 - rate`: between delivered and
// returned sit the cancellations that never reached a courier and the orders
// still moving, and Bosta bills a return for neither (migration 0082). A
// returned order never collects a shipping fee to net against either, so
// Shipping Differences Fee only ever sees the expected-to-deliver share.
// The open-package fee scales by neither:
// it was owed on every shipment whatever the outcome, so it is added in
// full to its own line. These are working assumptions for the still-open month,
// corrected with real per-order data (src/lib/engine/margin.ts) once the
// month closes and syncs for real. Kept separate from margin.ts rather
// than overriding its per-order computation since this is
// reporting-only: the Analysis by Product page and the underlying
// order_line_items engine keep using real-or-per-order projected values
// exactly as before.

type Settings = {
  packing_cost_per_unit: number;
  default_box_size_tier: string;
};

function emptyRow(date: string): DailyPnlRow {
  return {
    date,
    ordersPlaced: 0,
    ordersResolved: 0,
    ordersReceived: 0,
    ordersDelivered: 0,
    itemsSold: 0,
    revenue: 0,
    cogs: 0,
    grossRevenue: 0,
    grossCogs: 0,
    revenueProjected: false,
    grossProfit: 0,
    adSpend: 0,
    metaSpend: 0,
    tiktokSpend: 0,
    // Both ad spend and the fee derived from it are folded in centrally by
    // getDailyPnl, after this projection returns - never here.
    marketingAgencyFee: 0,
    generalAdSpend: 0,
    contributionProfit: 0,
    packaging: 0,
    shippingFeeCharged: 0,
    bostaFeesPaid: 0,
    shippingDifferencesFee: 0,
    nextDayFee: 0,
    openPackageFee: 0,
    salary: 0,
    postProduction: 0,
    subscription: 0,
    rent: 0,
    transportation: 0,
    other: 0,
    otherIncome: 0,
    // Chat orders are added once, centrally, in getDailyPnl - never here. They
    // carry no courier and so are never part of the rate projection.
    chatOrders: 0,
    chatRevenue: 0,
    chatCogs: 0,
    chatItems: 0,
    bostaPenalty: 0,
    // Stamped by the caller, not here: the open month discloses its rate through
    // openMonthInfo's banner instead, so only the outcome-less window sets it.
    assumedDeliveryRate: null,
    // Stamped by getOpenMonthRows, which knows the rate each day was struck at.
    projectionRate: null,
    customLines: [],
  };
}

const RESOLVED_OUTCOMES = ["delivered", "failed_rto", "exchange", "pickup_return"];

// Same rule as daily-pnl.ts: both modes date by the Shopify order date
// (egypt_day - never touched), and the mode only decides which orders count -
// Actual reports just those handed over (isHandedToCourier). See
// ./actual-mode.ts for why the old handover-day basis had to go. The included
// orders' figures are then scaled uniformly by `rate`; no individual order's
// own outcome is read, whichever caller supplied that rate.

export async function getOpenMonthRows(
  from: string,
  to: string,
  mode: DailyPnlMode = "performance"
): Promise<{ rows: DailyPnlRow[]; rate: number; sourceMonth: string | null }> {
  // Mode-specific: Performance projects with delivered / every order received,
  // Actual with delivered / orders handed over - matching the set of orders each
  // mode goes on to multiply, so neither is discounted twice.
  //
  // Each day keeps the rate it was first reported at, for good. Today's row is
  // always zeroed (see getDailyPnl), so a day is first shown the day after it,
  // and is struck at the rate current on THAT day. One live rate for the whole
  // window used to re-project every open day on the 11th, when the next month
  // matures: 2026-09-09 went out at July's rate and read differently on
  // 2026-09-11 at August's.
  const today = egyptToday();
  const last = to < today ? to : today;
  const reportedOn = (day: string) => (addDays(day, 1) < today ? addDays(day, 1) : today);
  // Days that agree on the latest mature month get the same rate, so it is
  // looked up once per source month rather than once per day.
  const bySource = new Map<string, Promise<ProjectionRate>>();
  const pendingByDay = new Map<string, Promise<ProjectionRate>>();
  for (let day = from; day <= last; day = addDays(day, 1)) {
    const asOf = reportedOn(day);
    const source = latestMatureMonth(asOf);
    if (!bySource.has(source)) bySource.set(source, getProjectionRate(mode, asOf));
    pendingByDay.set(day, bySource.get(source)!);
  }
  const rateByDay = new Map<string, ProjectionRate>();
  for (const [day, pending] of pendingByDay) rateByDay.set(day, await pending);
  // What the banner and the expected Delivery Rate name: the rate new days are
  // being reported at now.
  const current = rateByDay.get(last) ?? (await getProjectionRate(mode));
  const rateOf = (day: string) => rateByDay.get(day) ?? current;

  const rows = await getRateProjectedRows(from, to, mode, (day) => rateOf(day).rate, {
    cancelledInRate: true,
    // Measured, not inferred: the share of the source month's orders that was
    // actually billed a return. (1 - delivery rate) is not that share - it also
    // holds every cancellation and every order still unresolved when the month
    // closed, none of which Bosta charges a return for. See migration 0082.
    returnRateFor: (day) => rateOf(day).returnRate,
  });
  for (const row of rows) row.projectionRate = rateOf(row.date);
  return { rows, rate: current.rate, sourceMonth: current.sourceMonth };
}

// The projection itself, run at whatever rate the caller hands it. Two callers,
// for the two different reasons a period's outcomes can't be read off its own
// orders:
//
//   getOpenMonthRows above - the month is still settling. Outcomes exist but
//     none is trusted this early, so the rate is the last mature month's real
//     one and every figure is restated for real once the month closes.
//   daily-pnl's outcome-less window - the Jul-Dec 2025 orders came out of
//     Shopify without a Bosta tracking number, so no outcome will EVER arrive
//     and there is nothing to restate later. The rate is a fixed assumption
//     (OUTCOMELESS_DELIVERY_RATE) rather than a measurement.
//
// One function rather than two because both need the identical cost treatment:
// the delivered share carries the delivery fee and the COD cash fee, the
// returned share carries the RTO fee into Bosta Penalty, and the open-package
// fee is owed on every shipment whichever way it went.
//
// `cancelledInRate` says whether the rate already has cancellations inside it,
// which decides what a cancelled order may do here:
//   true  - the open month. Its rate is delivered / EVERY order received, so a
//           cancellation is already one of the orders the rate says won't
//           deliver. A cancelled order is therefore projected exactly like any
//           other; dropping it as well counted every cancellation twice. It also
//           keeps a reported day still: an order cancelled after the day closed
//           no longer moves that day's figures.
//   false - the outcome-less window. Its 80% came from Bosta's return invoices,
//           which never saw a cancellation, so cancelled orders stay out and a
//           shipped one is billed its return on top.
export async function getRateProjectedRows(
  from: string,
  to: string,
  mode: DailyPnlMode,
  rateFor: (day: string) => number,
  opts: {
    cancelledInRate: boolean;
    // The share of orders that carries an RTO fee. Left out by the outcome-less
    // window, whose 80% came from Bosta's return invoices and so IS a
    // return-based figure already: there, (1 - rate) is the right complement.
    returnRateFor?: (day: string) => number;
  }
): Promise<DailyPnlRow[]> {
  const { data: settingsRow, error: settingsErr } = await supabase.from("settings").select("*").eq("id", 1).single();
  if (settingsErr || !settingsRow) throw new Error(`Failed to load settings: ${settingsErr?.message}`);
  const settings = settingsRow as Settings;

  // Same as-of price list margin.ts uses, keyed on each order's own day, so the
  // open month prices orders placed before Bosta's 2026-08-04 re-pricing at the
  // old card and everything after at the new one.
  const feeBook = await loadBostaFeeBook();

  const { data: modelRows, error: modelErr } = await supabase.from("model_groups").select("*");
  if (modelErr) throw new Error(`Failed to load model_groups: ${modelErr.message}`);
  const models = new Map(modelRows?.map((m) => [m.id, m]));

  // Per-variant costs, same precedence as margin.ts - a sale is costed at the
  // variant it names before falling back to its product.
  const variantCostRows = await fetchAllRows<{ id: number; unit_cost_override: number | null }>(
    supabase,
    "product_variants",
    "id, unit_cost_override"
  );
  const variantCost = new Map<number, number>();
  for (const v of variantCostRows) {
    if (v.unit_cost_override !== null) variantCost.set(v.id, Number(v.unit_cost_override));
  }

  const orders = await fetchAllRows<{
    egypt_day: string;
    cancelled_at: string | null;
    bosta_tracking_number: string | null;
    outcome: string | null;
    courier: string;
    self_delivered: boolean | null;
    bosta_picked_up_day: string | null;
    movers_record_date: string | null;
    outcome_governorate: string | null;
    governorate_shopify: string | null;
    cod_amount_collected: number | null;
    total_price: number | null;
    shipping_fee_charged: number | null;
    order_line_items: {
      quantity: number;
      unit_price: number;
      product_id: number | null;
      variant_id: number | null;
      products: { model_group_id: number | null; unit_cost_override: number | null } | null;
    }[];
  }>(
    supabase,
    "orders",
    "id, egypt_day, cancelled_at, outcome, courier, self_delivered, bosta_tracking_number, outcome_governorate, governorate_shopify, cod_amount_collected, total_price, shipping_fee_charged, order_line_items(quantity, unit_price, product_id, variant_id, products(model_group_id, unit_cost_override))",
    // Only the open month is projected here, and both modes now bucket on the
    // Shopify order day, so the window is exactly [from, to] - no lag buffer is
    // needed any more (Actual used to bucket on the handover day, which could
    // trail the order day by weeks).
    (q) => q.gte("egypt_day", from).lte("egypt_day", to)
  );

  const byDate = new Map<string, DailyPnlRow>();
  function getDay(date: string): DailyPnlRow {
    if (!byDate.has(date)) byDate.set(date, emptyRow(date));
    return byDate.get(date)!;
  }

  for (const order of orders) {
    // Mode-INDEPENDENT: every order Shopify took counts, in both views, so the
    // two share one denominator. Counted before both skips - a cancelled order,
    // and one never handed over, both still arrived.
    getDay(order.egypt_day).ordersReceived++;

    // Past this point Actual reports only orders actually handed over.
    if (mode === "actual" && !isHandedToCourier(order)) continue;

    if (order.cancelled_at && !opts.cancelledInRate) {
      // No revenue, no COGS, and no rate applies - the outcome is already known.
      // But a cancellation that had reached Bosta went out and came back, so it
      // owes the return fee and the open-package fee, exactly as the closed
      // months charge it (see migration 0075). One that never shipped is free.
      // Only reached when the rate knows nothing of cancellations - see
      // cancelledInRate above; otherwise a cancellation is projected below.
      if (!order.bosta_tracking_number || order.self_delivered === true) continue;
      const day = getDay(order.egypt_day);
      const governorate = normalizeGovernorate(order.outcome_governorate) ?? normalizeGovernorate(order.governorate_shopify);
      const fees = feeBook.feesFor(feeBook.zoneFor(governorate), settings.default_box_size_tier, order.egypt_day);
      day.bostaPenalty += fees?.return_to_origin ?? 0;
      day.openPackageFee += feeBook.openPackageFeeTotal(order.egypt_day);
      continue;
    }

    const day = getDay(order.egypt_day);
    // The order counts stay on orders still standing, the same as the closed
    // months', so "resolved so far" never counts a cancellation as resolved.
    // Only the money below takes every order in.
    if (!order.cancelled_at) {
      day.ordersPlaced++;
      const isResolved = RESOLVED_OUTCOMES.includes(order.outcome ?? "");
      if (isResolved) day.ordersResolved++;
      if (order.outcome === "delivered") day.ordersDelivered++;
    }

    // An order we delivered ourselves is the one case where the outcome IS
    // known this early and no rate should be applied to it: someone recorded
    // that it reached the customer (Bosta → Unresolved Orders). It is fully
    // delivered, and no courier ever billed for it, so every fee below drops
    // out. Everything else stays on the uniform projection.
    const isSelfDelivered = order.self_delivered === true && !order.cancelled_at;
    const effRate = isSelfDelivered ? 1 : rateFor(order.egypt_day);

    // Only the expected-to-deliver share of shipping revenue counts here -
    // a returned order never nets against Shipping Differences Fee.
    day.shippingFeeCharged += effRate * (order.shipping_fee_charged ?? 0);

    const governorate = normalizeGovernorate(order.outcome_governorate) ?? normalizeGovernorate(order.governorate_shopify);
    const zone = feeBook.zoneFor(governorate);
    const fees = feeBook.feesFor(zone, settings.default_box_size_tier, order.egypt_day);
    const openPackageFeeTotal = feeBook.openPackageFeeTotal(order.egypt_day);

    const codBasis = order.cod_amount_collected ?? order.total_price ?? 0;
    const codCashFeeTotal = codBasis * feeBook.codCashFeePct(order.egypt_day);

    const lineItems = order.order_line_items ?? [];
    const totalItemsInOrder = lineItems.reduce((sum, li) => sum + li.quantity, 0);
    const isMovers = order.courier === "movers";

    function feeFor(outcome: string): number {
      if (!fees) return 0;
      const col: Record<string, FeeColumn> = {
        delivered: "deliver",
        failed_rto: "return_to_origin",
      };
      const key = col[outcome];
      return key ? fees[key] : 0;
    }

    for (const li of lineItems) {
      const model = li.products?.model_group_id ? models.get(li.products.model_group_id) : null;
      // Same precedence as margin.ts: the variant sold, then the product's own
      // cost, then the model group's. Falls back to 0 only when nothing is
      // costed at all.
      const lineVariantCost = li.variant_id != null ? variantCost.get(li.variant_id) ?? null : null;
      const unitCost = lineVariantCost ?? li.products?.unit_cost_override ?? model?.unit_cost ?? 0;
      const unitShare = totalItemsInOrder > 0 ? li.quantity / totalItemsInOrder : 0;

      const revenue = li.quantity * li.unit_price;
      const costOfGoods = unitCost * li.quantity;
      const packing = settings.packing_cost_per_unit * li.quantity;
      // Movers has no real fee schedule yet - placeholder is the Shopify
      // shipping fee charged (Shipping Differences Fee nets to zero), with
      // no open-package/COD-cash fee until real numbers are given.
      const shippingFeeShare = isMovers ? (order.shipping_fee_charged ?? 0) * unitShare : 0;
      const codCashFeeShare = isMovers || isSelfDelivered ? 0 : codCashFeeTotal * unitShare;
      const openPackageFeeShare = isMovers || isSelfDelivered ? 0 : openPackageFeeTotal * unitShare; // outcome-invariant, charged every attempt

      const courierFeeDelivered = isSelfDelivered ? 0 : isMovers ? shippingFeeShare : feeFor("delivered") * unitShare;
      const courierFeeFailed = isSelfDelivered ? 0 : isMovers ? shippingFeeShare : feeFor("failed_rto") * unitShare;

      // Revenue and COGS scale by rate the same way (full value for the
      // delivered share, zero for the rest - an RTO'd order collects no
      // cash, and the inventory comes back rather than being lost,
      // matching margin.ts's failedMargin which never subtracts
      // costOfGoods either). Open package fee is owed either way, so it
      // splits proportionally between the two buckets; COD cash fee only
      // ever applies to the delivered share.
      day.itemsSold += li.quantity;
      day.grossRevenue += revenue; // 100%-delivery basis (unscaled)
      day.grossCogs += costOfGoods;
      day.revenue += effRate * revenue;
      day.cogs += effRate * costOfGoods;
      day.packaging += packing;
      day.bostaFeesPaid += effRate * courierFeeDelivered;
      day.nextDayFee += effRate * codCashFeeShare; // 1% COD next-day fee - own line
      day.openPackageFee += openPackageFeeShare; // charged on every order, any outcome - own line
      // The expected-return share, NOT (1 - delivered share): the orders in
      // between - cancellations that never shipped, orders still moving - come
      // with no return bill. Self-delivered orders carry none either (no
      // courier ever had them), which effRate = 1 used to express.
      const penaltyShare = isSelfDelivered ? 0 : opts.returnRateFor ? opts.returnRateFor(order.egypt_day) : 1 - effRate;
      day.bostaPenalty += penaltyShare * courierFeeFailed;
    }
  }

  for (const day of byDate.values()) {
    day.grossProfit = day.revenue - day.cogs;
    day.contributionProfit = day.grossProfit - day.adSpend;
    day.shippingDifferencesFee = day.shippingFeeCharged - day.bostaFeesPaid;
  }

  return [...byDate.values()];
}
