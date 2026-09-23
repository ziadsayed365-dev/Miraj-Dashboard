// Shared by the Purchasing form (client) and the write path (server), so the
// per-unit cost shown while typing is exactly the one that gets stored. Kept out
// of purchases.ts because that module is server-only.

// Per-unit cost from a total, at the 2dp precision the costs it feeds carry
// (product_components.cost and products.unit_cost_override are both
// numeric(12,2)). The total is stored as entered rather than rebuilt from this,
// since the division isn't always exact.
export function unitCostFromTotal(totalAmount: number, quantity: number): number {
  if (!Number.isFinite(totalAmount) || !Number.isFinite(quantity) || quantity <= 0) return 0;
  return Math.round((totalAmount / quantity) * 100) / 100;
}
