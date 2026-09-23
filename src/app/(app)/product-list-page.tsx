"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { CatalogProduct, CatalogVariant } from "@/lib/products/catalog";
import { compareLabels } from "@/lib/products/labels";

const inputClass = "w-full rounded border border-gray-300 px-1.5 py-1 text-xs";
const NEW_VALUE = "__new_label__";
const ALL = "__all__";
const UNSET = "__unset__";

function formatMoney(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// Spread across a variant-costed product's variants, e.g. "250 – 400". Shown on
// the parent row, which has no single price or cost of its own.
function rangeOf(values: (number | null)[]): string {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return "—";
  const low = Math.min(...present);
  const high = Math.max(...present);
  return low === high ? formatMoney(low) : `${formatMoney(low)} – ${formatMoney(high)}`;
}

// Distinct values for a dropdown, in the same Arabic order the table uses.
// Null is offered as its own "Uncategorised" choice, not dropped.
function optionsFor(values: (string | null)[]): { labels: string[]; hasUnset: boolean } {
  const labels = [...new Set(values.filter((v): v is string => v !== null))].sort((a, b) => compareLabels(a, b));
  return { labels, hasUnset: values.some((v) => v === null) };
}

export function ProductListPage({ products }: { products: CatalogProduct[] }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"active" | "all">("active");
  const [categoryFilter, setCategoryFilter] = useState<string>(ALL);
  const [subCategoryFilter, setSubCategoryFilter] = useState<string>(ALL);

  const categories = useMemo(() => optionsFor(products.map((p) => p.category)), [products]);

  // What the per-row editors offer. Drawn from the whole catalog rather than
  // the filtered view, so narrowing the table never shrinks the choices - and
  // a row's own value is always among them.
  const allSubCategories = useMemo(() => optionsFor(products.map((p) => p.subCategory)).labels, [products]);

  // The sub-category FILTER narrows to the chosen category, so it can't offer a
  // pairing that matches nothing (e.g. "سجاد ايليت" while filtered to مصاحف).
  const subCategories = useMemo(() => {
    const inCategory = products.filter(
      (p) => categoryFilter === ALL || (categoryFilter === UNSET ? p.category === null : p.category === categoryFilter)
    );
    return optionsFor(inCategory.map((p) => p.subCategory));
  }, [products, categoryFilter]);

  // A sub-category selection left over from the previous category would filter
  // everything away, so drop it once it is no longer on offer.
  useEffect(() => {
    if (subCategoryFilter === ALL) return;
    const stillValid = subCategoryFilter === UNSET ? subCategories.hasUnset : subCategories.labels.includes(subCategoryFilter);
    if (!stillValid) setSubCategoryFilter(ALL);
  }, [subCategories, subCategoryFilter]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    const matches = (value: string | null, filter: string) =>
      filter === ALL || (filter === UNSET ? value === null : value === filter);
    return products.filter((p) => {
      if (statusFilter === "active" && !p.isActive) return false;
      if (!matches(p.category, categoryFilter)) return false;
      if (!matches(p.subCategory, subCategoryFilter)) return false;
      if (query && !p.name.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [products, search, statusFilter, categoryFilter, subCategoryFilter]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by title…"
          className="w-64 rounded border border-gray-300 px-2 py-1.5 text-sm"
        />
        <div className="flex rounded-md border border-gray-300 text-xs font-medium">
          <button
            type="button"
            onClick={() => setStatusFilter("active")}
            className={`rounded-l-md px-3 py-1.5 ${statusFilter === "active" ? "bg-gray-900 text-white" : "bg-white text-gray-600"}`}
          >
            Active only
          </button>
          <button
            type="button"
            onClick={() => setStatusFilter("all")}
            className={`rounded-r-md px-3 py-1.5 ${statusFilter === "all" ? "bg-gray-900 text-white" : "bg-white text-gray-600"}`}
          >
            All statuses
          </button>
        </div>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="rounded border border-gray-300 px-2 py-1.5 text-sm"
        >
          <option value={ALL}>All categories</option>
          {categories.labels.map((label) => (
            <option key={label} value={label}>
              {label}
            </option>
          ))}
          {categories.hasUnset && <option value={UNSET}>Uncategorised</option>}
        </select>
        <select
          value={subCategoryFilter}
          onChange={(e) => setSubCategoryFilter(e.target.value)}
          className="rounded border border-gray-300 px-2 py-1.5 text-sm"
        >
          <option value={ALL}>All sub-categories</option>
          {subCategories.labels.map((label) => (
            <option key={label} value={label}>
              {label}
            </option>
          ))}
          {subCategories.hasUnset && <option value={UNSET}>No sub-category</option>}
        </select>
        <span className="text-xs text-gray-400">
          {filtered.length} of {products.length} products
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">SKU</th>
              <th className="px-3 py-2">Category</th>
              <th className="px-3 py-2">Sub Category</th>
              <th className="px-3 py-2">Price (EGP)</th>
              <th className="px-3 py-2">Unit cost (EGP)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.map((product) => (
              <Fragment key={product.id}>
                <ProductRow
                  product={product}
                  categoryOptions={categories.labels}
                  subCategoryOptions={allSubCategories}
                />
                {/* Sales are recorded against a variant, so a multi-variant
                    product is costed here rather than on the parent row. */}
                {product.variants.map((variant) => (
                  <VariantRow key={variant.id} variant={variant} />
                ))}
              </Fragment>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-gray-400">
                  No products match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// A pick-or-add cell for the storefront taxonomy: choose an existing label,
// clear it, or type a brand new one without leaving the row. Kept generic so
// Category and Sub Category behave identically.
function TaxonomyCell({
  value,
  options,
  addLabel,
  disabled,
  onSave,
}: {
  value: string | null;
  options: string[];
  addLabel: string;
  disabled: boolean;
  onSave: (next: string | null) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  async function commitNew(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    setAdding(false);
    setDraft("");
    await onSave(trimmed);
  }

  if (adding) {
    return (
      <form onSubmit={commitNew} className="flex items-center gap-1">
        <input
          autoFocus
          dir="rtl"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={addLabel}
          disabled={disabled}
          className={inputClass}
        />
        <button type="submit" disabled={disabled} className="rounded bg-gray-900 px-2 py-1 text-xs text-white disabled:opacity-40">
          Save
        </button>
        <button
          type="button"
          onClick={() => {
            setAdding(false);
            setDraft("");
          }}
          className="text-xs text-gray-400"
        >
          Cancel
        </button>
      </form>
    );
  }

  return (
    <select
      dir="rtl"
      value={value ?? ""}
      disabled={disabled}
      onChange={(e) => {
        if (e.target.value === NEW_VALUE) setAdding(true);
        else onSave(e.target.value === "" ? null : e.target.value);
      }}
      className={`${inputClass} ${value === null ? "text-gray-400" : "text-gray-700"}`}
    >
      <option value="">— none —</option>
      {options.map((label) => (
        <option key={label} value={label}>
          {label}
        </option>
      ))}
      <option value={NEW_VALUE}>{addLabel}</option>
    </select>
  );
}

function ProductRow({
  product,
  categoryOptions,
  subCategoryOptions,
}: {
  product: CatalogProduct;
  categoryOptions: string[];
  subCategoryOptions: string[];
}) {
  const router = useRouter();
  const [costInput, setCostInput] = useState(product.unitCost !== null ? String(product.unitCost) : "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-sync the cost field when the server gives us a fresh value after a
  // refresh - local state only initializes once.
  useEffect(() => {
    setCostInput(product.unitCost !== null ? String(product.unitCost) : "");
  }, [product.unitCost]);

  const savedCostValue = product.unitCost !== null ? String(product.unitCost) : "";
  const costDirty = costInput !== savedCostValue;
  const hasVariants = product.variants.length > 0;

  async function patchProduct(patch: Record<string, unknown>, failure: string) {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/products/${product.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? failure);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : failure);
    } finally {
      setSubmitting(false);
    }
  }

  // Cost belongs to the product itself - there is no shared model to write to,
  // so every row's cost is its own.
  async function handleSaveCost() {
    const trimmed = costInput.trim();
    const parsed = trimmed === "" ? null : Number(trimmed);
    if (parsed !== null && !Number.isFinite(parsed)) {
      setError("Cost must be a number.");
      return;
    }
    if (parsed !== null && parsed < 0) {
      setError("Cost cannot be negative.");
      return;
    }
    await patchProduct({ unitCostOverride: parsed }, "Failed to update cost");
  }

  return (
    <tr className={submitting ? "opacity-60" : ""}>
      <td className="px-3 py-2 text-gray-900">
        {product.name}
        {!product.isActive && <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">inactive</span>}
        {hasVariants && (
          <div className="mt-0.5 text-[10px] text-gray-400">{product.variants.length} variants — costed per variant below</div>
        )}
      </td>
      <td className="px-3 py-2 text-gray-500">{product.sku ?? "—"}</td>
      <td className="px-3 py-2">
        <TaxonomyCell
          value={product.category}
          options={categoryOptions}
          addLabel="+ New category…"
          disabled={submitting}
          onSave={(next) => patchProduct({ category: next }, "Failed to update category")}
        />
      </td>
      <td className="px-3 py-2">
        <TaxonomyCell
          value={product.subCategory}
          options={subCategoryOptions}
          addLabel="+ New sub-category…"
          disabled={submitting}
          onSave={(next) => patchProduct({ subCategory: next }, "Failed to update sub-category")}
        />
      </td>
      {hasVariants ? (
        // No single price or cost to show - both live on the variant rows.
        <>
          <td className="px-3 py-2 text-gray-500">{rangeOf(product.variants.map((v) => v.currentPrice))}</td>
          <td className="px-3 py-2 text-gray-500">{rangeOf(product.variants.map((v) => v.unitCost))}</td>
        </>
      ) : (
        <>
          <td className="px-3 py-2 text-gray-500">{formatMoney(product.currentPrice)}</td>
          <td className="px-3 py-2">
            <div className="flex items-center gap-1">
              <input
                value={costInput}
                onChange={(e) => setCostInput(e.target.value)}
                disabled={submitting}
                type="number"
                min="0"
                className={`${inputClass} w-24`}
              />
              <button
                type="button"
                onClick={handleSaveCost}
                disabled={submitting || !costDirty}
                className="rounded bg-gray-900 px-2 py-1 text-xs text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                Save
              </button>
            </div>
            {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
          </td>
        </>
      )}
    </tr>
  );
}

// One variant of a multi-variant product: its own SKU, price and cost, sitting
// indented under its parent. Category and Sub Category are the product's, so
// they are not repeated here.
function VariantRow({ variant }: { variant: CatalogVariant }) {
  const router = useRouter();
  const [costInput, setCostInput] = useState(variant.unitCost !== null ? String(variant.unitCost) : "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCostInput(variant.unitCost !== null ? String(variant.unitCost) : "");
  }, [variant.unitCost]);

  const costDirty = costInput !== (variant.unitCost !== null ? String(variant.unitCost) : "");

  async function handleSaveCost() {
    const trimmed = costInput.trim();
    const parsed = trimmed === "" ? null : Number(trimmed);
    if (parsed !== null && !Number.isFinite(parsed)) {
      setError("Cost must be a number.");
      return;
    }
    if (parsed !== null && parsed < 0) {
      setError("Cost cannot be negative.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/variants/${variant.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unitCostOverride: parsed }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to update cost");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update cost");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <tr className={`bg-gray-50/60 ${submitting ? "opacity-60" : ""}`}>
      <td className="py-2 pl-8 pr-3 text-gray-600" dir="rtl">
        {variant.title}
      </td>
      <td className="px-3 py-2 text-gray-500">{variant.sku ?? "—"}</td>
      <td className="px-3 py-2 text-[10px] text-gray-300" colSpan={2}>
        inherits product category
      </td>
      <td className="px-3 py-2 text-gray-500">{formatMoney(variant.currentPrice)}</td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-1">
          <input
            value={costInput}
            onChange={(e) => setCostInput(e.target.value)}
            disabled={submitting}
            type="number"
            min="0"
            className={`${inputClass} w-24`}
          />
          <button
            type="button"
            onClick={handleSaveCost}
            disabled={submitting || !costDirty}
            className="rounded bg-gray-900 px-2 py-1 text-xs text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            Save
          </button>
        </div>
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </td>
    </tr>
  );
}
