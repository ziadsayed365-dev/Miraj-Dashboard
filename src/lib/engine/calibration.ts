import "server-only";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";

const RESOLVED_OUTCOMES = ["delivered", "failed_rto"];
const MATURITY_DAYS = 15;

function egyptToday(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export async function runCalibration(): Promise<{ ok: boolean; modelsCalibrated: number; storeWideRate: number; error?: string }> {
  try {
    const { data: settings, error: settingsErr } = await supabase.from("settings").select("*").eq("id", 1).single();
    if (settingsErr || !settings) throw new Error(`Failed to load settings: ${settingsErr?.message}`);

    const { calibration_min_sample: minSample, calibration_min_ignore: minIgnore, default_success_rate_estimate: defaultRate, attempt2_factor, attempt3plus_factor } = settings;

    const maturityCutoffMs = Date.now() - MATURITY_DAYS * 24 * 60 * 60 * 1000;

    const lineItems = await fetchAllRows<{
      product_id: number | null;
      products: { model_group_id: number | null } | null;
      orders: { outcome: string | null; order_created_at: string } | null;
    }>(supabase, "order_line_items", "id, product_id, products(model_group_id), orders(outcome, order_created_at)");

    const byModel = new Map<number, { resolved: number; delivered: number }>();
    let storeResolved = 0;
    let storeDelivered = 0;

    for (const li of lineItems) {
      const order = li.orders;
      const product = li.products;
      if (!order || !product?.model_group_id) continue;
      if (!RESOLVED_OUTCOMES.includes(order.outcome ?? "")) continue;
      if (new Date(order.order_created_at).getTime() > maturityCutoffMs) continue;

      const modelId = product.model_group_id;
      if (!byModel.has(modelId)) byModel.set(modelId, { resolved: 0, delivered: 0 });
      const entry = byModel.get(modelId)!;
      entry.resolved++;
      storeResolved++;
      if (order.outcome === "delivered") {
        entry.delivered++;
        storeDelivered++;
      }
    }

    const storeWideRate = storeResolved > 0 ? storeDelivered / storeResolved : defaultRate;

    const { data: allModels, error: modelsErr } = await supabase.from("model_groups").select("id");
    if (modelsErr) throw new Error(`Failed to load model_groups: ${modelsErr.message}`);

    const today = egyptToday();
    const rows = (allModels ?? []).map((m) => {
      const stats = byModel.get(m.id) ?? { resolved: 0, delivered: 0 };
      const n = stats.resolved;
      const rawRate = n > 0 ? stats.delivered / n : null;

      let blendedRate: number;
      if (n >= minSample) {
        blendedRate = rawRate!;
      } else if (n < minIgnore) {
        blendedRate = storeWideRate;
      } else {
        blendedRate = (n / minSample) * rawRate! + ((minSample - n) / minSample) * storeWideRate;
      }

      return {
        model_group_id: m.id,
        as_of_date: today,
        raw_rate: rawRate,
        resolved_sample_size: n,
        store_wide_rate: storeWideRate,
        blended_rate: blendedRate,
        attempt_adjusted_rates: {
          "1": blendedRate,
          "2": blendedRate * attempt2_factor,
          "3+": blendedRate * attempt3plus_factor,
        },
        created_at: new Date().toISOString(),
      };
    });

    const { error: upsertErr } = await supabase
      .from("product_success_rates")
      .upsert(rows, { onConflict: "model_group_id,as_of_date" });
    if (upsertErr) throw new Error(`Failed to upsert calibration results: ${upsertErr.message}`);

    return { ok: true, modelsCalibrated: rows.length, storeWideRate };
  } catch (err) {
    return { ok: false, modelsCalibrated: 0, storeWideRate: 0, error: err instanceof Error ? err.message : "unknown error" };
  }
}
