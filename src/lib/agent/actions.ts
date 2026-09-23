import "server-only";
import { supabase } from "@/lib/supabase";
import { listAllocationCategories, getUnitCostByProduct, updateProduct } from "@/lib/products/catalog";
import { saveTikTokSpend } from "@/lib/tiktok-spend";

// The only changes AI MIRAJ may make to the dashboard, applied when the owner
// answers a nightly message (POST /api/agent/apply). Each one is the same edit
// the owner would make by hand - enter a day's TikTok spend in the popup,
// allocate a campaign in the allocation popup, give a product its cost on the
// Product List - and nothing here can overwrite an existing decision: a TikTok
// day already entered, a campaign already allocated or a cost already set is
// reported back instead of being changed. Names are matched exactly (ignoring
// case and spacing) so a vague answer fails loudly rather than editing the
// wrong thing.

export type AgentAction =
  | { type: "set_tiktok_spend"; date: string; amount: number }
  | { type: "allocate_campaign"; campaignId: string; subCategories: string[]; categories: string[]; general: boolean }
  | { type: "set_product_cost"; productId: number; unitCost: number };

export type ActionResult = { action: AgentAction; ok: boolean; detail: string };

function normalize(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, " ").trim();
}

// Exactly what the popup saves for one amount under "General (all products)",
// or its "No spend this day" button for 0.
async function setTikTokSpend(date: string, amount: number): Promise<string> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`"${date}" is not a date`);
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`"${amount}" is not a valid amount`);

  const { data: existing, error } = await supabase
    .from("ad_spend")
    .select("spend")
    .eq("source", "tiktok")
    .eq("date", date);
  if (error) throw new Error(`Failed to check TikTok spend: ${error.message}`);
  if ((existing ?? []).length > 0) {
    const total = (existing ?? []).reduce((sum, r) => sum + Number(r.spend), 0);
    throw new Error(`TikTok spend for ${date} is already entered (${total} EGP) - change it on the dashboard`);
  }

  await saveTikTokSpend(date, amount > 0 ? [{ amount, modelGroupId: null }] : []);
  return amount > 0 ? `TikTok spend for ${date} recorded: ${amount} EGP (General)` : `TikTok spend for ${date} recorded as none`;
}

// The same writes as the allocation popup (POST /api/ad-spend/allocate), with
// every name checked against the real category list first.
async function allocateCampaign(
  campaignId: string,
  subCategories: string[],
  categories: string[],
  general: boolean
): Promise<string> {
  const all = await listAllocationCategories();
  const groupNames = new Map(all.flatMap((c) => c.groups).map((g) => [normalize(g), g]));
  const categoryNames = new Map(all.map((c) => [normalize(c.category), c.category]));
  const resolve = (names: string[], known: Map<string, string>, kind: string) =>
    [...new Set(names)].map((n) => {
      const hit = known.get(normalize(n));
      if (!hit) throw new Error(`No ${kind} called "${n}". Known: ${[...known.values()].join(", ")}`);
      return hit;
    });
  const subs = general ? [] : resolve(subCategories, groupNames, "sub-category");
  const cats = general ? [] : resolve(categories, categoryNames, "category");
  if (!general && subs.length === 0 && cats.length === 0) throw new Error("Name at least one category or sub-category");

  const { data: existing, error: existingErr } = await supabase
    .from("ad_model_assignments")
    .select("sub_categories, categories, is_general")
    .eq("campaign_id", campaignId)
    .maybeSingle();
  if (existingErr) throw new Error(`Failed to check the campaign: ${existingErr.message}`);
  if (existing && (existing.is_general || existing.sub_categories?.length || existing.categories?.length)) {
    throw new Error(`Campaign ${campaignId} is already allocated - change it on the dashboard`);
  }

  // A campaign lives in one ad account, so its segment is already on its spend.
  const { data: spendRow, error: segmentErr } = await supabase
    .from("ad_spend")
    .select("segment")
    .eq("campaign_id", campaignId)
    .limit(1)
    .maybeSingle();
  if (segmentErr) throw new Error(`Failed to resolve campaign segment: ${segmentErr.message}`);
  if (!spendRow) throw new Error(`No spend on record for campaign ${campaignId}`);

  const allocation = {
    sub_categories: subs.length ? subs : null,
    categories: cats.length ? cats : null,
    is_general: general,
  };
  const { error: assignErr } = await supabase
    .from("ad_model_assignments")
    .upsert({ campaign_id: campaignId, ...allocation, segment: spendRow.segment ?? "retail" }, { onConflict: "campaign_id" });
  if (assignErr) throw new Error(`Failed to save the allocation: ${assignErr.message}`);

  const { error: spendErr } = await supabase.from("ad_spend").update(allocation).eq("campaign_id", campaignId);
  if (spendErr) throw new Error(`Failed to allocate its spend: ${spendErr.message}`);

  const target = general ? "General" : [...subs, ...cats.map((c) => `all of ${c}`)].join(", ");
  return `Campaign ${campaignId} allocated to ${target}`;
}

// The Product List's own cost field (products.unit_cost_override). Only for a
// product with no cost yet - an existing cost is changed on the dashboard.
async function setProductCost(productId: number, unitCost: number): Promise<string> {
  if (!Number.isFinite(unitCost) || unitCost <= 0) throw new Error(`"${unitCost}" is not a valid cost`);
  const { data: product, error } = await supabase.from("products").select("id, name").eq("id", productId).maybeSingle();
  if (error) throw new Error(`Failed to load the product: ${error.message}`);
  if (!product) throw new Error(`No product with id ${productId}`);

  const current = (await getUnitCostByProduct()).get(productId);
  if (current !== undefined && current !== unitCost) {
    throw new Error(`${product.name} already costs ${current} - change it on the dashboard`);
  }
  await updateProduct(productId, { unitCostOverride: unitCost });
  return `${product.name} unit cost set to ${unitCost}`;
}

export async function applyAgentActions(actions: AgentAction[]): Promise<ActionResult[]> {
  const results: ActionResult[] = [];
  for (const action of actions) {
    try {
      let detail: string;
      switch (action.type) {
        case "set_tiktok_spend":
          detail = await setTikTokSpend(action.date, action.amount);
          break;
        case "allocate_campaign":
          detail = await allocateCampaign(action.campaignId, action.subCategories, action.categories, action.general);
          break;
        case "set_product_cost":
          detail = await setProductCost(action.productId, action.unitCost);
          break;
      }
      results.push({ action, ok: true, detail });
    } catch (err) {
      results.push({ action, ok: false, detail: err instanceof Error ? err.message : "failed" });
    }
  }
  return results;
}
