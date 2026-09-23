import "server-only";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";
import { egyptToday } from "@/lib/dates";
import { isActiveStatus } from "./status";
import { compareLabels } from "./labels";

// Sentinel "since the beginning of time" date, used to backdate a model's
// first-ever real cost so it applies to every order already placed for it -
// matching the all-time-start convention used elsewhere (e.g. /products).
const ALL_TIME_START = "2000-01-01";

export type CatalogProduct = {
  id: number;
  name: string;
  sku: string | null;
  currentPrice: number | null;
  modelGroupId: number | null;
  modelGroupName: string | null;
  // The cost the engine actually prices this product at: its own override if it
  // has one, otherwise whatever its model group carries.
  unitCost: number | null;
  // Set when the cost is this product's alone (a recorded purchase, or a cost
  // typed against a product with no model). Tells the Product List which of the
  // two places to write an edit back to.
  unitCostOverride: number | null;
  isActive: boolean;
  // What the product is sold under on mirajeg.com. Null for anything added to
  // Shopify since the taxonomy was seeded (migration 0061) - shown as
  // "Uncategorised" rather than hidden, so new products are easy to spot.
  category: string | null;
  subCategory: string | null;
  // Only populated when the product has MORE THAN ONE variant, i.e. when there
  // is a real choice behind a sale. Such a product is costed per variant, so
  // its own unitCost is not what an order line is priced at - the variant's is.
  // Single-variant products keep an empty list and behave as one plain row.
  variants: CatalogVariant[];
};

// One Shopify variant of a multi-variant product. Sales are recorded against
// these (order_line_items.variant_id), and they can be priced - and therefore
// costed - differently from each other.
export type CatalogVariant = {
  id: number;
  title: string;
  sku: string | null;
  currentPrice: number | null;
  // Effective cost for this variant: its own override, else whatever the parent
  // product resolves to.
  unitCost: number | null;
  unitCostOverride: number | null;
};

export type ModelGroupOption = { id: number; name: string; unitCost: number | null };

export async function getProductCatalog(): Promise<{ products: CatalogProduct[]; modelGroups: ModelGroupOption[] }> {
  const modelGroupRows = await fetchAllRows<{ id: number; name: string; unit_cost: number | null }>(
    supabase,
    "model_groups",
    "id, name, unit_cost"
  );
  const modelGroups = modelGroupRows
    .map((m) => ({ id: m.id, name: m.name, unitCost: m.unit_cost }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const modelGroupById = new Map(modelGroups.map((m) => [m.id, m]));

  const [productRows, variantRows] = await Promise.all([
    fetchAllRows<{
      id: number;
      name: string;
      sku: string | null;
      current_price: number | null;
      model_group_id: number | null;
      status: string | null;
      category: string | null;
      sub_category: string | null;
      unit_cost_override: number | null;
    }>(
      supabase,
      "products",
      "id, name, sku, current_price, model_group_id, status, category, sub_category, unit_cost_override"
    ),
    fetchAllRows<{
      id: number;
      product_id: number;
      title: string;
      sku: string | null;
      current_price: number | null;
      position: number;
      unit_cost_override: number | null;
    }>(supabase, "product_variants", "id, product_id, title, sku, current_price, position, unit_cost_override"),
  ]);

  const variantsByProduct = new Map<number, typeof variantRows>();
  for (const v of variantRows) {
    const list = variantsByProduct.get(v.product_id) ?? [];
    list.push(v);
    variantsByProduct.set(v.product_id, list);
  }

  const products = productRows
    .map((p) => {
      const group = p.model_group_id ? modelGroupById.get(p.model_group_id) : null;
      // Same precedence the engine uses (margin.ts), so the number shown here
      // is the number a sale is actually costed at.
      const productCost = p.unit_cost_override ?? group?.unitCost ?? null;
      const raw = variantsByProduct.get(p.id) ?? [];
      // One variant is not a choice - Shopify gives every product a default
      // variant - so only expand when there are genuinely several to cost.
      const variants: CatalogVariant[] =
        raw.length > 1
          ? raw
              .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title))
              .map((v) => ({
                id: v.id,
                title: v.title,
                sku: v.sku,
                currentPrice: v.current_price,
                unitCost: v.unit_cost_override ?? productCost,
                unitCostOverride: v.unit_cost_override,
              }))
          : [];

      return {
        id: p.id,
        name: p.name,
        sku: p.sku,
        currentPrice: p.current_price,
        modelGroupId: p.model_group_id,
        modelGroupName: group?.name ?? null,
        unitCost: productCost,
        unitCostOverride: p.unit_cost_override,
        isActive: isActiveStatus(p.status),
        category: p.category,
        subCategory: p.sub_category,
        variants,
      };
    })
    // Ordered the way the storefront reads: category, then sub-category, then
    // name. Uncategorised products sort last within each level so they stand
    // out as needing a home rather than hiding mid-list.
    .sort((a, b) => {
      const byCategory = compareLabels(a.category, b.category);
      if (byCategory !== 0) return byCategory;
      const bySub = compareLabels(a.subCategory, b.subCategory);
      if (bySub !== 0) return bySub;
      return a.name.localeCompare(b.name);
    });

  return { products, modelGroups };
}

// The cost a product sells at today, in the same precedence the margin engine
// uses (margin.ts): a purchase's flat override wins, otherwise the product's
// model group carries the cost. Absent from the map when neither is set, which
// callers read as "not costed yet" rather than as zero.
export async function getUnitCostByProduct(): Promise<Map<number, number>> {
  const [modelRows, productRows] = await Promise.all([
    fetchAllRows<{ id: number; unit_cost: number | null }>(supabase, "model_groups", "id, unit_cost"),
    fetchAllRows<{ id: number; model_group_id: number | null; unit_cost_override: number | null }>(
      supabase,
      "products",
      "id, model_group_id, unit_cost_override"
    ),
  ]);
  const costByModel = new Map(modelRows.map((m) => [m.id, m.unit_cost]));

  const byProduct = new Map<number, number>();
  for (const p of productRows) {
    const cost = p.unit_cost_override ?? (p.model_group_id === null ? null : costByModel.get(p.model_group_id) ?? null);
    if (cost !== null) byProduct.set(p.id, Number(cost));
  }
  return byProduct;
}

// Variant-specific costs only. Absent means "no cost of its own", so the caller
// falls back to the product's (see getUnitCostByProduct).
export async function getUnitCostByVariant(): Promise<Map<number, number>> {
  const rows = await fetchAllRows<{ id: number; unit_cost_override: number | null }>(
    supabase,
    "product_variants",
    "id, unit_cost_override"
  );
  const byVariant = new Map<number, number>();
  for (const v of rows) {
    if (v.unit_cost_override !== null) byVariant.set(v.id, Number(v.unit_cost_override));
  }
  return byVariant;
}

// One category and the allocation groups inside it. A "group" is what spend is
// actually pinned to, and matches per-product.ts's own grouping exactly:
// sub_category, falling back to the category name when a product has none.
export type AllocationCategory = {
  category: string;
  groups: string[];
  // False when the category holds a single group named after itself (سبح, ماء
  // زمزم, ...). Picking "all of it" would then be the very same thing as picking
  // that one group, so the picker offers no redundant category-wide option.
  hasSubCategories: boolean;
};

// The allocation target list, grouped by category, for the ad-allocation
// picker. This replaced a flat list of the same groups, which gave no way to
// say "the whole category" and no way to tell a sub-category apart from a bare
// category - both of which the picker needs.
export async function listAllocationCategories(): Promise<AllocationCategory[]> {
  const rows = await fetchAllRows<{ category: string | null; sub_category: string | null }>(
    supabase,
    "products",
    "id, category, sub_category"
  );

  const byCategory = new Map<string, Set<string>>();
  for (const r of rows) {
    const category = r.category?.trim();
    if (!category) continue; // uncategorised products are not an allocation target
    const group = r.sub_category?.trim() || category;
    const groups = byCategory.get(category) ?? new Set<string>();
    groups.add(group);
    byCategory.set(category, groups);
  }

  return [...byCategory.entries()]
    .map(([category, groups]) => {
      const list = [...groups].sort((a, b) => compareLabels(a, b));
      return {
        category,
        groups: list,
        hasSubCategories: list.length > 1 || list[0] !== category,
      };
    })
    .sort((a, b) => compareLabels(a.category, b.category));
}

export async function listModelGroups(): Promise<ModelGroupOption[]> {
  const rows = await fetchAllRows<{ id: number; name: string; unit_cost: number | null }>(supabase, "model_groups", "id, name, unit_cost");
  return rows.map((m) => ({ id: m.id, name: m.name, unitCost: m.unit_cost })).sort((a, b) => a.name.localeCompare(b.name));
}

export async function createModelGroup(input: { name: string; unitCost: number | null }): Promise<number> {
  if (!input.name.trim()) throw new Error("Model group name is required");

  const { data, error } = await supabase
    .from("model_groups")
    .insert({ name: input.name.trim(), unit_cost: input.unitCost })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Failed to create model group: ${error?.message}`);

  if (input.unitCost !== null) {
    // Brand new model - apply its first cost to any orders that already
    // exist for it (e.g. ordered before this model was set up), same rule
    // as a first-time cost entry on an existing model below.
    const { error: historyErr } = await supabase
      .from("model_group_cost_history")
      .insert({ model_group_id: data.id, unit_cost: input.unitCost, effective_from: ALL_TIME_START });
    if (historyErr) throw new Error(`Failed to record cost history: ${historyErr.message}`);
  }

  return data.id;
}

export async function updateModelGroupCost(id: number, unitCost: number | null): Promise<void> {
  if (unitCost !== null) {
    const { data: group, error: groupErr } = await supabase.from("model_groups").select("unit_cost").eq("id", id).single();
    if (groupErr || !group) throw new Error(`Failed to load model group: ${groupErr?.message}`);

    const { count, error: countErr } = await supabase
      .from("model_group_cost_history")
      .select("id", { count: "exact", head: true })
      .eq("model_group_id", id);
    if (countErr) throw new Error(`Failed to check cost history: ${countErr.message}`);

    const rows: Array<{ model_group_id: number; unit_cost: number; effective_from: string }> = [];
    if ((count ?? 0) === 0 && group.unit_cost !== null) {
      // Already had a real cost before this history table existed -
      // preserve it for past orders, and only apply the new value from
      // today forward (a genuine cost change, not a first-time entry).
      rows.push({ model_group_id: id, unit_cost: group.unit_cost, effective_from: ALL_TIME_START });
      rows.push({ model_group_id: id, unit_cost: unitCost, effective_from: egyptToday() });
    } else if ((count ?? 0) === 0) {
      // First real cost ever set for this model - every past order for it
      // was silently treated as zero cost until now, so backdate it.
      rows.push({ model_group_id: id, unit_cost: unitCost, effective_from: ALL_TIME_START });
    } else {
      // Already has a cost history - this is a real change (e.g. a
      // supplier price increase), so it should only affect orders from
      // today forward, not rewrite already-reported historical margins.
      rows.push({ model_group_id: id, unit_cost: unitCost, effective_from: egyptToday() });
    }

    const { error: historyErr } = await supabase.from("model_group_cost_history").insert(rows);
    if (historyErr) throw new Error(`Failed to record cost history: ${historyErr.message}`);
  }

  const { error } = await supabase
    .from("model_groups")
    .update({ unit_cost: unitCost, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`Failed to update model group cost: ${error.message}`);
}

// Everything the Product List can change about a product. Every field is
// optional and only the ones present are written, so one row's cost edit never
// clears the category it wasn't touching.
//
// unitCostOverride is a cost belonging to this product alone, sitting ahead of
// its model group in the engine's precedence. It is flat, not effective-dated:
// the model group's cost history exists to protect already-reported months, and
// a per-product cost is the deliberate escape hatch from that.
export type ProductPatch = {
  modelGroupId?: number | null;
  unitCostOverride?: number | null;
  category?: string | null;
  subCategory?: string | null;
};

// A cost for one variant, sitting one step ahead of its product's own cost.
// Null clears it, so the variant falls back to the product again.
export async function setVariantUnitCost(variantId: number, unitCost: number | null): Promise<void> {
  const { error } = await supabase
    .from("product_variants")
    .update({ unit_cost_override: unitCost, updated_at: new Date().toISOString() })
    .eq("id", variantId);
  if (error) throw new Error(`Failed to update variant cost: ${error.message}`);
}

export async function updateProduct(productId: number, patch: ProductPatch): Promise<void> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if ("modelGroupId" in patch) row.model_group_id = patch.modelGroupId;
  if ("unitCostOverride" in patch) row.unit_cost_override = patch.unitCostOverride;
  // Blank is stored as null, so "Uncategorised" is one value rather than a mix
  // of null and "" that the filters would treat as two.
  if ("category" in patch) row.category = patch.category?.trim() || null;
  if ("subCategory" in patch) row.sub_category = patch.subCategory?.trim() || null;

  const { error } = await supabase.from("products").update(row).eq("id", productId);
  if (error) throw new Error(`Failed to update product: ${error.message}`);
}
