import "server-only";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";
import { unitCostFromTotal } from "@/lib/purchases/unit-cost";
import { getProductCatalog } from "@/lib/products/catalog";
import type { ComponentType, ComponentUnit } from "@/lib/products/component-types";

// The account purchases post to. Analysis-only (in_income_statement = false) -
// see supabase/migrations/0050_purchasing.sql for why it stays out of the P&L.
export const PURCHASING_ACCOUNT = "Purchasing";

// What a purchase can be recorded against. A product with several variants is
// bought per variant, since each variant carries its own cost (migration 0062)
// and that cost sits ahead of the product's in the engine.
export type PurchaseTargetKind = "component" | "product" | "variant";

// The purchases column that points at each kind of target.
const TARGET_COLUMN = { component: "component_id", product: "product_id", variant: "variant_id" } as const;

// One row in the Purchasing dropdown. currentCost is the cost per priced unit
// right now, used for the 20% increase check before saving.
export type PurchaseTargetOption = {
  kind: PurchaseTargetKind;
  id: number;
  name: string;
  // Components carry their own priced unit; a product or variant is always
  // bought in pieces.
  unit: ComponentUnit;
  // Components only - which catalog section to group under in the dropdown.
  type: ComponentType | null;
  currentCost: number | null;
  // Products only: true when the product's cost currently comes from its model
  // group, which a purchase would override. Drives the warning in the form.
  overridesModelCost: boolean;
};

// A recorded purchase. total is what was paid (and what posted to the Purchasing
// account); amount is the per-unit cost derived from it.
export type PurchaseRecord = {
  id: number;
  date: string;
  kind: PurchaseTargetKind;
  targetName: string;
  unit: ComponentUnit;
  quantity: number;
  amount: number;
  total: number;
};

export { unitCostFromTotal };

// Every catalog component plus every active product, for the purchase dropdown.
// A multi-variant product is offered as its variants rather than as itself: a
// product-level cost would be shadowed by any variant that has one of its own.
export async function getPurchaseTargets(): Promise<PurchaseTargetOption[]> {
  const [componentRows, catalog] = await Promise.all([
    fetchAllRows<{ id: number; account: string; type: ComponentType; unit: ComponentUnit; cost: number | null }>(
      supabase,
      "product_components",
      "id, account, type, unit, cost"
    ),
    getProductCatalog(),
  ]);

  const components: PurchaseTargetOption[] = componentRows
    .map((c) => ({
      kind: "component" as const,
      id: c.id,
      name: c.account,
      unit: c.unit,
      type: c.type,
      currentCost: c.cost === null ? null : Number(c.cost),
      overridesModelCost: false,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // The catalog resolves costs in the engine's order (margin.ts): variant
  // override, then product override, then model group - so this is the cost a
  // new purchase is compared against. Its variants are already in position order.
  const products: PurchaseTargetOption[] = catalog.products
    .filter((p) => p.isActive)
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((p): PurchaseTargetOption[] =>
      p.variants.length > 0
        ? p.variants.map((v) => ({
            kind: "variant" as const,
            id: v.id,
            name: `${p.name} — ${v.title}`,
            unit: "pcs" as ComponentUnit,
            type: null,
            currentCost: v.unitCost === null ? null : Number(v.unitCost),
            overridesModelCost: false,
          }))
        : [
            {
              kind: "product" as const,
              id: p.id,
              name: p.name,
              unit: "pcs" as ComponentUnit,
              type: null,
              currentCost: p.unitCost === null ? null : Number(p.unitCost),
              // No override yet but a cost all the same means it is coming from
              // the model group; recording a purchase sets unit_cost_override,
              // which takes over from it for this product alone.
              overridesModelCost: p.unitCostOverride === null && p.unitCost !== null,
            },
          ]
    );

  return [...components, ...products];
}

type PurchaseRow = {
  id: number;
  date: string;
  component_id: number | null;
  product_id: number | null;
  variant_id: number | null;
  quantity: number;
  amount: number;
  total_amount: number;
  product_components: { account: string; unit: ComponentUnit } | null;
  products: { name: string } | null;
  product_variants: { title: string; products: { name: string } | null } | null;
};

// Recorded purchases, newest first.
export async function getPurchases(): Promise<PurchaseRecord[]> {
  const rows = await fetchAllRows<PurchaseRow>(
    supabase,
    "purchases",
    "id, date, component_id, product_id, variant_id, quantity, amount, total_amount, product_components(account, unit), products(name), product_variants(title, products(name))"
  );
  return rows
    .map((r) => {
      const kind: PurchaseTargetKind =
        r.component_id !== null ? "component" : r.variant_id !== null ? "variant" : "product";
      const variant = r.product_variants;
      const targetName =
        kind === "component"
          ? r.product_components?.account
          : kind === "variant"
            ? variant && `${variant.products?.name ?? "?"} — ${variant.title}`
            : r.products?.name;
      return {
        id: r.id,
        date: r.date,
        kind,
        targetName: targetName ?? "?",
        unit: (kind === "component" ? r.product_components?.unit ?? "pcs" : "pcs") as ComponentUnit,
        quantity: Number(r.quantity),
        amount: Number(r.amount),
        total: Number(r.total_amount),
      };
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
}

async function purchasingAccountId(): Promise<number> {
  const { data, error } = await supabase.from("expense_accounts").select("id").eq("name", PURCHASING_ACCOUNT).maybeSingle();
  if (error) throw new Error(`Failed to load the Purchasing account: ${error.message}`);
  if (!data) throw new Error(`The "${PURCHASING_ACCOUNT}" expense account is missing - apply migration 0050_purchasing.sql`);
  return data.id;
}

// Sets the target's cost to the newest-dated purchase amount, so the Product
// List and every cost rollup show the latest price. Called after any insert or
// delete. A target with no purchases left keeps whatever cost it had before
// Purchasing existed rather than being cleared.
async function syncCurrentCost(kind: PurchaseTargetKind, targetId: number): Promise<void> {
  const { data: latest, error } = await supabase
    .from("purchases")
    .select("amount")
    .eq(TARGET_COLUMN[kind], targetId)
    .order("date", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to read latest cost: ${error.message}`);
  if (!latest) return;

  const cost = Number(latest.amount);
  const now = new Date().toISOString();
  const { error: upErr } =
    kind === "component"
      ? await supabase.from("product_components").update({ cost, updated_at: now }).eq("id", targetId)
      : await supabase
          .from(kind === "variant" ? "product_variants" : "products")
          .update({ unit_cost_override: cost, updated_at: now })
          .eq("id", targetId);
  if (upErr) throw new Error(`Failed to update cost: ${upErr.message}`);
}

// The name the ledger note carries; loading it also confirms the target exists.
async function purchaseTargetName(kind: PurchaseTargetKind, targetId: number): Promise<string> {
  if (kind === "variant") {
    const { data, error } = await supabase
      .from("product_variants")
      .select("title, products(name)")
      .eq("id", targetId)
      .maybeSingle();
    if (error) throw new Error(`Failed to load variant: ${error.message}`);
    if (!data) throw new Error("That variant no longer exists");
    const product = data.products as unknown as { name: string } | null;
    return `${product?.name ?? "?"} — ${data.title}`;
  }
  const table = kind === "component" ? "product_components" : "products";
  const nameColumn = kind === "component" ? "account" : "name";
  const { data, error } = await supabase.from(table).select(`id, ${nameColumn}`).eq("id", targetId).maybeSingle();
  if (error) throw new Error(`Failed to load ${kind}: ${error.message}`);
  if (!data) throw new Error(`That ${kind} no longer exists`);
  return (data as unknown as Record<string, string>)[nameColumn];
}

// Record a purchase from the total paid. Three writes, in order: the purchase
// itself, the expense entry on the Purchasing account for the total as entered,
// and the link between them. Then the target's current cost is re-synced.
export async function createPurchase(input: {
  kind: PurchaseTargetKind;
  targetId: number;
  date: string;
  quantity: number;
  totalAmount: number;
}): Promise<number> {
  if (!Object.hasOwn(TARGET_COLUMN, input.kind)) throw new Error("Pick a component or a product");
  if (!Number.isFinite(input.targetId)) throw new Error("Pick something to purchase");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("Invalid date");
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) throw new Error("Quantity must be positive");
  if (!Number.isFinite(input.totalAmount) || input.totalAmount < 0) {
    throw new Error("Total amount must be zero or a positive number");
  }

  const unitCost = unitCostFromTotal(input.totalAmount, input.quantity);
  const targetName = await purchaseTargetName(input.kind, input.targetId);

  const { data: purchase, error } = await supabase
    .from("purchases")
    .insert({
      date: input.date,
      component_id: input.kind === "component" ? input.targetId : null,
      product_id: input.kind === "product" ? input.targetId : null,
      variant_id: input.kind === "variant" ? input.targetId : null,
      quantity: input.quantity,
      amount: unitCost,
      total_amount: input.totalAmount,
    })
    .select("id")
    .single();
  if (error || !purchase) throw new Error(`Failed to save purchase: ${error?.message}`);

  // Post the total as entered - not quantity x unitCost, which would drift by a
  // few piastres whenever the division isn't exact.
  const accountId = await purchasingAccountId();
  const { data: entry, error: entryErr } = await supabase
    .from("expense_entries")
    .insert({
      date: input.date,
      account_id: accountId,
      amount: input.totalAmount,
      note: `${targetName} — ${input.quantity} × ${unitCost}`,
    })
    .select("id")
    .single();
  if (entryErr || !entry) throw new Error(`Failed to post the expense entry: ${entryErr?.message}`);

  const { error: linkErr } = await supabase.from("purchases").update({ expense_entry_id: entry.id }).eq("id", purchase.id);
  if (linkErr) throw new Error(`Failed to link the expense entry: ${linkErr.message}`);

  await syncCurrentCost(input.kind, input.targetId);
  return purchase.id;
}

// Removes the purchase and its ledger entry, then re-syncs the target's cost.
export async function deletePurchase(id: number): Promise<void> {
  const { data: row, error: rowErr } = await supabase
    .from("purchases")
    .select("component_id, product_id, variant_id, expense_entry_id")
    .eq("id", id)
    .maybeSingle();
  if (rowErr) throw new Error(`Failed to load purchase: ${rowErr.message}`);
  if (!row) return;

  const { error } = await supabase.from("purchases").delete().eq("id", id);
  if (error) throw new Error(`Failed to remove purchase: ${error.message}`);

  if (row.expense_entry_id) {
    const { error: entryErr } = await supabase.from("expense_entries").delete().eq("id", row.expense_entry_id);
    if (entryErr) throw new Error(`Failed to remove the expense entry: ${entryErr.message}`);
  }

  if (row.component_id !== null) await syncCurrentCost("component", row.component_id);
  else if (row.product_id !== null) await syncCurrentCost("product", row.product_id);
  else if (row.variant_id !== null) await syncCurrentCost("variant", row.variant_id);
}
