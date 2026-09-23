import "server-only";
import { supabase } from "@/lib/supabase";
import { bostaSearchByBusinessReference, type BostaDelivery } from "@/lib/bosta";

const BATCH_SIZE = 150;
const TIME_BUDGET_MS = 45_000; // leave headroom under Vercel's 60s function limit

// Bosta delivery type codes (confirmed against the live API):
// 10 = Send (forward delivery), 15 = Cash Collection, 20 = Return to Origin,
// 25 = Customer Return Pickup, 30 = Exchange.
const TYPE_SEND = 10;
const TYPE_RTO = 20;
const TYPE_CRP = 25;
const TYPE_EXCHANGE = 30;

const TERMINAL_FAILURE_STATES = new Set([
  "Canceled",
  "Terminated",
  "Lost",
  "Damaged",
  "Returned to business",
  "Exception",
]);

type Outcome = "in_transit" | "delivered" | "failed_rto" | "exchange" | "pickup_return";

type Classification = {
  outcome: Outcome | null; // null = no Bosta record yet at all
  attemptNumber: number;
  codAmount: number | null;
  governorate: string | null;
  resolvedAt: string | null;
  trackingNumber: string | null;
  pickedUpDay: string | null; // null = not physically handed to Bosta yet
};

// The store handle Bosta prefixes every businessReference with - taken from the
// shop domain so it can't drift from the store the orders are synced out of.
function shopifyStoreName(): string {
  const domain = process.env.SHOPIFY_SHOP_DOMAIN;
  if (!domain) throw new Error("Missing SHOPIFY_SHOP_DOMAIN environment variable");
  return domain.replace(/\.myshopify\.com$/, "");
}

// Egypt day = fixed UTC+3 offset, matching toEgyptDay() in sync/shopify-orders.ts
// and the '+ interval 3 hours' the SQL backfill uses.
function toEgyptDay(isoDate: string): string {
  return new Date(new Date(isoDate).getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// The day the package physically reached Bosta, which is what Actual mode
// buckets on - Shopify auto-forwards every order to Bosta the instant it's
// placed (leg state "Created"), but the owner may not hand the package over
// for days, so a "Created" leg proves nothing about a real handover.
// Bosta mutates a leg's type in place on RTO/Exchange rather than adding a
// second leg, so this reads every leg, not just the Send one, and takes the
// EARLIEST stamp so a genuine second shipment (e.g. an Exchange reshipment
// with its own tracking number) never overrides the original pickup date.
function pickedUpDay(legs: BostaDelivery[]): string | null {
  const stamps = legs
    .filter((l) => l.state.value !== "Created" && l.collectedFromBusiness)
    .map((l) => new Date(l.collectedFromBusiness!).getTime())
    .filter((t) => Number.isFinite(t));
  return stamps.length > 0 ? toEgyptDay(new Date(Math.min(...stamps)).toISOString()) : null;
}

// Type wins over state (a Return to Origin can show state "Delivered" and
// that's still a failure). RTO/Exchange/CRP take priority over a plain
// Send leg since their existence is definitive proof of what happened.
function classifyOrder(legs: BostaDelivery[]): Classification {
  if (legs.length === 0) {
    return {
      outcome: null,
      attemptNumber: 0,
      codAmount: null,
      governorate: null,
      resolvedAt: null,
      trackingNumber: null,
      pickedUpDay: null,
    };
  }

  const rtoLegs = legs.filter((l) => l.type.code === TYPE_RTO);
  const exchangeLegs = legs.filter((l) => l.type.code === TYPE_EXCHANGE);
  const crpLegs = legs.filter((l) => l.type.code === TYPE_CRP);
  const sendLegs = legs.filter((l) => l.type.code === TYPE_SEND);

  let outcome: Outcome;
  let resolverLeg: BostaDelivery | undefined;

  if (rtoLegs.length > 0) {
    outcome = "failed_rto";
    resolverLeg = rtoLegs[0];
  } else if (exchangeLegs.length > 0) {
    outcome = "exchange";
    resolverLeg = exchangeLegs[0];
  } else if (crpLegs.length > 0) {
    outcome = "pickup_return";
    resolverLeg = crpLegs[0];
  } else {
    const deliveredSend = sendLegs.find((l) => l.state.value === "Delivered");
    if (deliveredSend) {
      outcome = "delivered";
      resolverLeg = deliveredSend;
    } else if (sendLegs.length > 0 && sendLegs.every((l) => TERMINAL_FAILURE_STATES.has(l.state.value))) {
      outcome = "failed_rto";
      resolverLeg = sendLegs[0];
    } else {
      outcome = "in_transit";
      resolverLeg = undefined;
    }
  }

  const attemptNumber = Math.max(0, ...legs.map((l) => l.attemptsCount ?? 0));

  // Never let a return-leg's cod=0 overwrite a real collected amount.
  const codSource = sendLegs.find((l) => l.cod > 0) ?? legs.find((l) => l.cod > 0);
  const codAmount = codSource ? codSource.cod : null;

  const govSource = sendLegs[0] ?? legs[0];
  const governorate = govSource?.dropOffAddress?.city?.name ?? null;

  return {
    outcome,
    attemptNumber,
    codAmount,
    governorate,
    resolvedAt: outcome === "in_transit" || !resolverLeg ? null : toIso(resolverLeg.updatedAt),
    trackingNumber: legs[0]?.trackingNumber ?? null,
    pickedUpDay: pickedUpDay(legs),
  };
}

// Bosta returns timestamps as JS Date.toString() output
// ("Wed Apr 22 2026 10:50:58 GMT+0000 (Coordinated Universal Time)"),
// not ISO 8601 - Postgres rejects that string as-is.
function toIso(value: string): string {
  return new Date(value).toISOString();
}

type SyncResult = {
  ok: boolean;
  ordersChecked: number;
  ordersMatched: number;
  errors: string[];
};

export async function syncBostaDeliveries(): Promise<SyncResult> {
  const startedAt = Date.now();
  const errors: string[] = [];
  let ordersChecked = 0;
  let ordersMatched = 0;

  try {
    const { data: orders, error: ordersErr } = await supabase
      .from("orders")
      .select("id, order_number")
      .order("last_bosta_sync_at", { ascending: true, nullsFirst: true })
      .order("id", { ascending: true })
      .limit(BATCH_SIZE);
    if (ordersErr) throw new Error(`Failed to read orders: ${ordersErr.message}`);

    for (const order of orders ?? []) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) break;

      // Bosta stores the reference as "<shopify-store>:<order number>", e.g.
      // "tu1ssd-ws:#24135" - Shopify's own integration writes it that way.
      // This used to search the bare order number ("#24135"), which matches
      // NOTHING: verified against the live API, bare returns 0 deliveries and
      // the prefixed form returns 1, on every order tried. That is why
      // bosta_events is empty and bosta_picked_up_day is null on all 35,866
      // orders despite the sync being wired up.
      const businessReference = `${shopifyStoreName()}:${order.order_number}`;
      let legs: BostaDelivery[];
      try {
        legs = await bostaSearchByBusinessReference(businessReference);
      } catch (err) {
        errors.push(`Order ${order.order_number}: ${err instanceof Error ? err.message : "unknown error"}`);
        continue; // leave last_bosta_sync_at untouched so it's retried next run
      }

      ordersChecked++;

      for (const leg of legs) {
        const { error: evErr } = await supabase.from("bosta_events").upsert(
          {
            order_id: order.id,
            bosta_delivery_id: leg.trackingNumber,
            business_reference: leg.businessReference ?? businessReference,
            bosta_type: leg.type.value,
            bosta_state: leg.state.value,
            attempt_number: leg.attemptsCount,
            cod_amount: leg.cod,
            governorate: leg.dropOffAddress?.city?.name ?? null,
            event_timestamp: toIso(leg.updatedAt),
            raw_payload: leg,
            synced_at: new Date().toISOString(),
          },
          { onConflict: "bosta_delivery_id" }
        );
        if (evErr) errors.push(`Order ${order.order_number} event upsert: ${evErr.message}`);
      }

      if (legs.length > 0) {
        ordersMatched++;
        const classification = classifyOrder(legs);
        // bosta_picked_up_day comes from Bosta's own collectedFromBusiness
        // stamp, which is authoritative on when Bosta took the package and is
        // what Actual mode buckets on. It's only written once Bosta reports a
        // real handover (null otherwise), so a manual Shipping Orders entry is
        // never overwritten with a blank. `courier` stays owner-entered.
        const { error: updateErr } = await supabase
          .from("orders")
          .update({
            bosta_tracking_number: classification.trackingNumber,
            ...(classification.pickedUpDay ? { bosta_picked_up_day: classification.pickedUpDay } : {}),
            outcome: classification.outcome,
            outcome_governorate: classification.governorate,
            attempt_number: classification.attemptNumber,
            cod_amount_collected: classification.codAmount,
            resolved_at: classification.resolvedAt,
            last_bosta_sync_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", order.id);
        if (updateErr) errors.push(`Order ${order.order_number} update: ${updateErr.message}`);
      } else {
        // No Bosta record yet (not handed to courier) - just mark as checked.
        const { error: updateErr } = await supabase
          .from("orders")
          .update({ last_bosta_sync_at: new Date().toISOString() })
          .eq("id", order.id);
        if (updateErr) errors.push(`Order ${order.order_number} timestamp update: ${updateErr.message}`);
      }
    }

    return { ok: errors.length === 0, ordersChecked, ordersMatched, errors };
  } catch (err) {
    errors.push(err instanceof Error ? err.message : "unknown error");
    return { ok: false, ordersChecked, ordersMatched, errors };
  }
}
