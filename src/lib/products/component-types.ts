// Pure constants + types for the component/BOM data (components.ts). No
// "server-only" / supabase import here, so it is safe to pull the runtime
// values (labels, option lists) into a client component. Kept in sync with the
// CHECK constraints in migration 0040.

export const COMPONENT_TYPES = ["raw_material", "product_package", "sticker", "other"] as const;
export type ComponentType = (typeof COMPONENT_TYPES)[number];

export const COMPONENT_UNITS = ["pcs", "l", "kg"] as const;
export type ComponentUnit = (typeof COMPONENT_UNITS)[number];

export const COMPONENT_TYPE_LABELS: Record<ComponentType, string> = {
  raw_material: "Raw Material",
  product_package: "Product Package",
  sticker: "Sticker",
  other: "Other",
};

// The unit a component is PRICED / PURCHASED in (cost is "per" this).
export const COMPONENT_UNIT_LABELS: Record<ComponentUnit, string> = {
  pcs: "Pcs",
  l: "L",
  kg: "KG",
};

// The unit a component is ALLOCATED / USED in on a (small) final product.
// KG is priced but used in grams, L is priced but used in ml, Pcs is used
// as-is. The divisor converts an entered allocation quantity back into the
// priced unit so: line cost = cost_per_priced_unit * quantity / divisor.
export const ALLOCATION_UNIT_LABELS: Record<ComponentUnit, string> = {
  pcs: "pc",
  l: "ml",
  kg: "g",
};

export const UNIT_DIVISOR: Record<ComponentUnit, number> = {
  pcs: 1,
  l: 1000,
  kg: 1000,
};

export function computeLineCost(costPerUnit: number | null, unit: ComponentUnit, quantity: number): number | null {
  if (costPerUnit === null) return null;
  return (costPerUnit * quantity) / UNIT_DIVISOR[unit];
}

export type ProductComponent = {
  id: number;
  type: ComponentType;
  account: string;
  unit: ComponentUnit;
  cost: number | null;
  updatedAt: string;
};

export type ComponentInput = { type: ComponentType; account: string; unit: ComponentUnit; cost: number | null };
