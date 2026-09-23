import "server-only";
import { supabase } from "@/lib/supabase";
import {
  COMPONENT_TYPES,
  COMPONENT_UNITS,
  type ComponentInput,
  type ComponentType,
  type ComponentUnit,
  type ProductComponent,
} from "./component-types";

// Re-export the shared constants/types so server callers can keep importing
// them from here; client components must import from ./component-types directly
// (this module is server-only).
export * from "./component-types";

type Row = {
  id: number;
  type: ComponentType;
  account: string;
  unit: ComponentUnit;
  cost: number | null;
  updated_at: string;
};

export async function getProductComponents(): Promise<ProductComponent[]> {
  const { data, error } = await supabase
    .from("product_components")
    .select("id, type, account, unit, cost, updated_at")
    .order("type", { ascending: true })
    .order("account", { ascending: true });
  if (error) throw new Error(`Failed to load product_components: ${error.message}`);

  return ((data ?? []) as Row[]).map((r) => ({
    id: r.id,
    type: r.type,
    account: r.account,
    unit: r.unit,
    cost: r.cost === null ? null : Number(r.cost),
    updatedAt: r.updated_at,
  }));
}

function validate(input: ComponentInput): void {
  if (!COMPONENT_TYPES.includes(input.type)) throw new Error("Invalid type");
  if (!COMPONENT_UNITS.includes(input.unit)) throw new Error("Invalid unit");
  if (!input.account || !input.account.trim()) throw new Error("Account name is required");
  if (input.cost !== null && !Number.isFinite(input.cost)) throw new Error("Cost must be a number");
  if (input.cost !== null && input.cost < 0) throw new Error("Cost cannot be negative");
}

export async function createProductComponent(input: ComponentInput): Promise<number> {
  validate(input);
  const { data, error } = await supabase
    .from("product_components")
    .insert({ type: input.type, account: input.account.trim(), unit: input.unit, cost: input.cost })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Failed to create component: ${error?.message}`);
  return data.id;
}

export async function updateProductComponent(id: number, input: ComponentInput): Promise<void> {
  validate(input);
  const { error } = await supabase
    .from("product_components")
    .update({
      type: input.type,
      account: input.account.trim(),
      unit: input.unit,
      cost: input.cost,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw new Error(`Failed to update component: ${error.message}`);
}

export async function deleteProductComponents(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await supabase.from("product_components").delete().in("id", ids);
  if (error) throw new Error(`Failed to delete components: ${error.message}`);
}
