import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";
import { firstOfMonth, firstOfNextMonth, addDays } from "@/lib/dates";

export const dynamic = "force-dynamic";

// The orders behind one month of the Delivery Rate tab's Overall business row,
// so clicking a rate (or its "still open" badge) can download exactly which
// orders it was computed from. Same inclusion rule as the tab itself: bucketed
// by egypt_day (the "performance" basis), with EVERY order that came in that
// month - cancellations and orders never handed to a courier included, since
// both sit in the rate's denominator. The file's row count is therefore the
// denominator itself; it used to drop cancellations and come up short of it.

const RESOLVED_OUTCOMES = ["delivered", "failed_rto", "exchange", "pickup_return"];

// The four words this export uses for what became of an order, and the same
// four IZAR's Analysis export uses (src/lib/shipping/analysis-export.ts there),
// so one file reads like the other. "Never handed to courier" is a status in
// its own right rather than a blank or an "In progress": nothing is in
// progress, nobody is carrying it - and it counts against the rate exactly like
// a failed delivery, since the customer never got the order either way.
//
// Whether the order was also CANCELLED is a separate column, not a status, so a
// cancellation never hides what actually happened to the package.
export type DeliveryOrderStatus = "Delivered" | "Not delivered" | "In progress" | "Never handed to courier";

export type DeliveryOrderRow = {
  orderNumber: string;
  day: string;
  status: DeliveryOrderStatus;
  outcome: string | null; // raw courier outcome, null while still moving
  cancelled: boolean;
  trackingNumber: string | null;
  governorate: string | null;
  courier: string | null;
  totalPrice: number | null;
};

function statusOf(r: OrderRow): DeliveryOrderStatus {
  if (!handedOver(r)) return "Never handed to courier";
  if (r.outcome === "delivered") return "Delivered";
  if (RESOLVED_OUTCOMES.includes(r.outcome ?? "")) return "Not delivered";
  return "In progress";
}

type OrderRow = {
  order_number: string;
  egypt_day: string;
  outcome: string | null;
  cancelled_at: string | null;
  self_delivered: boolean | null;
  bosta_tracking_number: string | null;
  outcome_governorate: string | null;
  governorate_shopify: string | null;
  courier: string | null;
  total_price: number | null;
};

const ORDER_COLUMNS =
  "order_number, egypt_day, outcome, cancelled_at, self_delivered, bosta_tracking_number, outcome_governorate, governorate_shopify, courier, total_price";

// Must stay in lockstep with isHandedToCourier() in src/lib/reports/actual-mode.ts
// and with monthly_order_mix()'s never_handed (migration 0081).
const handedOver = (r: OrderRow) => r.bosta_tracking_number !== null || r.self_delivered === true;

export async function GET(request: NextRequest) {
  const role = verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);
  if (!role) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const month = url.searchParams.get("month") ?? "";
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ ok: false, error: "month must be YYYY-MM" }, { status: 400 });
  }
  const from = firstOfMonth(month + "-01");
  const to = addDays(firstOfNextMonth(from), -1);

  // Which badge was clicked, or the whole denominator when absent:
  //   in_progress  - at a courier with no final outcome yet. Cancellations are
  //                  settled, and an order no courier ever had is not "in
  //                  progress" with anyone, so both stay out.
  //   never_handed - no courier ever received it, whatever became of it after.
  const status = url.searchParams.get("status");
  const inProgressOnly = status === "in_progress";
  const neverHandedOnly = status === "never_handed";

  try {
    const rows = await fetchAllRows<OrderRow>(supabase, "orders", ORDER_COLUMNS, (q) => {
      const query = q.gte("egypt_day", from).lte("egypt_day", to);
      // The handover half of each filter is applied in JS below, off the same
      // handedOver() both slices use - two .or() clauses on one PostgREST query
      // is a much easier thing to get quietly wrong.
      return inProgressOnly
        ? query.is("cancelled_at", null).or(`outcome.is.null,outcome.not.in.(${RESOLVED_OUTCOMES.join(",")})`)
        : query;
    });

    const orders: DeliveryOrderRow[] = rows
      .filter((r) => {
        if (inProgressOnly) return handedOver(r);
        if (neverHandedOnly) return !handedOver(r);
        return true;
      })
      .map((r) => ({
        orderNumber: r.order_number,
        day: r.egypt_day,
        status: statusOf(r),
        outcome: r.outcome,
        cancelled: r.cancelled_at !== null,
        trackingNumber: r.bosta_tracking_number,
        governorate: r.outcome_governorate ?? r.governorate_shopify,
        // orders.courier is owner-entered and has never been filled on a single
        // Miraj order (see migration 0076), so the column is derived from what
        // the order actually carries instead of exporting 9,000 blanks.
        courier: r.bosta_tracking_number !== null ? "Bosta" : r.self_delivered === true ? "Self" : r.courier,
        totalPrice: r.total_price === null ? null : Number(r.total_price),
      }))
      .sort((a, b) => (a.day === b.day ? a.orderNumber.localeCompare(b.orderNumber) : a.day < b.day ? -1 : 1));

    return NextResponse.json({ ok: true, orders });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}
