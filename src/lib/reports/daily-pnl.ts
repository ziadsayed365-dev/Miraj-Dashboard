import "server-only";
import { unstable_cache } from "next/cache";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";
import { REPORTED_AD_SEGMENT } from "@/lib/ad-segment";
import { firstOfMonth, addDays, daysInMonth, egyptToday } from "@/lib/dates";
import { isMonthMature, getProjectionRate } from "@/lib/engine/monthly-rate";
import { isHandedToCourier } from "./actual-mode";
import { getOpenMonthRows, getRateProjectedRows } from "./open-month-projection";
import { getOverheadResolver, type CustomPnlLine } from "./expenses-ledger";
import { REPORT_CACHE_SECONDS, REPORT_CACHE_TAG } from "./cache";
import { getChatOrderDailyTotals } from "@/lib/chat-orders/reporting";

export type DailyPnlRow = {
  date: string;
  ordersPlaced: number;
  ordersResolved: number;
  // Every order that came in that day, cancelled and never-shipped ones
  // included - the denominator of the Delivery Rate row. Deliberately wider
  // than ordersPlaced (which drops cancellations, since they contribute no
  // revenue), and deliberately mode-INDEPENDENT: the rate asks "of everything
  // Shopify took, how much reached a customer", so both views read against one
  // total and can be compared. This is NOT the delivered/resolved rate
  // monthly_delivery_rates stores - that one is a different question.
  ordersReceived: number;
  ordersDelivered: number;
  itemsSold: number;
  revenue: number;
  cogs: number;
  grossRevenue: number; // revenue counting ALL orders (as if 100% delivered)
  grossCogs: number; // COGS counting ALL orders
  grossProfit: number; // revenue - cogs
  // revenue/cogs are the expected-rate PROJECTION of gross, not measured
  // delivered money, because this day has no outcome data at all (see
  // projectOutcomelessDays). Never true for a day whose orders were actually
  // resolved - a day that genuinely delivered nothing keeps its real zero.
  revenueProjected: boolean;
  adSpend: number; // total marketing = metaSpend + tiktokSpend
  metaSpend: number; // Meta (Facebook/Instagram) ad spend
  tiktokSpend: number; // TikTok ad spend
  // The agency's cut, MARKETING_AGENCY_FEE_PCT of total marketing (Meta+TikTok).
  // Derived, never recorded: it moves with ad spend by definition, so booking it
  // in the expense ledger would freeze a number that is supposed to track. Sits
  // below Contribution Profit rather than inside it - the ad spend it is charged
  // on is already subtracted up there, and folding the fee in too would make
  // Contribution Profit answer a different question than it does for every other
  // month before the agency existed.
  marketingAgencyFee: number;
  generalAdSpend: number; // MEMO: the part of adSpend promoting no single model (already inside adSpend)
  contributionProfit: number; // grossProfit - adSpend
  packaging: number;
  shippingFeeCharged: number; // shipping fee charged to the customer, expected-to-deliver share only
  bostaFeesPaid: number; // courier delivery fee only, expected-to-deliver share (next-day and open-package fees are their own lines below)
  // (shippingFeeCharged - bostaFeesPaid) for courier orders, PLUS an estimated
  // share for chat orders: a chat order carries no courier fee of its own, so it
  // is credited the store's average shipping difference per delivered order,
  // times how many real orders the chat record stands for (its order_count). See
  // the chat fold in getDailyPnl.
  shippingDifferencesFee: number;
  nextDayFee: number; // Bosta's next-day cash-settlement fee, a % of COD collected (delivered/expected-to-deliver share). Still charged - not closed on 2026-08-04.
  openPackageFee: number; // Bosta open-package fee, charged on every order whatever the outcome. Was 7 EGP + 14% VAT; zero from 2026-08-04.
  // Day's share (month amount / days in month) of each fixed overhead, resolved
  // per month via getOverheadResolver: recorded actuals for ended months, the
  // Settings assumption for the open month (the hardcoded pre-cutover table is
  // empty for Miraj).
  salary: number;
  postProduction: number;
  subscription: number;
  rent: number;
  transportation: number;
  other: number;
  otherIncome: number; // day's share of recorded "Other - Income" - ADDS to Net Income
  // Chat orders (Bosta → Chat Orders): sales taken over chat and fulfilled
  // directly, dated by the recorded sale date. Their revenue/COGS/items are
  // ALREADY included in revenue/cogs/grossRevenue/grossCogs/itemsSold above -
  // these are memo fields, carried separately for two reasons: no courier is
  // involved, so they are 100% delivered and never rate-scaled or projected; and
  // they are deliberately absent from ordersPlaced/Resolved/Delivered, which
  // drive the Bosta delivery rate (and through it the open-month projection).
  chatOrders: number;
  chatRevenue: number;
  chatCogs: number;
  chatItems: number;
  // Cost of returned orders: the real RTO fee once resolved, or - while the
  // month is still open - the source month's measured RETURN rate applied to
  // every order's RTO fee. Not (1 - delivery rate), which also holds the
  // cancellations that never shipped and the orders still moving, neither of
  // which Bosta bills a return for (migration 0082).
  bostaPenalty: number;
  // Set only on days inside the outcome-less window, where every figure above is
  // an assumption at this rate rather than anything measured. Null everywhere
  // else, INCLUDING the still-open month - that one projects too, but discloses
  // it through openMonthInfo's banner and gets restated for real once it closes.
  // The Delivery Rate row reads this when it's present, so the rate on the
  // statement and the money underneath it can't tell different stories.
  assumedDeliveryRate: number | null;
  // The still-open month's counterpart: the rate this day's projected figures
  // were struck at, and the mature month it came from. Each open day keeps the
  // rate that was current when it was first reported (see getOpenMonthRows), so
  // two open days can carry different ones and the Delivery Rate row reads it
  // per column. Null on every day that is not open-month projected.
  projectionRate: { rate: number; sourceMonth: string | null } | null;
  // Day's share of each owner-added account flagged into the Income Statement,
  // one entry per account, each rendered as its own named line below
  // Contribution Profit (expense subtracts, income adds).
  customLines: CustomPnlLine[];
};

// Present when the requested range touches the still-open (immature)
// month, so the UI can disclose that those days are projected rather than
// real, and which month's rate is driving the projection.
export type OpenMonthInfo = {
  month: string;
  rate: number;
  sourceMonth: string | null;
};

export type DailyPnlTotals = DailyPnlRow extends infer R ? Omit<R, "date"> & { netProfit: number } : never;

// The most recent MATURE month's real delivered ÷ orders-received rate. A single
// day's own rate is meaningless - that day's orders have had no time to be
// delivered but are all in its denominator, so every day reads near 0% - so the
// daily view shows this expected rate instead of each day's arithmetic.
// Deliberately the same definition as the Delivery Rate row (delivered / every
// order received), and the same figure the open month's money is projected with.
export type ExpectedDeliveryRate = {
  rate: number | null;
  month: string | null; // the mature month it came from, "YYYY-MM"
};

export type DailyPnlResult = {
  rows: DailyPnlRow[]; // ascending by date
  totals: DailyPnlTotals;
  openMonthInfo: OpenMonthInfo | null;
  expectedDeliveryRate: ExpectedDeliveryRate;
};

const RESOLVED_OUTCOMES = ["delivered", "failed_rto", "exchange", "pickup_return"];

// The marketing agency bills 12.5% of what Miraj spends on ads. Applied to every
// month, including the ones reconstructed from Shopify - the ad spend behind
// them is real and fully recorded, so the fee on it is as real as any other.
export const MARKETING_AGENCY_FEE_PCT = 0.125;

// Miraj's first six months came out of Shopify without a single Bosta tracking
// number - not one of those ~19,600 orders carries an outcome, and no sync can
// ever give them one. Read literally the orders say 0% delivered: no revenue, no
// COGS, no returns, and so no Bosta Penalty either, while the full courier and
// COD-cash fees were still charged as though every one had been delivered. Both
// halves of that are wrong, and they were wrong in opposite directions.
//
// So the window is projected instead, exactly like the still-open month, at a
// flat rate the owner set from Bosta's own penalty invoices for the period.
// 80%, not the mature-month rate the rest of the report projects with: the
// invoices are the only real evidence of how these orders actually ended, and
// they say a fifth of them came back.
const OUTCOMELESS_WINDOW_FROM = "2025-07-01";
const OUTCOMELESS_WINDOW_TO = "2025-12-31";
export const OUTCOMELESS_DELIVERY_RATE = 0.8;

// "performance" = every Shopify order, whether or not it's shipped yet - the
// marketing/demand view. "actual" = only orders actually handed over to a
// courier (or delivered by us) - the real fulfillment-pipeline view, excluding
// orders still sitting in the building. This filter applies in both the mature
// and the still-open month; the open month's *figures* are still projected via
// the calibrated rate either way, since no order's outcome is trusted that
// early - only which orders count differs by mode.
export type DailyPnlMode = "performance" | "actual";

// Both modes date every order by the Shopify order date (egypt_day - never
// touched), so there is no longer a per-mode date function. The only thing the
// mode changes is WHICH orders contribute: Actual reports only orders handed
// over, applied inline in the loops below via isHandedToCourier. See
// ./actual-mode.ts for why the old handover-day basis had to go.

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
    grossProfit: 0,
    revenueProjected: false,
    adSpend: 0,
    metaSpend: 0,
    tiktokSpend: 0,
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
    chatOrders: 0,
    chatRevenue: 0,
    chatCogs: 0,
    chatItems: 0,
    bostaPenalty: 0,
    assumedDeliveryRate: null,
    projectionRate: null,
    customLines: [],
  };
}

// Finds the earliest immature month touching [from, to] - the point from
// which the open-month projection takes over instead of real per-order
// data. Returns null if everything up to `to` is already mature.
function findOpenMonthBoundary(from: string, to: string): string | null {
  const floor = firstOfMonth(from);
  let month = firstOfMonth(to);
  let boundary: string | null = null;
  while (!isMonthMature(month)) {
    boundary = month;
    if (month <= floor) break;
    month = firstOfMonth(addDays(month, -1));
  }
  return boundary;
}

// Fast path: the public.daily_pnl(mode) SQL function aggregates per day in the
// database (see supabase/daily-pnl-function.sql). Falls back to the in-app scan
// if the function isn't present yet.
async function getMatureRows(from: string, to: string, mode: DailyPnlMode): Promise<Map<string, DailyPnlRow>> {
  type AggRow = {
    day: string;
    orders_placed: number;
    orders_resolved: number;
    orders_received: number;
    delivered_count: number;
    items_sold: number;
    revenue: number;
    cogs: number;
    gross_revenue: number;
    gross_cogs: number;
    packaging: number;
    bosta_penalty: number;
    bosta_fees_paid: number;
    cod_cash_fee: number;
    open_package_fee: number;
    shipping_fee_charged: number;
  };
  const { data, error } = await supabase.rpc("daily_pnl", { p_mode: mode });
  if (error) {
    return getMatureRowsScan(from, to, mode); // function not installed yet
  }
  const byDate = new Map<string, DailyPnlRow>();
  for (const r of (data ?? []) as AggRow[]) {
    if (!r.day || r.day < from || r.day > to) continue;
    const row = emptyRow(r.day);
    row.ordersPlaced = Number(r.orders_placed);
    row.ordersResolved = Number(r.orders_resolved);
    row.ordersReceived = Number(r.orders_received ?? 0);
    row.ordersDelivered = Number(r.delivered_count ?? 0);
    row.itemsSold = Number(r.items_sold);
    row.revenue = Number(r.revenue);
    row.cogs = Number(r.cogs);
    row.grossRevenue = Number(r.gross_revenue ?? 0);
    row.grossCogs = Number(r.gross_cogs ?? 0);
    row.packaging = Number(r.packaging);
    row.bostaPenalty = Number(r.bosta_penalty);
    row.bostaFeesPaid = Number(r.bosta_fees_paid);
    row.nextDayFee = Number(r.cod_cash_fee ?? 0);
    row.openPackageFee = Number(r.open_package_fee ?? 0);
    row.shippingFeeCharged = Number(r.shipping_fee_charged);
    row.shippingDifferencesFee = row.shippingFeeCharged - row.bostaFeesPaid;
    byDate.set(r.day, row);
  }
  return byDate;
}

async function getMatureRowsScan(from: string, to: string, mode: DailyPnlMode): Promise<Map<string, DailyPnlRow>> {
  type OrderRow = {
    egypt_day: string;
    outcome: string | null;
    cancelled_at: string | null;
    courier: string;
    self_delivered: boolean | null;
    bosta_tracking_number: string | null;
    shipping_fee_charged: number | null;
    order_line_items: {
      quantity: number;
      revenue: number | null;
      cost_of_goods: number | null;
      allocated_courier_fee: number | null;
      allocated_open_package_fee: number | null;
      allocated_cod_cash_fee: number | null;
      packing_cost: number | null;
      refund_adjustment: number | null;
      damage_adjustment: number | null;
    }[];
  };

  const orders = await fetchAllRows<OrderRow>(
    supabase,
    "orders",
    "id, egypt_day, outcome, cancelled_at, courier, self_delivered, bosta_tracking_number, shipping_fee_charged, order_line_items(quantity, revenue, cost_of_goods, allocated_courier_fee, allocated_open_package_fee, allocated_cod_cash_fee, packing_cost, refund_adjustment, damage_adjustment)"
    // Filtered on the Shopify order date regardless of mode, so the shared
    // ordersReceived denominator below sees every order. Actual drops the
    // never-shipped ones inside the loop instead, where it can count them first.
  ).then((rows) => rows.filter((r) => r.egypt_day >= from && r.egypt_day <= to));

  const byDate = new Map<string, DailyPnlRow>();
  function getDay(date: string): DailyPnlRow {
    if (!byDate.has(date)) byDate.set(date, emptyRow(date));
    return byDate.get(date)!;
  }

  for (const order of orders) {
    // ordersReceived is deliberately mode-INDEPENDENT: every order Shopify took
    // that day counts, in both Performance and Actual, so the two views share
    // one denominator and can be read against each other. Counted before both
    // skips below - a cancelled order, and an order never handed over, both
    // still arrived.
    getDay(order.egypt_day).ordersReceived++;

    // Everything past this point is mode-specific: Actual reports only orders
    // actually handed over.
    if (mode === "actual" && !isHandedToCourier(order)) continue;
    if (order.cancelled_at) continue; // never placed in any practical sense - deterministic zero, not rate-dependent

    const day = getDay(order.egypt_day);
    day.ordersPlaced++;
    const isResolved = RESOLVED_OUTCOMES.includes(order.outcome ?? "");
    if (isResolved) day.ordersResolved++;
    if (order.outcome === "delivered") day.ordersDelivered++;

    // A returned order never nets a shipping fee against Shipping
    // Differences Fee - its real courier + open package fee go to Bosta
    // Penalty instead.
    const isReturned = order.outcome === "failed_rto";
    // Revenue and COGS are recognised only on DELIVERED orders - a returned
    // order collected no money and its goods came back, so it contributes no
    // revenue/COGS (its return/shipping costs are still booked below).
    const isDelivered = order.outcome === "delivered";
    if (!isReturned) {
      day.shippingFeeCharged += order.shipping_fee_charged ?? 0;
    }

    for (const li of order.order_line_items) {
      day.itemsSold += li.quantity ?? 0;
      day.grossRevenue += li.revenue ?? 0;
      day.grossCogs += li.cost_of_goods ?? 0;
      if (isDelivered) {
        day.revenue += li.revenue ?? 0;
        // Damage/refund risk is folded into COGS here (inventory-side loss).
        day.cogs += (li.cost_of_goods ?? 0) - (li.refund_adjustment ?? 0) - (li.damage_adjustment ?? 0);
      }
      day.packaging += li.packing_cost ?? 0;
      if (isReturned) {
        day.bostaPenalty += li.allocated_courier_fee ?? 0;
      } else {
        day.bostaFeesPaid += li.allocated_courier_fee ?? 0;
        day.nextDayFee += li.allocated_cod_cash_fee ?? 0; // 1% COD next-day fee - own line
      }
      day.openPackageFee += li.allocated_open_package_fee ?? 0; // charged on every order, any outcome - own line
    }
  }

  for (const day of byDate.values()) {
    day.shippingDifferencesFee = day.shippingFeeCharged - day.bostaFeesPaid;
  }

  return byDate;
}

// The dashboard asks for the whole history on every page load, and every page
// is force-dynamic, so without this each navigation and each refresh re-ran the
// entire report. The underlying data only moves when a sync runs, so a short
// window costs nothing in accuracy and takes the repeat cost to ~0. Arguments
// are part of the cache key, so each (from, to, mode) is cached separately.
export const getDailyPnl = unstable_cache(computeDailyPnl, ["daily-pnl"], {
  revalidate: REPORT_CACHE_SECONDS,
  tags: [REPORT_CACHE_TAG],
});

// Always the whole window, keyed only by mode - deliberately NOT by the caller's
// range. The mature path is a single SQL aggregate; this one is an in-app scan
// of ~19,600 orders and their line items, and the dashboard asks for several
// different ranges per load, each of which would otherwise pay for that scan
// separately under its own getDailyPnl key. Safe to freeze on its own timer
// because the window's orders can never change: no outcome will ever arrive for
// them, so the only inputs behind these figures are the fee book, Settings and
// product costs - and every route that writes one of those already drops the
// shared report tag.
const getOutcomelessWindowRows = unstable_cache(
  (mode: DailyPnlMode) =>
    getRateProjectedRows(OUTCOMELESS_WINDOW_FROM, OUTCOMELESS_WINDOW_TO, mode, () => OUTCOMELESS_DELIVERY_RATE, {
      cancelledInRate: false,
    }),
  ["outcomeless-window"],
  { revalidate: REPORT_CACHE_SECONDS, tags: [REPORT_CACHE_TAG] }
);

async function computeDailyPnl(from: string, to: string, mode: DailyPnlMode = "performance"): Promise<DailyPnlResult> {
  const boundary = findOpenMonthBoundary(from, to);
  const matureTo = boundary ? addDays(boundary, -1) : to;

  const byDate = new Map<string, DailyPnlRow>();
  let openMonthInfo: OpenMonthInfo | null = null;

  if (matureTo >= from) {
    const matureRows = await getMatureRows(from, matureTo, mode);
    for (const [date, row] of matureRows) byDate.set(date, row);
  }

  if (boundary) {
    const openFrom = boundary > from ? boundary : from;
    const { rows: openRows, rate, sourceMonth } = await getOpenMonthRows(openFrom, to, mode);
    for (const row of openRows) byDate.set(row.date, row);
    openMonthInfo = { month: boundary, rate, sourceMonth };
  }

  // The outcome-less window overwrites whatever the mature aggregate produced
  // for those days - the SQL can only read outcomes off the orders, and these
  // orders have none. Disjoint from the open month above (it closed in 2025), so
  // the two overwrites can never collide.
  const outcomelessFrom = from > OUTCOMELESS_WINDOW_FROM ? from : OUTCOMELESS_WINDOW_FROM;
  const outcomelessTo = to < OUTCOMELESS_WINDOW_TO ? to : OUTCOMELESS_WINDOW_TO;
  if (outcomelessFrom <= outcomelessTo) {
    for (const row of await getOutcomelessWindowRows(mode)) {
      if (row.date < outcomelessFrom || row.date > outcomelessTo) continue;
      // Copied, not mutated: the row came out of a shared cache entry that other
      // ranges are about to read too.
      byDate.set(row.date, { ...row, revenueProjected: true, assumedDeliveryRate: OUTCOMELESS_DELIVERY_RATE });
    }
  }

  // Filtered in the query rather than in JS - this used to pull every ad_spend
  // row in the table across the wire and then throw most of them away.
  // Retail only: wholesale runs its own P&L (see src/lib/ad-segment.ts).
  const adSpendRows = await fetchAllRows<{ date: string; spend: number; source: string | null; is_general: boolean }>(
    supabase,
    "ad_spend",
    "id, date, spend, source, is_general",
    (query) => query.gte("date", from).lte("date", to).eq("segment", REPORTED_AD_SEGMENT)
  );
  for (const spend of adSpendRows) {
    if (!byDate.has(spend.date)) byDate.set(spend.date, emptyRow(spend.date));
    const row = byDate.get(spend.date)!;
    const amount = Number(spend.spend);
    row.adSpend += amount;
    if (spend.source === "tiktok") row.tiktokSpend += amount;
    else row.metaSpend += amount; // default / 'meta'
    // Memo only - already counted in adSpend above. Shows how much marketing
    // promotes no single model (and so gets spread in Analysis by Product).
    if (spend.is_general) row.generalAdSpend += amount;
  }

  // Store-wide average Shipping Difference per delivered courier order, over the
  // whole fetched range. Chat orders carry no courier fee of their own, so this
  // is the best estimate of the shipping margin each one earned. Computed from
  // courier rows only (chat orders are absent from these fields) and BEFORE the
  // chat fold below adds to shippingDifferencesFee. Callers fetch all-time, so
  // this denominator is large and stable; guarded to 0 when nothing delivered.
  let shipDiffTotal = 0;
  let deliveredTotal = 0;
  for (const row of byDate.values()) {
    shipDiffTotal += row.shippingDifferencesFee;
    deliveredTotal += row.ordersDelivered;
  }
  const avgShippingDiffPerOrder = deliveredTotal > 0 ? shipDiffTotal / deliveredTotal : 0;

  // Chat orders join the normal flow here, dated by their recorded sale date:
  // their money and items land on the same revenue/COGS/items lines as courier
  // orders, so Gross Profit, Contribution and Net Income all include them. They
  // are NOT added to the courier order counts - see the DailyPnlRow comment.
  const chatByDate = await getChatOrderDailyTotals(from, to);
  for (const [date, chat] of chatByDate) {
    if (!byDate.has(date)) byDate.set(date, emptyRow(date));
    const row = byDate.get(date)!;
    row.revenue += chat.revenue;
    row.cogs += chat.cogs;
    // 100% delivered, so the gross (all-orders) figures move by the same amount.
    row.grossRevenue += chat.revenue;
    row.grossCogs += chat.cogs;
    row.itemsSold += chat.items;
    row.chatOrders += chat.orders;
    row.chatRevenue += chat.revenue;
    row.chatCogs += chat.cogs;
    row.chatItems += chat.items;
    // Estimated shipping margin: one average delivered order's difference per
    // real chat order (chat.orders already sums each record's order_count).
    row.shippingDifferencesFee += chat.orders * avgShippingDiffPerOrder;
  }

  // Before the profit lines below, which are all derived from revenue/cogs: a
  // projected day has to be projected FIRST or contribution and net income
  // would still be computed against a revenue of zero.
  const { rate: projectionRate, sourceMonth: projectionMonth } = await getProjectionRate(mode);
  projectOutcomelessDays([...byDate.values()], projectionRate);

  // Each fixed overhead is spread as month-amount / days-in-month onto every day
  // that HAS a row - so a day with no orders, no ad spend and no chat sale, which
  // gets no row at all, silently dropped its share. 2025-07-01 is exactly such a
  // day, and it cost July 3% of its overhead (290,323 shown against a real
  // 300,000). Fill those gaps with zero rows so an ended month's overhead lines
  // sum to the month's full amount.
  //
  // Deliberately bounded three ways. Only months that already have activity, so
  // an all-time range starting in 2000 cannot conjure 25 years of empty days.
  // Only inside [from, to], so a caller asking for half a month (the Analysis by
  // Product page does) still gets that half's proportional share rather than the
  // whole month's. And only ENDED months - the open month is meant to be
  // part-accrued, showing the elapsed share and nothing more.
  const monthsWithActivity = new Set([...byDate.keys()].map((d) => d.slice(0, 7)));
  const openMonth = egyptToday().slice(0, 7);
  for (const month of monthsWithActivity) {
    if (month >= openMonth) continue;
    const dim = daysInMonth(`${month}-01`);
    for (let d = 1; d <= dim; d++) {
      const date = `${month}-${String(d).padStart(2, "0")}`;
      if (date < from || date > to || byDate.has(date)) continue;
      byDate.set(date, emptyRow(date));
    }
  }

  const overheads = await getOverheadResolver();
  for (const day of byDate.values()) {
    day.grossProfit = day.revenue - day.cogs;
    day.contributionProfit = day.grossProfit - day.adSpend;
    // Computed here rather than where ad spend is folded in, so it always sees
    // the day's FINAL marketing figure (Meta and TikTok both land above).
    day.marketingAgencyFee = day.adSpend * MARKETING_AGENCY_FEE_PCT;
    // Each fixed overhead spread as month amount / days in month, resolved per
    // month (hardcoded before the cutover, recorded actuals for ended months,
    // the Settings assumption for the open month).
    const ov = overheads.forMonth(day.date.slice(0, 7));
    const dim = daysInMonth(day.date);
    day.salary = ov.salary / dim;
    day.postProduction = ov.postProduction / dim;
    day.subscription = ov.subscription / dim;
    day.rent = ov.rent / dim;
    day.transportation = ov.transportation / dim;
    day.other = ov.other / dim;
    day.otherIncome = overheads.otherIncomeForMonth(day.date.slice(0, 7)) / dim;
    day.customLines = overheads
      .customLinesForMonth(day.date.slice(0, 7))
      .map((l) => ({ ...l, amount: l.amount / dim }));
  }

  // The current (open) day is still accruing across every input - orders keep
  // arriving, ad spend is a partial figure, and the projection can't be trusted
  // that early. Rather than show a misleading half-day, force today to a clean
  // zero row so the dashboard only ever reflects fully closed days. Keep the
  // row present (as zeros) so the daily view still lists today.
  const today = egyptToday();
  if (today >= from && today <= to) byDate.set(today, emptyRow(today));

  const rows = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)); // ascending

  return {
    rows,
    totals: sumTotals(rows),
    openMonthInfo,
    // The same rate the outcomeless days above were projected with, and the same
    // one the open month uses, so the row the daily view shows and the money
    // below it can never tell different stories.
    expectedDeliveryRate: { rate: projectionRate, month: projectionMonth ? projectionMonth.slice(0, 7) : null },
  };
}

// Days whose orders carry NO outcome data at all report revenue/cogs of zero,
// because both are measured on delivered orders. Left alone that reads as "we
// sold nothing", and a whole month of it vanishes from the monthly table, which
// only gives a column to months with activity. The money is not unknown though -
// grossRevenue/grossCogs hold the full value of what was sold. What is unknown
// is how much of it reached a customer, which is what the expected delivery rate
// estimates.
//
// This is the catch-all, and it only touches revenue/COGS. The bulk of the
// problem - Jul-Dec 2025, whose orders never got a tracking number - is handled
// upstream by the outcome-less window instead, which reprices the courier lines
// on the same assumption rather than leaving them on a 100%-delivered footing.
// What is left for this to catch is the scattered rest: Movers days, mainly,
// where no API will ever report an outcome either. Those rows are already past
// here with a non-zero revenue, so the guards below skip them.
//
// Guarded on ordersResolved === 0: a day that shipped orders and genuinely
// delivered none of them has a real, measured zero that must not be overwritten
// with an optimistic projection.
function projectOutcomelessDays(rows: DailyPnlRow[], rate: number | null): void {
  if (rate === null) return; // no mature month to learn a rate from - say nothing
  for (const row of rows) {
    if (row.ordersResolved !== 0 || row.ordersDelivered !== 0) continue;
    if (row.grossRevenue === 0 && row.grossCogs === 0) continue;
    if (row.revenue !== 0 || row.cogs !== 0) continue;

    row.revenue = row.grossRevenue * rate;
    row.cogs = row.grossCogs * rate;
    row.grossProfit = row.revenue - row.cogs;
    row.revenueProjected = true;
  }
}

// Aggregates a set of daily rows into totals. Exported so a page can derive a
// date-range summary by filtering already-fetched rows instead of re-running
// the whole (expensive) query for the summary range.
export function sumTotals(rows: DailyPnlRow[]): DailyPnlTotals {
  const acc = {
    ordersPlaced: 0,
    ordersResolved: 0,
    ordersReceived: 0,
    ordersDelivered: 0,
    itemsSold: 0,
    revenue: 0,
    cogs: 0,
    grossRevenue: 0,
    grossCogs: 0,
    grossProfit: 0,
    revenueProjected: false,
    adSpend: 0,
    metaSpend: 0,
    tiktokSpend: 0,
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
    chatOrders: 0,
    chatRevenue: 0,
    chatCogs: 0,
    chatItems: 0,
    bostaPenalty: 0,
    assumedDeliveryRate: null as number | null,
    // Per-day only: a range can span days struck at different rates.
    projectionRate: null,
    customLines: [] as CustomPnlLine[],
  };
  // Owner-added P&L accounts, summed per account across the range. Keyed by
  // account id and kept in first-seen order so the statement's line order is
  // stable; a day that predates an account simply doesn't contribute to it.
  const customByAccount = new Map<number, CustomPnlLine>();
  for (const r of rows) {
    for (const l of r.customLines) {
      const cur = customByAccount.get(l.accountId);
      if (cur) cur.amount += l.amount;
      else customByAccount.set(l.accountId, { ...l });
    }
  }
  acc.customLines = [...customByAccount.values()];
  // Not summable, and not sticky the way revenueProjected is: a range that mixes
  // assumed and measured days has no single assumed rate it could honestly
  // report, so this survives only where every day carrying orders agrees on one.
  const assumed = new Set(rows.filter((r) => r.ordersReceived > 0).map((r) => r.assumedDeliveryRate));
  acc.assumedDeliveryRate = assumed.size === 1 ? [...assumed][0] : null;
  for (const r of rows) {
    acc.ordersPlaced += r.ordersPlaced;
    acc.ordersResolved += r.ordersResolved;
    acc.ordersReceived += r.ordersReceived;
    acc.ordersDelivered += r.ordersDelivered;
    acc.itemsSold += r.itemsSold;
    acc.revenue += r.revenue;
    acc.cogs += r.cogs;
    acc.grossRevenue += r.grossRevenue;
    acc.grossCogs += r.grossCogs;
    acc.grossProfit += r.grossProfit;
    // Sticky, not summed: a total that swallows even one projected day is
    // itself part-projection, and must be able to say so.
    acc.revenueProjected ||= r.revenueProjected;
    acc.adSpend += r.adSpend;
    acc.metaSpend += r.metaSpend;
    acc.generalAdSpend += r.generalAdSpend;
    acc.tiktokSpend += r.tiktokSpend;
    acc.marketingAgencyFee += r.marketingAgencyFee;
    acc.contributionProfit += r.contributionProfit;
    acc.packaging += r.packaging;
    acc.shippingFeeCharged += r.shippingFeeCharged;
    acc.bostaFeesPaid += r.bostaFeesPaid;
    acc.shippingDifferencesFee += r.shippingDifferencesFee;
    acc.nextDayFee += r.nextDayFee;
    acc.openPackageFee += r.openPackageFee;
    acc.salary += r.salary;
    acc.postProduction += r.postProduction;
    acc.subscription += r.subscription;
    acc.rent += r.rent;
    acc.transportation += r.transportation;
    acc.other += r.other;
    acc.otherIncome += r.otherIncome;
    acc.chatOrders += r.chatOrders;
    acc.chatRevenue += r.chatRevenue;
    acc.chatCogs += r.chatCogs;
    acc.chatItems += r.chatItems;
    acc.bostaPenalty += r.bostaPenalty;
  }
  const overheadsTotal = acc.salary + acc.postProduction + acc.subscription + acc.rent + acc.transportation + acc.other;
  // Owner-added P&L lines, netted: an expense account reduces Net Income, an
  // income account adds to it.
  const customNet = acc.customLines.reduce((s, l) => s + (l.kind === "income" ? l.amount : -l.amount), 0);
  return {
    ...acc,
    // Net Income = Contribution Profit − fixed overheads − Marketing Agency fee
    // − Bosta Penalty − Next Day fee − Open Package fee + Shipping Differences
    // (signed). Matches the monthly view's below-contribution lines. (Open
    // package moved out of Shipping Differences/Bosta Penalty into its own line
    // - net is unchanged.)
    netProfit:
      acc.contributionProfit -
      overheadsTotal -
      acc.marketingAgencyFee -
      acc.bostaPenalty -
      acc.nextDayFee -
      acc.openPackageFee +
      acc.shippingDifferencesFee +
      customNet,
  };
}
