import "server-only";
import { supabase } from "@/lib/supabase";
import { egyptToday } from "@/lib/dates";
import { normalizeOrderNumber } from "./shared";
import type { ShippingCourier, BulkRecordSummary, ShipperSummary, RecentShipment } from "./shared";

export type { ShippingCourier, BulkRecordSummary, ShipperSummary, RecentShipment } from "./shared";

// Both Movers and Bosta orders are recorded manually here (the owner tells us
// which Shopify orders were handed to each courier and on what date). Bosta's
// API sync only learns delivered/returned outcomes for the delivery rate - it
// no longer decides which orders shipped or when (see src/lib/sync/bosta-deliveries.ts).

// The column Actual mode buckets each courier's orders under (see effectiveDay
// in src/lib/reports/daily-pnl.ts and src/lib/reports/per-product.ts). egypt_day
// is never touched, so Performance mode is unaffected.
const DATE_COLUMN: Record<ShippingCourier, string> = {
  movers: "movers_record_date",
  bosta: "bosta_picked_up_day",
};

// Normalize + dedupe whatever the caller passes (a pasted blob or an array).
function toNumbers(raw: string[] | string): string[] {
  const arr = Array.isArray(raw) ? raw : raw.split(/[\s,;]+/);
  const seen = new Set<string>();
  for (const token of arr) {
    const t = token.trim();
    if (t) seen.add(normalizeOrderNumber(t));
  }
  return [...seen];
}

type FoundOrder = {
  id: number;
  order_number: string;
  courier: string | null;
  cancelled_at: string | null;
  bosta_tracking_number: string | null;
};

export async function bulkRecordOrders(
  rawNumbers: string[] | string,
  courier: ShippingCourier,
  date?: string
): Promise<BulkRecordSummary> {
  const dateCol = DATE_COLUMN[courier];
  const recordDate = date || egyptToday();
  const numbers = toNumbers(rawNumbers);

  const summary: BulkRecordSummary = {
    courier,
    date: recordDate,
    requested: numbers.length,
    matched: 0,
    alreadyRecorded: 0,
    notFound: [],
    cancelled: [],
    handedToBosta: [],
  };
  if (numbers.length === 0) return summary;

  // Look the orders up first so typos (numbers matching no order) and
  // cancelled ones are reported rather than silently no-op'd.
  const { data: found, error: findErr } = await supabase
    .from("orders")
    .select("id, order_number, courier, cancelled_at, bosta_tracking_number")
    .in("order_number", numbers);
  if (findErr) throw new Error(`Failed to look up orders: ${findErr.message}`);

  const byNumber = new Map(((found ?? []) as unknown as FoundOrder[]).map((o) => [o.order_number, o]));
  const toUpdate: number[] = [];

  for (const num of numbers) {
    const order = byNumber.get(num);
    if (!order) {
      summary.notFound.push(num);
      continue;
    }
    if (order.cancelled_at) {
      summary.cancelled.push(num);
      continue;
    }
    // An order Bosta physically has a tracking leg for can't be reassigned to
    // Movers. Bosta has no such restriction (the owner is the source of truth).
    if (courier === "movers" && order.bosta_tracking_number) {
      summary.handedToBosta.push(num);
      continue;
    }
    if (order.courier === courier) summary.alreadyRecorded++;
    toUpdate.push(order.id);
  }

  if (toUpdate.length > 0) {
    // Same courier + date for the whole batch, so one update over the matched
    // ids. egypt_day is left untouched (Performance mode unaffected). Re-recording
    // an order just overwrites its date/courier (idempotent) so mistakes can be
    // corrected.
    const update: Record<string, string | null> = {
      courier,
      [dateCol]: recordDate,
      updated_at: new Date().toISOString(),
    };
    const { error: updErr } = await supabase.from("orders").update(update).in("id", toUpdate);
    if (updErr) throw new Error(`Failed to record orders: ${updErr.message}`);
  }

  summary.matched = toUpdate.length;
  return summary;
}

async function countOrders(courier: ShippingCourier, outcome?: string): Promise<number> {
  let query = supabase.from("orders").select("id", { count: "exact", head: true }).eq("courier", courier);
  if (outcome) query = query.eq("outcome", outcome);
  const { count, error } = await query;
  if (error) throw new Error(`Failed to count ${courier} orders: ${error.message}`);
  return count ?? 0;
}

// Per-shipper headline: how many orders are recorded against this courier
// ("Shipped"), how many came back ("Returned"), and the delivery rate.
// Delivery rate = delivered / (delivered + RTO returns), the same definition the
// monthly rate engine uses (src/lib/engine/monthly-rate.ts). Returns (failed_rto)
// come from the Bosta API sync (src/lib/sync/bosta-deliveries.ts) - Movers has no
// courier API, so its rate stays null until/unless outcomes exist.
export async function getShipperSummary(courier: ShippingCourier): Promise<ShipperSummary> {
  const [orders, delivered, returned] = await Promise.all([
    countOrders(courier),
    countOrders(courier, "delivered"),
    countOrders(courier, "failed_rto"),
  ]);
  const resolved = delivered + returned;
  return { courier, orders, delivered, returned, deliveryRate: resolved > 0 ? delivered / resolved : null };
}

// The most recently recorded shipments across the given couriers, newest first.
// Each courier is dated by its own column, so they're fetched separately and
// merged (no single date column to order across both in one query).
export async function getRecentShipments(couriers: ShippingCourier[], limit = 50): Promise<RecentShipment[]> {
  const all: RecentShipment[] = [];
  for (const courier of couriers) {
    const dateCol = DATE_COLUMN[courier];
    const { data, error } = await supabase
      .from("orders")
      .select(`order_number, record_date:${dateCol}, total_price`)
      .eq("courier", courier)
      .order(dateCol, { ascending: false })
      .order("id", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`Failed to load recent ${courier} shipments: ${error.message}`);
    const rows = (data ?? []) as unknown as { order_number: string; record_date: string; total_price: number | null }[];
    for (const r of rows) {
      all.push({ orderNumber: r.order_number, date: r.record_date, courier, totalPrice: r.total_price });
    }
  }
  all.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return all.slice(0, limit);
}
