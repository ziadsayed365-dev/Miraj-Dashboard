import "server-only";
import { supabase } from "@/lib/supabase";
import { normalizeGovernorate } from "@/lib/governorates";
import { fetchAllRows } from "@/lib/fetch-all";
import { daysAgo } from "@/lib/dates";
import { loadBostaFeeBook, type FeeColumn } from "@/lib/bosta-fees";

// Only recompute orders on/after this many days ago by default. Older orders are
// long settled (the courier resolves within days), so their margins never change,
// while a full recompute must fetch all ~86k orders with the nested line-item/
// product join - deep offset pagination over that blows Supabase's statement
// timeout. Pass sinceDay: null for a one-off full historical rebuild (e.g. after
// a cost change or returns re-import); the daily pipeline never needs it.
const DEFAULT_MARGIN_WINDOW_DAYS = 60;

// Egyptian VAT. Bosta's wallet.cashCycle reports each fee line ex-VAT and the
// bosta_fees total VAT-inclusive, so the components are grossed up to match the
// rate card, which has always been stored VAT-inclusive.
const VAT = 1.14;

const FEE_COLUMN_FOR_OUTCOME: Record<string, FeeColumn> = {
  delivered: "deliver",
  failed_rto: "return_to_origin",
  exchange: "exchange",
  pickup_return: "return_pickup",
};

type Settings = {
  packing_cost_per_unit: number;
  refund_rate_default: number;
  damage_rate_default: number;
  default_box_size_tier: string;
  default_success_rate_estimate: number;
};

export async function computeMargins(
  opts?: { sinceDay?: string | null; orderIds?: number[] }
): Promise<{ ok: boolean; lineItemsComputed: number; missingCost: number; error?: string }> {
  try {
    // undefined -> default window; explicit null -> full historical recompute.
    const sinceDay = opts?.sinceDay === undefined ? daysAgo(DEFAULT_MARGIN_WINDOW_DAYS) : opts.sinceDay;
    // Recompute exactly these orders and nothing else. Recording an outcome on a
    // months-old order must not drag every order since that day through a
    // rebuild: those lines would be recomputed against today's costs and
    // calibration, silently restating months of already-reported margins.
    const orderIds = opts?.orderIds ?? null;
    const { data: settingsRow, error: settingsErr } = await supabase.from("settings").select("*").eq("id", 1).single();
    if (settingsErr || !settingsRow) throw new Error(`Failed to load settings: ${settingsErr?.message}`);
    const settings = settingsRow as Settings;

    // Zone rates, the flat open-package fee and the COD "next day" fee, each
    // read as-of the order's own day - Bosta re-priced on 2026-08-04 and closed
    // the open-package fee, and that must not restate margins already reported
    // for the days inside this recompute window.
    const feeBook = await loadBostaFeeBook();

    const { data: modelRows, error: modelErr } = await supabase.from("model_groups").select("*");
    if (modelErr) throw new Error(`Failed to load model_groups: ${modelErr.message}`);
    const models = new Map(modelRows?.map((m) => [m.id, m]));

    // Per-variant costs. A sale names the variant it was made against, and a
    // product's variants can cost different amounts, so this wins over the
    // product's own cost whenever the line has a variant with one set.
    const variantCostRows = await fetchAllRows<{ id: number; unit_cost_override: number | null }>(
      supabase,
      "product_variants",
      "id, unit_cost_override"
    );
    const variantCost = new Map<number, number>();
    for (const v of variantCostRows) {
      if (v.unit_cost_override !== null) variantCost.set(v.id, Number(v.unit_cost_override));
    }

    // Effective-dated cost timeline per model - a cost change made today
    // shouldn't rewrite already-reported historical margins, only apply
    // from its effective date forward. See src/lib/products/catalog.ts for
    // how entries get backdated on a model's first-ever real cost.
    const { data: costHistoryRows, error: costHistoryErr } = await supabase
      .from("model_group_cost_history")
      .select("model_group_id, unit_cost, effective_from")
      .order("effective_from", { ascending: true })
      .order("created_at", { ascending: true });
    if (costHistoryErr) throw new Error(`Failed to load cost history: ${costHistoryErr.message}`);

    const costHistoryByModel = new Map<number, Array<{ effectiveFrom: string; unitCost: number }>>();
    for (const row of costHistoryRows ?? []) {
      const list = costHistoryByModel.get(row.model_group_id) ?? [];
      list.push({ effectiveFrom: row.effective_from, unitCost: Number(row.unit_cost) });
      costHistoryByModel.set(row.model_group_id, list);
    }

    function costAsOf(modelId: number | null, asOfDay: string): number | null {
      if (!modelId) return null;
      const history = costHistoryByModel.get(modelId);
      if (!history) return null;
      let result: number | null = null;
      for (const entry of history) {
        if (entry.effectiveFrom <= asOfDay) result = entry.unitCost;
        else break;
      }
      return result;
    }

    // This table grows by one row per model per day, so rather than pull
    // full history, just find the most recent calibration date and use
    // that day's snapshot (bounded by model count, not history length).
    const { data: latestDateRow, error: latestDateErr } = await supabase
      .from("product_success_rates")
      .select("as_of_date")
      .order("as_of_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestDateErr) throw new Error(`Failed to find latest calibration date: ${latestDateErr.message}`);

    const latestRateByModel = new Map<number, any>();
    if (latestDateRow) {
      const { data: rateRows, error: rateErr } = await supabase
        .from("product_success_rates")
        .select("*")
        .eq("as_of_date", latestDateRow.as_of_date);
      if (rateErr) throw new Error(`Failed to load success rates: ${rateErr.message}`);
      for (const r of rateRows ?? []) latestRateByModel.set(r.model_group_id, r);
    }

    const orders = await fetchAllRows<any>(
      supabase,
      "orders",
      "id, egypt_day, total_price, cod_amount_collected, outcome, outcome_governorate, governorate_shopify, attempt_number, cancelled_at, courier, self_delivered, shipping_fee_charged, bosta_tracking_number, bosta_actual_fee, bosta_actual_open_package_fee, bosta_actual_cod_fee, order_line_items(id, product_id, variant_id, quantity, unit_price, products(id, model_group_id, unit_cost_override))",
      orderIds ? (query) => query.in("id", orderIds) : sinceDay ? (query) => query.gte("egypt_day", sinceDay) : undefined
    );

    let lineItemsComputed = 0;
    let missingCost = 0;
    const updates: Array<{ id: number; values: Record<string, unknown> }> = [];

    for (const order of orders) {
      const lineItems = (order.order_line_items ?? []) as Array<{
        id: number;
        product_id: number | null;
        variant_id: number | null;
        quantity: number;
        unit_price: number;
        products: { id: number; model_group_id: number | null; unit_cost_override: number | null } | null;
      }>;
      if (lineItems.length === 0) continue;

      const totalItemsInOrder = lineItems.reduce((sum, li) => sum + li.quantity, 0);

      if (order.cancelled_at) {
        // A cancellation earns no revenue and returns its stock, so revenue and
        // COGS are always zero. The COURIER cost is not always zero though: if
        // the package had already gone to Bosta it came back, and Bosta billed
        // the return leg plus the open-package fee exactly as for any other
        // return. Only cancellations that never reached a courier are free -
        // and that is most of them (2,412 of 3,222), which is why this is keyed
        // on the tracking number rather than charging every cancellation.
        const reachedCourier = Boolean(order.bosta_tracking_number) && order.self_delivered !== true;
        const cancelledGovernorate =
          normalizeGovernorate(order.outcome_governorate) ?? normalizeGovernorate(order.governorate_shopify);
        const cancelledFees = reachedCourier
          ? feeBook.feesFor(feeBook.zoneFor(cancelledGovernorate), settings.default_box_size_tier, order.egypt_day)
          : null;
        const cancelledOpenPackage = reachedCourier ? feeBook.openPackageFeeTotal(order.egypt_day) : 0;

        for (const li of lineItems) {
          const unitShare = totalItemsInOrder > 0 ? li.quantity / totalItemsInOrder : 0;
          // Priced as a return, because that is what physically happened.
          const courierFee = cancelledFees ? cancelledFees.return_to_origin * unitShare : 0;
          const openPackageFee = cancelledOpenPackage * unitShare;
          updates.push({
            id: li.id,
            values: {
              order_id: order.id,
              quantity: li.quantity,
              unit_price: li.unit_price,
              revenue: 0,
              cost_of_goods: 0,
              allocated_courier_fee: courierFee,
              allocated_open_package_fee: openPackageFee,
              allocated_cod_cash_fee: 0,
              packing_cost: 0,
              refund_adjustment: 0,
              damage_adjustment: 0,
              success_rate_used: null,
              expected_margin: -(courierFee + openPackageFee),
              realized_margin: -(courierFee + openPackageFee),
              fee_breakdown: {
                reason: reachedCourier
                  ? "cancelled in Shopify after reaching the courier - billed as a return"
                  : "cancelled in Shopify before reaching the courier - no courier cost",
                governorate: cancelledGovernorate,
                reachedCourier,
              },
              margin_computed_at: new Date().toISOString(),
            },
          });
          lineItemsComputed++;
        }
        continue;
      }

      const governorate = normalizeGovernorate(order.outcome_governorate) ?? normalizeGovernorate(order.governorate_shopify);
      const zone = feeBook.zoneFor(governorate);
      const fees = feeBook.feesFor(zone, settings.default_box_size_tier, order.egypt_day);

      // What Bosta actually billed for this shipment, pulled from its own
      // wallet.cashCycle by scripts/pull-bosta-fees.mjs.
      //
      // Currently OFF, by the owner's decision: every order is priced from the
      // rate card for its governorate instead, so one governorate always costs
      // the same and the Shipping Differences line is a figure the owner can
      // reproduce by hand. The invoices are more precise (they carry Bosta's
      // per-shipment size surcharges and their real price changes through the
      // year) but they make two orders to the same place cost different
      // amounts, which is what the owner did not want.
      //
      // The data is still being collected and still sits in orders.bosta_actual_*
      // - flipping this one constant switches the whole engine back to invoices.
      const USE_INVOICE_FEES = false;
      const actualFeeTotal = order.bosta_actual_fee === null ? null : Number(order.bosta_actual_fee);
      const hasActual = USE_INVOICE_FEES && actualFeeTotal !== null && Number.isFinite(actualFeeTotal);

      // Flat per-shipment fee Bosta charged regardless of outcome (the courier
      // opens the package at the doorstep whether or not the customer
      // ultimately accepts it) - zero from 2026-08-04. Not in the fee matrix
      // since it never varied by zone/size. Stored ex-VAT on both paths, so the
      // actual is grossed up the same way the fee book's is.
      const openPackageFeeTotal = hasActual
        ? Number(order.bosta_actual_open_package_fee ?? 0) * VAT
        : feeBook.openPackageFeeTotal(order.egypt_day);

      const codBasis = order.cod_amount_collected ?? order.total_price ?? 0;
      const codCashFeeTotal = hasActual
        ? Number(order.bosta_actual_cod_fee ?? 0) * VAT
        : codBasis * feeBook.codCashFeePct(order.egypt_day);

      // The courier's own charge is whatever is left of the invoice once the
      // two lines that get reported separately are taken out - so the three
      // always add back up to exactly what Bosta deducted.
      const actualCourierFee = hasActual ? actualFeeTotal - openPackageFeeTotal - codCashFeeTotal : 0;

      const isMovers = order.courier === "movers";
      // Handed to the customer by us, never by a courier (recorded on the Bosta
      // → Unresolved Orders tab). It is stamped outcome = 'delivered' so it
      // earns revenue and counts in the delivery rate like any other delivery,
      // but there is no courier bill behind it: no delivery fee, no
      // open-package fee, no COD cash fee. Packing still costs what it costs.
      const isSelfDelivered = order.self_delivered === true;

      for (const li of lineItems) {
        const modelId = li.products?.model_group_id ?? null;
        const model = modelId ? models.get(modelId) : null;
        // The variant actually sold wins, then the product's own cost, then the
        // model group's cost read as of the order's own day - so a cost change
        // today doesn't restate already-reported historical margins.
        const lineVariantCost = li.variant_id != null ? variantCost.get(li.variant_id) ?? null : null;
        const unitCost =
          lineVariantCost ?? li.products?.unit_cost_override ?? costAsOf(modelId, order.egypt_day) ?? model?.unit_cost ?? null;
        const costMissing = unitCost === null;
        if (costMissing) missingCost++;

        const revenue = li.quantity * li.unit_price;
        const costOfGoods = (unitCost ?? 0) * li.quantity;
        const packing = settings.packing_cost_per_unit * li.quantity;
        const unitShare = totalItemsInOrder > 0 ? li.quantity / totalItemsInOrder : 0;
        // Movers has no real fee schedule yet - placeholder is the Shopify
        // shipping fee charged (so Shipping Differences Fee nets to zero),
        // with no open-package/COD-cash fee until real numbers are given.
        const shippingFeeShare = (order.shipping_fee_charged ?? 0) * unitShare;
        const codCashFeeShare = isMovers || isSelfDelivered ? 0 : codCashFeeTotal * unitShare;
        const openPackageFeeShare = isMovers || isSelfDelivered ? 0 : openPackageFeeTotal * unitShare;
        const refundRate = model?.refund_rate_override ?? settings.refund_rate_default;
        const damageRate = model?.damage_rate_override ?? settings.damage_rate_default;

        function feeFor(outcome: string): number {
          if (isSelfDelivered) return 0; // no courier, so no courier fee for any outcome
          if (isMovers) return shippingFeeShare;
          // Bosta already billed this shipment, and that one number covers
          // however it ended - a return's fee is what the invoice says, not a
          // separate return_to_origin rate. So it applies to every outcome
          // column, including the projected branch's delivered/RTO blend.
          if (hasActual) return actualCourierFee * unitShare;
          if (!fees) return 0;
          const col = FEE_COLUMN_FOR_OUTCOME[outcome];
          return col ? fees[col] * unitShare : 0;
        }

        // "Gross" = before the refund/damage risk haircuts; these haircuts
        // are modeled as expected-value deductions, applied in full for a
        // realized outcome and probability-weighted for a projected one -
        // so every adjustment field below is reported on that same
        // consistent (always a deduction, always signed negative) basis.
        const grossDeliveredMargin = revenue - costOfGoods - feeFor("delivered") - codCashFeeShare - packing - openPackageFeeShare;
        const refundHaircut = grossDeliveredMargin * refundRate;
        const deliveredMargin = grossDeliveredMargin - refundHaircut;
        const damageHaircut = costOfGoods * damageRate;
        const failedMargin = -feeFor("failed_rto") - packing - damageHaircut - openPackageFeeShare;

        const breakdown: Record<string, unknown> = {
          governorate,
          zone,
          boxSize: settings.default_box_size_tier,
          unitShare,
          codBasis,
          costMissing,
          isMovers,
          // "invoice" = Bosta's own billed amount, "rate-card" = modelled from
          // bosta_fee_matrix. Worth keeping: it's the difference between a fee
          // that can be reconciled against a Bosta statement and one that can't.
          feeSource: hasActual ? "invoice" : "rate-card",
        };

        let expectedMargin: number;
        let realizedMargin: number | null;
        let successRateUsed: number | null = null;
        let reportedCourierFee: number;
        let reportedCodCashFee = 0;
        let reportedRefundAdj = 0;
        let reportedDamageAdj = 0;

        if (order.outcome === "delivered") {
          expectedMargin = deliveredMargin;
          realizedMargin = deliveredMargin;
          reportedCourierFee = feeFor("delivered");
          reportedCodCashFee = codCashFeeShare;
          reportedRefundAdj = -refundHaircut;
          breakdown.formula = "delivered";
        } else if (order.outcome === "failed_rto") {
          expectedMargin = failedMargin;
          realizedMargin = failedMargin;
          reportedCourierFee = feeFor("failed_rto");
          reportedDamageAdj = -damageHaircut;
          breakdown.formula = "failed_rto";
        } else if (order.outcome === "exchange" || order.outcome === "pickup_return") {
          const fee = feeFor(order.outcome);
          const margin = -fee - packing - damageHaircut - openPackageFeeShare;
          expectedMargin = margin;
          realizedMargin = margin;
          reportedCourierFee = fee;
          reportedDamageAdj = -damageHaircut;
          breakdown.formula = order.outcome;
        } else {
          // in_transit or not yet handed to courier - project using calibrated
          // success rate. Movers orders always land here too: there's no API
          // integration, so outcome never resolves, and this is the same
          // calibrated-rate mechanism Bosta orders use while unresolved.
          const modelId = li.products?.model_group_id ?? null;
          const rateRow = modelId ? latestRateByModel.get(modelId) : null;
          const attemptKey = !order.attempt_number || order.attempt_number <= 1 ? "1" : order.attempt_number === 2 ? "2" : "3+";
          successRateUsed = Number(rateRow?.attempt_adjusted_rates?.[attemptKey] ?? settings.default_success_rate_estimate);
          expectedMargin = successRateUsed * deliveredMargin + (1 - successRateUsed) * failedMargin;
          realizedMargin = null;
          reportedCourierFee = successRateUsed * feeFor("delivered") + (1 - successRateUsed) * feeFor("failed_rto");
          reportedCodCashFee = successRateUsed * codCashFeeShare;
          reportedRefundAdj = -successRateUsed * refundHaircut;
          reportedDamageAdj = -(1 - successRateUsed) * damageHaircut;
          breakdown.formula = "projected";
          breakdown.attemptKey = attemptKey;
        }

        updates.push({
          id: li.id,
          values: {
            // Postgres validates NOT NULL columns even on the ON CONFLICT
            // DO UPDATE path, so these have to be included even though
            // they never actually change here.
            order_id: order.id,
            quantity: li.quantity,
            unit_price: li.unit_price,
            revenue,
            cost_of_goods: costOfGoods,
            allocated_courier_fee: reportedCourierFee,
            allocated_open_package_fee: openPackageFeeShare,
            allocated_cod_cash_fee: reportedCodCashFee,
            packing_cost: packing,
            refund_adjustment: reportedRefundAdj,
            damage_adjustment: reportedDamageAdj,
            success_rate_used: successRateUsed,
            expected_margin: expectedMargin,
            realized_margin: realizedMargin,
            fee_breakdown: breakdown,
            margin_computed_at: new Date().toISOString(),
          },
        });
        lineItemsComputed++;
      }
    }

    const BATCH_SIZE = 500;
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE).map((u) => ({ id: u.id, ...u.values }));
      const { error } = await supabase.from("order_line_items").upsert(batch, { onConflict: "id" });
      if (error) throw new Error(`Failed to batch-update line items: ${error.message}`);
    }

    return { ok: true, lineItemsComputed, missingCost };
  } catch (err) {
    return { ok: false, lineItemsComputed: 0, missingCost: 0, error: err instanceof Error ? err.message : "unknown error" };
  }
}
