import "server-only";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";
import { computeLineCost, type ComponentType, type ComponentUnit } from "./component-types";
import { isActiveStatus } from "./status";

// ---- Single (final) products: mapped to raw material / package / sticker ----
export type ProductMapping = {
  componentId: number;
  type: ComponentType;
  account: string;
  unit: ComponentUnit;
  costPerUnit: number | null;
  quantity: number;
  lineCost: number | null;
};

// One Shopify variant (e.g. "1 كيلو" / "3 كيلو") of a single product. When a
// product has variants, each variant carries its OWN BOM - there is no
// product-level fallback, since the whole point is that they cost differently.
export type ProductVariant = {
  id: number;
  title: string;
  sku: string | null;
  currentPrice: number | null;
  mappings: ProductMapping[];
  totalCost: number;
  isCosted: boolean; // false until this variant has a BOM of its own
  hasMissingCost: boolean;
};

export type FinalProduct = {
  id: number;
  name: string;
  sku: string | null;
  currentPrice: number | null;
  isActive: boolean;
  status: string | null; // raw Shopify status, so a hidden row says WHY it's hidden
  mappings: ProductMapping[]; // empty when costed by variant (see `variants`)
  totalCost: number;
  hasMissingCost: boolean;
  // Only populated when the product has MORE THAN ONE variant, in which case
  // this product is costed per variant and its own `mappings` stay empty.
  // Single-variant products behave exactly as before - one row, one BOM.
  variants: ProductVariant[];
};

// ---- Bundles: built from member (single) products + Other components ----
export type BundleItem = {
  kind: "product" | "variant" | "component";
  refId: number; // member product id, member variant id, or component id
  label: string;
  quantity: number;
  perUnitCost: number | null; // product/variant: its built cost; component: cost per priced unit
  unit: ComponentUnit | null; // component allocation unit; null for a product/variant member (counted as pieces)
  componentType: ComponentType | null; // which catalog section a component came from; null for members
  lineCost: number | null;
};

export type BundleProduct = {
  id: number;
  name: string;
  currentPrice: number | null;
  isActive: boolean;
  status: string | null;
  items: BundleItem[];
  totalCost: number;
  hasMissingCost: boolean;
};

// A bundle member: either a whole product, or one variant of a multi-variant
// product (whose cost differs per variant, so the product alone is ambiguous).
export type MemberOption = {
  id: number;
  name: string;
  builtCost: number;
  isActive: boolean;
  kind: "product" | "variant";
  productName?: string; // for a variant: its parent product, for grouping the picker
};
// Any catalog component can be attached straight to a bundle (a raw material, a
// package, a sticker, or the box) - `type` lets the picker group them so it is
// clear which section an item is being taken from.
export type ComponentOption = { id: number; type: ComponentType; account: string; unit: ComponentUnit; cost: number | null };

export type ProductStructure = {
  singles: FinalProduct[];
  bundles: BundleProduct[];
  memberOptions: MemberOption[]; // single products / variants, for a bundle's dropdown
  componentOptions: ComponentOption[]; // every catalog component, for a bundle's dropdown
};

const isActive = isActiveStatus;

// Bundle members and Other components share one dropdown; a product member is
// counted in whole pieces (no unit conversion), a component uses its unit.
function bundleLineCost(item: {
  kind: "product" | "variant" | "component";
  perUnitCost: number | null;
  unit: ComponentUnit | null;
  quantity: number;
}): number | null {
  if (item.perUnitCost === null) return null;
  if (item.kind !== "component") return item.perUnitCost * item.quantity;
  return computeLineCost(item.perUnitCost, item.unit ?? "pcs", item.quantity);
}

// NOTE: nothing costs a sale from the BOM any more - a product's cost comes
// from its model group (see getUnitCostByProduct in ./catalog), the way IZAR
// does it. The structure below is still read for product/variant/bundle names
// and their active state; the totalCost fields it carries are informational.

export async function getProductStructure(): Promise<ProductStructure> {
  // These four reads are independent, so run them concurrently rather than as a
  // chain of round-trips (this function is on the report + margin + product paths).
  const [productRows, componentRows, fpcRows, bundleItemRows, variantRows] = await Promise.all([
    fetchAllRows<{
      id: number;
      name: string;
      sku: string | null;
      current_price: number | null;
      status: string | null;
      is_bundle: boolean;
    }>(supabase, "products", "id, name, sku, current_price, status, is_bundle"),
    fetchAllRows<{
      id: number;
      type: ComponentType;
      account: string;
      unit: ComponentUnit;
      cost: number | null;
    }>(supabase, "product_components", "id, type, account, unit, cost"),
    fetchAllRows<{ product_id: number; component_id: number; variant_id: number | null; quantity: number }>(
      supabase,
      "final_product_components",
      "product_id, component_id, variant_id, quantity"
    ),
    fetchAllRows<{
      bundle_product_id: number;
      member_product_id: number | null;
      member_variant_id: number | null;
      component_id: number | null;
      quantity: number;
    }>(supabase, "bundle_items", "bundle_product_id, member_product_id, member_variant_id, component_id, quantity"),
    fetchAllRows<{
      id: number;
      product_id: number;
      title: string;
      sku: string | null;
      current_price: number | null;
      position: number;
    }>(supabase, "product_variants", "id, product_id, title, sku, current_price, position"),
  ]);
  const componentById = new Map(componentRows.map((c) => [c.id, c]));

  function toMapping(componentId: number, rawQuantity: number): ProductMapping | null {
    const component = componentById.get(componentId);
    if (!component) return null;
    const quantity = Number(rawQuantity);
    const costPerUnit = component.cost === null ? null : Number(component.cost);
    return {
      componentId: component.id,
      type: component.type,
      account: component.account,
      unit: component.unit,
      costPerUnit,
      quantity,
      lineCost: computeLineCost(costPerUnit, component.unit, quantity),
    };
  }

  const byTypeThenAccount = (a: ProductMapping, b: ProductMapping) =>
    a.type.localeCompare(b.type) || a.account.localeCompare(b.account);
  const sumLineCosts = (list: ProductMapping[]) => list.reduce((sum, m) => sum + (m.lineCost ?? 0), 0);

  // BOM rows split by scope: variant_id null applies to the whole product,
  // otherwise it belongs to that one variant.
  const mappingsByProduct = new Map<number, ProductMapping[]>();
  const mappingsByVariant = new Map<number, ProductMapping[]>();
  for (const m of fpcRows) {
    const mapping = toMapping(m.component_id, m.quantity);
    if (!mapping) continue;
    if (m.variant_id != null) {
      const list = mappingsByVariant.get(m.variant_id) ?? [];
      list.push(mapping);
      mappingsByVariant.set(m.variant_id, list);
    } else {
      const list = mappingsByProduct.get(m.product_id) ?? [];
      list.push(mapping);
      mappingsByProduct.set(m.product_id, list);
    }
  }

  const variantsByProduct = new Map<number, typeof variantRows>();
  for (const v of variantRows) {
    const list = variantsByProduct.get(v.product_id) ?? [];
    list.push(v);
    variantsByProduct.set(v.product_id, list);
  }

  const singles: FinalProduct[] = [];
  const builtCostByProduct = new Map<number, number>();
  // Variant lookup for bundle contents: a bundle can hold one specific variant,
  // costed at that variant's build (which already falls back to the product's).
  const variantInfo = new Map<number, { label: string; productName: string; builtCost: number; isActive: boolean }>();
  for (const p of productRows) {
    if (p.is_bundle) continue;
    const mappings = (mappingsByProduct.get(p.id) ?? []).sort(byTypeThenAccount);
    const totalCost = sumLineCosts(mappings);
    builtCostByProduct.set(p.id, totalCost);

    // Expose variants only when there is a real choice to make; a product with
    // one (or zero) variant is costed at the product level as it always was.
    const rawVariants = variantsByProduct.get(p.id) ?? [];
    const variants: ProductVariant[] =
      rawVariants.length > 1
        ? rawVariants
            .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title))
            .map((v) => {
              const own = (mappingsByVariant.get(v.id) ?? []).sort(byTypeThenAccount);
              const totalCost = sumLineCosts(own);
              variantInfo.set(v.id, {
                label: v.title,
                productName: p.name,
                builtCost: totalCost,
                isActive: isActive(p.status),
              });
              return {
                id: v.id,
                title: v.title,
                sku: v.sku,
                currentPrice: v.current_price,
                mappings: own,
                totalCost,
                isCosted: own.length > 0,
                hasMissingCost: own.some((m) => m.costPerUnit === null),
              };
            })
        : [];

    singles.push({
      id: p.id,
      name: p.name,
      sku: p.sku,
      currentPrice: p.current_price,
      isActive: isActive(p.status),
      status: p.status,
      mappings,
      totalCost,
      hasMissingCost: mappings.some((m) => m.costPerUnit === null),
      variants,
    });
  }
  singles.sort((a, b) => a.name.localeCompare(b.name));

  // Bundle contents, grouped by bundle.
  const itemsByBundle = new Map<number, BundleItem[]>();
  for (const r of bundleItemRows) {
    const quantity = Number(r.quantity);
    let item: BundleItem | null = null;
    if (r.member_product_id != null) {
      const perUnitCost = builtCostByProduct.get(r.member_product_id) ?? null;
      const member = productRows.find((p) => p.id === r.member_product_id);
      item = {
        kind: "product",
        refId: r.member_product_id,
        label: member?.name ?? `#${r.member_product_id}`,
        quantity,
        perUnitCost,
        unit: null,
        componentType: null,
        lineCost: null,
      };
    } else if (r.member_variant_id != null) {
      const v = variantInfo.get(r.member_variant_id);
      if (!v) continue;
      item = {
        kind: "variant",
        refId: r.member_variant_id,
        label: `${v.productName} — ${v.label}`,
        quantity,
        perUnitCost: v.builtCost,
        unit: null,
        componentType: null,
        lineCost: null,
      };
    } else if (r.component_id != null) {
      const c = componentById.get(r.component_id);
      if (!c) continue;
      item = {
        kind: "component",
        refId: r.component_id,
        label: c.account,
        quantity,
        perUnitCost: c.cost === null ? null : Number(c.cost),
        unit: c.unit,
        componentType: c.type,
        lineCost: null,
      };
    }
    if (!item) continue;
    item.lineCost = bundleLineCost(item);
    const list = itemsByBundle.get(r.bundle_product_id) ?? [];
    list.push(item);
    itemsByBundle.set(r.bundle_product_id, list);
  }

  const bundles: BundleProduct[] = productRows
    .filter((p) => p.is_bundle)
    .map((p) => {
      const items = (itemsByBundle.get(p.id) ?? []).sort((a, b) => a.label.localeCompare(b.label));
      const totalCost = items.reduce((sum, it) => sum + (it.lineCost ?? 0), 0);
      return {
        id: p.id,
        name: p.name,
        currentPrice: p.current_price,
        isActive: isActive(p.status),
        status: p.status,
        items,
        totalCost,
        hasMissingCost: items.some((it) => it.perUnitCost === null),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // A multi-variant product offers its VARIANTS rather than itself - picking the
  // product would be ambiguous now that each variant carries its own cost.
  // (Bundles that already reference such a product keep working; those rows
  // still resolve above, they just can't be re-created from the picker.)
  const memberOptions: MemberOption[] = singles.flatMap((s): MemberOption[] =>
    s.variants.length > 0
      ? s.variants.map((v) => ({
          id: v.id,
          name: `${s.name} — ${v.title}`,
          builtCost: v.totalCost,
          isActive: s.isActive,
          kind: "variant" as const,
          productName: s.name,
        }))
      : [{ id: s.id, name: s.name, builtCost: s.totalCost, isActive: s.isActive, kind: "product" as const }]
  );
  const componentOptions: ComponentOption[] = componentRows
    .map((c) => ({ id: c.id, type: c.type, account: c.account, unit: c.unit, cost: c.cost === null ? null : Number(c.cost) }))
    .sort((a, b) => a.account.localeCompare(b.account));

  return { singles, bundles, memberOptions, componentOptions };
}

// ---- Single-product component mapping mutations ----
// variantId null = the product-level BOM (the default for every variant);
// otherwise the row belongs to that one variant and overrides the default.
export async function upsertProductComponentMapping(
  productId: number,
  componentId: number,
  quantity: number,
  variantId: number | null = null
): Promise<void> {
  if (!Number.isFinite(productId) || !Number.isFinite(componentId)) throw new Error("Invalid product or component");
  if (!Number.isFinite(quantity) || quantity < 0) throw new Error("Quantity must be zero or a positive number");
  if (variantId !== null) await assertVariantBelongsToProduct(variantId, productId);
  else await assertProductIsNotVariantCosted(productId);

  // Two partial unique indexes back this table (see migration 0041), and
  // PostgREST can't target a partial index by column list, so upsert by hand.
  let existingQuery = supabase
    .from("final_product_components")
    .select("id")
    .eq("product_id", productId)
    .eq("component_id", componentId);
  existingQuery = variantId === null ? existingQuery.is("variant_id", null) : existingQuery.eq("variant_id", variantId);
  const { data: existing, error: findErr } = await existingQuery.maybeSingle();
  if (findErr) throw new Error(`Failed to save mapping: ${findErr.message}`);

  const now = new Date().toISOString();
  const { error } = existing
    ? await supabase.from("final_product_components").update({ quantity, updated_at: now }).eq("id", existing.id)
    : await supabase
        .from("final_product_components")
        .insert({ product_id: productId, component_id: componentId, variant_id: variantId, quantity, updated_at: now });
  if (error) throw new Error(`Failed to save mapping: ${error.message}`);
}

export async function deleteProductComponentMapping(
  productId: number,
  componentId: number,
  variantId: number | null = null
): Promise<void> {
  let query = supabase
    .from("final_product_components")
    .delete()
    .eq("product_id", productId)
    .eq("component_id", componentId);
  query = variantId === null ? query.is("variant_id", null) : query.eq("variant_id", variantId);
  const { error } = await query;
  if (error) throw new Error(`Failed to remove mapping: ${error.message}`);
}

// Guards against a caller pairing a variant with someone else's product id,
// which would silently create a BOM row nothing ever reads.
// A product with several variants is costed per variant, so a product-level BOM
// row for it would never be read.
async function assertProductIsNotVariantCosted(productId: number): Promise<void> {
  const { count, error } = await supabase
    .from("product_variants")
    .select("id", { count: "exact", head: true })
    .eq("product_id", productId);
  if (error) throw new Error(`Failed to check variants: ${error.message}`);
  if ((count ?? 0) > 1) throw new Error("This product has variants - cost each variant instead");
}

async function assertVariantBelongsToProduct(variantId: number, productId: number): Promise<void> {
  const { data, error } = await supabase.from("product_variants").select("product_id").eq("id", variantId).maybeSingle();
  if (error) throw new Error(`Failed to load variant: ${error.message}`);
  if (!data) throw new Error("Unknown variant");
  if (data.product_id !== productId) throw new Error("Variant does not belong to this product");
}

// ---- Bundle classification + contents mutations ----
export async function setProductIsBundle(productId: number, isBundle: boolean): Promise<void> {
  const { error } = await supabase
    .from("products")
    .update({ is_bundle: isBundle, updated_at: new Date().toISOString() })
    .eq("id", productId);
  if (error) throw new Error(`Failed to update product kind: ${error.message}`);
}

type BundleItemRef = {
  memberProductId?: number | null;
  memberVariantId?: number | null;
  componentId?: number | null;
};

export async function upsertBundleItem(bundleId: number, ref: BundleItemRef, quantity: number): Promise<void> {
  const hasMember = ref.memberProductId != null;
  const hasVariant = ref.memberVariantId != null;
  const hasComponent = ref.componentId != null;
  if (Number(hasMember) + Number(hasVariant) + Number(hasComponent) !== 1) {
    throw new Error("Pick exactly one of a product, a variant or a component");
  }
  if (!Number.isFinite(quantity) || quantity < 0) throw new Error("Quantity must be zero or a positive number");
  if (hasMember && ref.memberProductId === bundleId) throw new Error("A bundle cannot contain itself");
  // A variant of the bundle itself would be the same self-reference.
  if (hasVariant) {
    const { data: variant, error: variantErr } = await supabase
      .from("product_variants")
      .select("product_id")
      .eq("id", ref.memberVariantId)
      .maybeSingle();
    if (variantErr) throw new Error(`Failed to load variant: ${variantErr.message}`);
    if (!variant) throw new Error("Unknown variant");
    if (variant.product_id === bundleId) throw new Error("A bundle cannot contain itself");
  }

  const row = {
    bundle_product_id: bundleId,
    member_product_id: hasMember ? ref.memberProductId : null,
    member_variant_id: hasVariant ? ref.memberVariantId : null,
    component_id: hasComponent ? ref.componentId : null,
    quantity,
    updated_at: new Date().toISOString(),
  };
  const onConflict = hasMember
    ? "bundle_product_id,member_product_id"
    : hasVariant
      ? "bundle_product_id,member_variant_id"
      : "bundle_product_id,component_id";
  const { error } = await supabase.from("bundle_items").upsert(row, { onConflict });
  if (error) throw new Error(`Failed to save bundle item: ${error.message}`);
}

export async function deleteBundleItem(bundleId: number, ref: BundleItemRef): Promise<void> {
  let query = supabase.from("bundle_items").delete().eq("bundle_product_id", bundleId);
  if (ref.memberProductId != null) query = query.eq("member_product_id", ref.memberProductId);
  else if (ref.memberVariantId != null) query = query.eq("member_variant_id", ref.memberVariantId);
  else if (ref.componentId != null) query = query.eq("component_id", ref.componentId);
  else throw new Error("Missing reference");
  const { error } = await query;
  if (error) throw new Error(`Failed to remove bundle item: ${error.message}`);
}
