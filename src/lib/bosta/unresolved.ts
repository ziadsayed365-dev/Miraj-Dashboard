import "server-only";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";
import { egyptToday } from "@/lib/dates";
import { computeMargins } from "@/lib/engine/margin";
import type { ResolveAction, UnresolvedOrder } from "./shared";

// Orders that Bosta will never resolve on its own.
//
// Shopify auto-forwards every order to Bosta, but some are handed to the
// customer privately instead, so Bosta has no record of them: the delivery sync
// finds nothing, and they sit at 'in_transit' forever. That costs twice - the
// delivery rate counts them against you, and revenue is only recognised on a
// delivered order, so their money never reaches the Income Statement. This tab
// lists them so the real outcome can be recorded.

const RESOLVED_OUTCOMES = ["delivered", "failed_rto", "exchange", "pickup_return"];

type Row = {
  id: number;
  order_number: string;
  egypt_day: string;
  outcome: string | null;
  bosta_tracking_number: string | null;
  bosta_picked_up_day: string | null;
  shopify_fulfillment_status: string | null;
  outcome_governorate: string | null;
  governorate_shopify: string | null;
  total_price: number | null;
};

// The only two Shopify fulfilment states that mean "a person marked this
// fulfilled", with no fulfilment service behind it. Deliberately a whitelist,
// not a list of courier statuses to exclude: Shopify has a dozen of those
// (CONFIRMED, SUBMITTED, LABEL_PRINTED, OUT_FOR_DELIVERY, PICKED_UP, ...) and
// any one we failed to list would be silently mistaken for a hand delivery.
// This way an unrecognised status is never treated as one.
const HAND_FULFILLED_STATUSES = ["FULFILLED", "MARKED_AS_FULFILLED"];

function isHandFulfilled(status: string | null): boolean {
  if (!status) return false;
  return status.split(",").every((s) => HAND_FULFILLED_STATUSES.includes(s.trim()));
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000);
}

export async function listUnresolvedOrders(): Promise<UnresolvedOrder[]> {
  const rows = await fetchAllRows<Row>(
    supabase,
    "orders",
    "id, order_number, egypt_day, outcome, bosta_tracking_number, bosta_picked_up_day, shopify_fulfillment_status, outcome_governorate, governorate_shopify, total_price",
    (q) => q.is("cancelled_at", null).or(`outcome.is.null,outcome.not.in.(${RESOLVED_OUTCOMES.join(",")})`)
  );

  const today = egyptToday();
  return rows
    .map((r) => {
      const status = r.shopify_fulfillment_status;
      const atCourier = r.bosta_tracking_number !== null || r.bosta_picked_up_day !== null;
      return {
        orderNumber: r.order_number,
        day: r.egypt_day,
        ageDays: daysBetween(r.egypt_day, today),
        atCourier,
        shopifyStatus: status,
        // Shopify says it was fulfilled, but nothing about it ever went near a
        // courier: no scan status of its own, no tracking number, no pickup
        // stamp. Someone marked it fulfilled by hand - i.e. delivered it.
        handFulfilled: isHandFulfilled(status) && !atCourier,
        governorate: r.outcome_governorate ?? r.governorate_shopify,
        totalPrice: r.total_price === null ? null : Number(r.total_price),
      };
    })
    .sort((a, b) => (a.day === b.day ? a.orderNumber.localeCompare(b.orderNumber) : a.day < b.day ? -1 : 1));
}

export type ResolveResult = { matched: number; notFound: string[]; earliestDay: string | null };

// Applies a recorded outcome to a set of order numbers, then rebuilds the
// margins for every day from the earliest one touched - the per-line courier
// fees, revenue and COGS all change with the outcome, and the Income Statement
// reads those stored values.
export async function resolveOrders(orderNumbers: string[], action: ResolveAction): Promise<ResolveResult> {
  const wanted = [...new Set(orderNumbers.map((n) => n.trim()).filter(Boolean))];
  if (wanted.length === 0) return { matched: 0, notFound: [], earliestDay: null };

  const { data: found, error: findErr } = await supabase
    .from("orders")
    .select("id, order_number, egypt_day")
    .in("order_number", wanted);
  if (findErr) throw new Error(`Failed to look up orders: ${findErr.message}`);

  const rows = (found ?? []) as { id: number; order_number: string; egypt_day: string }[];
  const foundNumbers = new Set(rows.map((r) => r.order_number));
  const notFound = wanted.filter((n) => !foundNumbers.has(n));
  if (rows.length === 0) return { matched: 0, notFound, earliestDay: null };

  const now = new Date().toISOString();
  // "delivered_private" is the whole point of this screen: stamp it delivered so
  // every existing delivered rule applies, and flag it so the margin engine
  // bills it no courier fees (see migration 0056).
  const values: Record<string, unknown> =
    action === "delivered_private"
      ? { outcome: "delivered", self_delivered: true, resolved_at: now, cancelled_at: null }
      : action === "returned"
        ? { outcome: "failed_rto", self_delivered: false, resolved_at: now, cancelled_at: null }
        : action === "cancelled"
          ? { cancelled_at: now, self_delivered: false }
          : // undo - back to "still moving", so the Bosta sync can take it over
            // again if the order does turn out to be with the courier.
            { outcome: "in_transit", self_delivered: false, resolved_at: null, cancelled_at: null };

  const { error: updErr } = await supabase
    .from("orders")
    .update(values)
    .in("id", rows.map((r) => r.id));
  if (updErr) throw new Error(`Failed to update orders: ${updErr.message}`);

  // Only the orders just recorded. A wider rebuild would recompute every order
  // since the oldest one touched against today's costs and calibration, quietly
  // restating months of already-reported margins.
  const result = await computeMargins({ orderIds: rows.map((r) => r.id) });
  if (!result.ok) throw new Error(`Outcomes saved, but the margin rebuild failed: ${result.error ?? "unknown error"}`);

  const earliestDay = rows.reduce((min, r) => (min === null || r.egypt_day < min ? r.egypt_day : min), null as string | null);
  return { matched: rows.length, notFound, earliestDay };
}
