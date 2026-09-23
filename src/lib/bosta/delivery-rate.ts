import "server-only";
import { supabase } from "@/lib/supabase";
import { getDailyPnl } from "@/lib/reports/daily-pnl";
import { egyptToday } from "@/lib/dates";
import type { MonthlyOrderMix, MonthlyRate, ModelDeliveryGroup, ProductMonthlyRate, ProductRatesResult, RateCell } from "./shared";

const MONTHLY_START = "2025-07";
const ALL_TIME_START = "2000-01-01";

// Overall business delivery rate per month = delivered ÷ every order received,
// from the same order figures the Income Statement uses (getDailyPnl's daily
// rows, aggregated by month), so it matches the P&L's Delivery Rate line
// exactly. The denominator is ordersReceived, not ordersPlaced: cancellations
// and orders nobody ever shipped still count against the rate, since the
// question is "of everything Shopify took, how much reached a customer".
export async function getOverallMonthlyRates(): Promise<MonthlyRate[]> {
  const [pnl, mixByMonth] = await Promise.all([getDailyPnl(ALL_TIME_START, egyptToday(), "performance"), getMonthlyOrderMix()]);
  const byMonth = new Map<string, { received: number; placed: number; delivered: number; resolved: number }>();
  for (const r of pnl.rows) {
    const m = r.date.slice(0, 7);
    if (m < MONTHLY_START) continue;
    if (!byMonth.has(m)) byMonth.set(m, { received: 0, placed: 0, delivered: 0, resolved: 0 });
    const e = byMonth.get(m)!;
    e.received += r.ordersReceived;
    e.placed += r.ordersPlaced;
    e.delivered += r.ordersDelivered;
    e.resolved += r.ordersResolved;
  }
  return [...byMonth.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([month, v]) => ({
      month,
      received: v.received,
      delivered: v.delivered,
      // Not resolved to any final outcome yet. Measured off ordersPlaced, not
      // the wider received figure - a cancellation is settled, not pending.
      // Never negative even if a count ever disagrees. `mix` splits it into the
      // orders Bosta actually has and the ones no courier ever received.
      inProgress: Math.max(0, v.placed - v.resolved),
      rate: v.received ? v.delivered / v.received : null,
      mix: mixByMonth.get(month) ?? null,
    }));
}

// What each month's denominator is made of, via the monthly_order_mix SQL
// function (migration 0081) - counts only, so the rate itself keeps coming from
// the same daily_pnl figures the Income Statement uses. An empty map (the
// function not installed yet) just costs the tab its breakdown.
async function getMonthlyOrderMix(): Promise<Map<string, MonthlyOrderMix>> {
  const { data, error } = await supabase.rpc("monthly_order_mix");
  if (error) return new Map();
  const rows = (data ?? []) as {
    month: string;
    cancelled: number;
    never_handed: number;
    open_at_courier: number;
    open_never_handed: number;
  }[];
  return new Map(
    rows.map((r) => [
      r.month,
      {
        cancelled: Number(r.cancelled),
        neverHanded: Number(r.never_handed),
        openAtCourier: Number(r.open_at_courier),
        openNeverHanded: Number(r.open_never_handed),
      },
    ])
  );
}

// Per-product per-month delivered ÷ every order-line received, via the
// product_monthly_delivery SQL function - a single aggregated round-trip. The
// denominator is deliberately the same one the Overall business row uses above:
// cancellations and orders never handed to a courier are both in it (migration
// 0080), so a model's rate can be read straight against the business total
// rather than sitting a few points above it on a narrower population. If the
// function isn't installed yet, signal the UI to show the one-time setup note
// (aggregating ~127k order-lines in-app is too slow for a page load).
export async function getProductMonthlyRates(): Promise<ProductRatesResult> {
  const { data: products } = await supabase.from("products").select("id, name, model_group_id");
  const nameById = new Map((products ?? []).map((p) => [p.id as number, p.name as string]));
  const modelIdByProduct = new Map((products ?? []).map((p) => [p.id as number, (p.model_group_id as number | null) ?? null]));

  const { data: modelRows } = await supabase.from("model_groups").select("id, name");
  const modelName = new Map((modelRows ?? []).map((m) => [m.id as number, m.name as string]));

  const { data, error } = await supabase.rpc("product_monthly_delivery");
  if (error) return { groups: [], months: [], rpcMissing: true };

  const rows = (data ?? []) as { product_id: number; month: string; received: number; delivered: number }[];
  return assembleProductRates(
    rows.map((r) => ({ productId: Number(r.product_id), month: r.month, received: Number(r.received), delivered: Number(r.delivered) })),
    nameById,
    (productId) => {
      const mid = modelIdByProduct.get(productId) ?? null;
      return mid == null ? "(no model)" : modelName.get(mid) ?? `#${mid}`;
    }
  );
}

// Turns delivered/received per product per month into products grouped under
// their model, each model carrying a per-month subtotal (Σ its products). Rate
// is always derived from the summed counts, never averaged from child rates.
function assembleProductRates(
  rows: { productId: number; month: string; received: number; delivered: number }[],
  nameById: Map<number, string>,
  modelKeyFor: (productId: number) => string
): ProductRatesResult {
  const monthsSet = new Set<string>();
  const byProduct = new Map<number, ProductMonthlyRate>();
  for (const r of rows) {
    if (r.month < MONTHLY_START) continue;
    monthsSet.add(r.month);
    if (!byProduct.has(r.productId)) {
      byProduct.set(r.productId, { productId: r.productId, name: nameById.get(r.productId) ?? `#${r.productId}`, byMonth: {} });
    }
    byProduct.get(r.productId)!.byMonth[r.month] = {
      received: r.received,
      delivered: r.delivered,
      rate: r.received ? r.delivered / r.received : null,
    };
  }

  const totalReceived = (p: ProductMonthlyRate) => Object.values(p.byMonth).reduce((s, x) => s + x.received, 0);

  const byModel = new Map<string, ProductMonthlyRate[]>();
  for (const p of byProduct.values()) {
    const key = modelKeyFor(p.productId);
    const list = byModel.get(key) ?? [];
    list.push(p);
    byModel.set(key, list);
  }

  const groups: ModelDeliveryGroup[] = [...byModel.entries()].map(([modelKey, products]) => {
    const byMonth: Record<string, RateCell> = {};
    for (const p of products) {
      for (const [month, cell] of Object.entries(p.byMonth)) {
        const agg = byMonth[month] ?? { received: 0, delivered: 0, rate: null };
        agg.received += cell.received;
        agg.delivered += cell.delivered;
        byMonth[month] = agg;
      }
    }
    for (const cell of Object.values(byMonth)) cell.rate = cell.received ? cell.delivered / cell.received : null;
    return {
      modelKey,
      byMonth,
      products: products.sort((a, b) => totalReceived(b) - totalReceived(a)),
    };
  });

  // Biggest models first; the catch-all "(no model)" sinks to the bottom.
  const groupReceived = (g: ModelDeliveryGroup) => Object.values(g.byMonth).reduce((s, x) => s + x.received, 0);
  groups.sort((a, b) => {
    if (a.modelKey === "(no model)") return 1;
    if (b.modelKey === "(no model)") return -1;
    return groupReceived(b) - groupReceived(a);
  });

  return { groups, months: [...monthsSet].sort(), rpcMissing: false };
}
