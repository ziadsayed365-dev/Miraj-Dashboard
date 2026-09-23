import "server-only";
import { supabase } from "@/lib/supabase";
import { egyptToday } from "@/lib/dates";

export type MoversOrder = {
  id: number;
  orderNumber: string;
  date: string; // movers_record_date - the date Actual mode bucket this order under
};

// Shopify stores order_number with a leading "#" (e.g. "#4756") - normalize
// whatever the user types so lookups match regardless of whether they
// included it.
function normalizeOrderNumber(input: string): string {
  const trimmed = input.trim();
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

export async function getMoversOrders(): Promise<MoversOrder[]> {
  const { data, error } = await supabase
    .from("orders")
    .select("id, order_number, movers_record_date")
    .eq("courier", "movers")
    .order("movers_record_date", { ascending: false })
    .order("id", { ascending: false });
  if (error) throw new Error(`Failed to load Movers orders: ${error.message}`);
  return (data ?? []).map((r) => ({ id: r.id, orderNumber: r.order_number, date: r.movers_record_date }));
}

export async function flagOrderAsMovers(rawOrderNumber: string, date?: string): Promise<MoversOrder> {
  const orderNumber = normalizeOrderNumber(rawOrderNumber);
  const recordDate = date || egyptToday();

  const { data: order, error: findErr } = await supabase
    .from("orders")
    .select("id, order_number, courier, bosta_tracking_number")
    .eq("order_number", orderNumber)
    .maybeSingle();
  if (findErr) throw new Error(`Failed to look up order: ${findErr.message}`);
  if (!order) throw new Error(`Order ${orderNumber} is not in Shopify - check the number or wait for it to sync.`);
  if (order.courier === "movers") throw new Error(`Order ${orderNumber} is already flagged as Movers`);
  // bosta_tracking_number (not the courier column, which is still forced
  // to a placeholder "bosta" value while its NOT NULL constraint is
  // pending migration) is the real signal that Bosta actually has this order.
  if (order.bosta_tracking_number)
    throw new Error(`Order ${orderNumber} has already been handed to Bosta and can't be reassigned to Movers.`);

  // egypt_day is left untouched - it always stays the real Shopify order
  // date, same as for Bosta orders, so Performance mode reflects reality.
  // movers_record_date is the separate field Actual mode buckets this
  // order under once handed to Movers.
  const { error: updateErr } = await supabase
    .from("orders")
    .update({ courier: "movers", movers_record_date: recordDate, updated_at: new Date().toISOString() })
    .eq("id", order.id);
  if (updateErr) throw new Error(`Failed to flag order: ${updateErr.message}`);

  return { id: order.id, orderNumber: order.order_number, date: recordDate };
}

export async function unflagMoversOrders(ids: number[]): Promise<void> {
  if (ids.length === 0) return;

  const { error } = await supabase
    .from("orders")
    .update({ courier: null, movers_record_date: null, updated_at: new Date().toISOString() })
    .in("id", ids);
  if (error) throw new Error(`Failed to unflag orders: ${error.message}`);
}

export type MoversOrderReportRow = {
  id: number;
  orderNumber: string;
  date: string;
  updatedAt: string;
  itemsSold: number;
  revenue: number;
  cogs: number;
  courierFee: number;
  margin: number;
};

type MoversOrderRow = {
  id: number;
  order_number: string;
  movers_record_date: string;
  updated_at: string;
  order_line_items: {
    quantity: number;
    revenue: number | null;
    cost_of_goods: number | null;
    allocated_courier_fee: number | null;
    expected_margin: number | null;
  }[];
};

// Reads margin.ts's precomputed per-line-item figures - only current as of
// the last Sync (margin.ts only recomputes when /api/sync/run runs).
// updatedAt lets the Report tab also gate on the last Sync, the same way
// the Record Data report does.
export async function getMoversOrdersReport(): Promise<MoversOrderReportRow[]> {
  const { data, error } = await supabase
    .from("orders")
    .select(
      "id, order_number, movers_record_date, updated_at, order_line_items(quantity, revenue, cost_of_goods, allocated_courier_fee, expected_margin)"
    )
    .eq("courier", "movers")
    .order("movers_record_date", { ascending: false })
    .order("id", { ascending: false });
  if (error) throw new Error(`Failed to load Movers orders report: ${error.message}`);

  return ((data ?? []) as unknown as MoversOrderRow[]).map((o) => {
    const lineItems = o.order_line_items ?? [];
    return {
      id: o.id,
      orderNumber: o.order_number,
      date: o.movers_record_date,
      updatedAt: o.updated_at,
      itemsSold: lineItems.reduce((sum, li) => sum + (li.quantity ?? 0), 0),
      revenue: lineItems.reduce((sum, li) => sum + Number(li.revenue ?? 0), 0),
      cogs: lineItems.reduce((sum, li) => sum + Number(li.cost_of_goods ?? 0), 0),
      courierFee: lineItems.reduce((sum, li) => sum + Number(li.allocated_courier_fee ?? 0), 0),
      margin: lineItems.reduce((sum, li) => sum + Number(li.expected_margin ?? 0), 0),
    };
  });
}
