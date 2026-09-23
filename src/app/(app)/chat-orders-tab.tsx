"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { egyptToday } from "@/lib/dates";
import { parseOptionKey, type ChatOrder, type ChatOrderProduct } from "@/lib/chat-orders/shared";
import { parseWhatsAppOrders, type ParsedOrder, type ProductAlias } from "@/lib/chat-orders/whatsapp";

// Ported from Laurel's chat-orders-tab.tsx. The one structural change: a row
// identifies its option by KEY ("productId:variantId") rather than a bare
// product id, because Miraj costs multi-variant products per variant.

// source is the WhatsApp line this row came from, carried so the review step can
// show the owner what it matched and so a hand-picked product can be taught back
// as an alias. Absent on rows added by hand.
type Row = { key: string; quantity: string; source?: string };

type Draft = {
  saleDate: string;
  orderCount: string;
  revenue: string;
  rows: Row[];
};

// One pasted message awaiting review. Keeps the parser's notes alongside the
// draft so the card can point at what needs attention.
type Pending = { key: number; draft: Draft; notes: string[] };

function emptyDraft(): Draft {
  return { saleDate: egyptToday(), orderCount: "1", revenue: "", rows: [{ key: "", quantity: "" }] };
}

function draftFromOrder(order: ChatOrder): Draft {
  return {
    saleDate: order.saleDate,
    orderCount: String(order.orderCount),
    revenue: String(order.revenue),
    rows: order.items.map((i) => ({ key: i.key, quantity: String(i.quantity) })),
  };
}

// Draft -> API body. Blank rows are the natural state of the "+ Add product"
// button, so they're dropped rather than rejected.
function toBody(d: Draft) {
  return {
    saleDate: d.saleDate,
    orderCount: Number(d.orderCount),
    revenue: Number(d.revenue),
    items: d.rows
      .filter((r) => r.key !== "")
      .map((r) => {
        const ref = parseOptionKey(r.key);
        return { productId: ref?.productId, variantId: ref?.variantId ?? null, quantity: Number(r.quantity) };
      }),
  };
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function fmtDate(d: string): string {
  return new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

export function ChatOrdersTab({
  orders,
  products,
  aliases,
}: {
  orders: ChatOrder[];
  products: ChatOrderProduct[];
  aliases: ProductAlias[];
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  // null = the create form at the top; a number = that order is open for editing.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editDraft, setEditDraft] = useState<Draft>(emptyDraft);
  const [editError, setEditError] = useState<string | null>(null);

  // Pasted-batch state: the raw text, the date the whole batch is dated, and the
  // parsed orders waiting for review.
  const [paste, setPaste] = useState("");
  const [batchDate, setBatchDate] = useState(egyptToday);
  const [pending, setPending] = useState<Pending[]>([]);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [batchNote, setBatchNote] = useState<string | null>(null);

  const productByKey = new Map(products.map((p) => [p.key, p]));

  function pendingFromParsed(parsed: ParsedOrder[], saleDate: string): Pending[] {
    return parsed.map((order, i) => ({
      key: Date.now() + i,
      draft: {
        saleDate,
        orderCount: "1", // each pasted WhatsApp message is one real order
        revenue: order.revenue === null ? "" : String(order.revenue),
        rows: order.lines.map((line) => ({
          key: line.key ?? "",
          quantity: String(line.quantity),
          source: line.raw,
        })),
      },
      notes: order.notes,
    }));
  }

  function handleParse() {
    setBatchError(null);
    setBatchNote(null);
    const parsed = parseWhatsAppOrders(paste, aliases, products);
    if (parsed.length === 0) {
      setBatchError("Nothing order-shaped found in that text. Separate each WhatsApp message with a blank line.");
      return;
    }
    setPending(pendingFromParsed(parsed, batchDate));
  }

  function updatePending(key: number, d: Draft) {
    setPending((list) => list.map((p) => (p.key === key ? { ...p, draft: d } : p)));
  }

  // Every row the owner resolved by hand keeps its source line, so teaching is
  // just "save each source→option pair". Already-known phrases upsert to the
  // same row server-side, so re-sending them costs nothing.
  async function teachAliases(submitted: Draft[]) {
    const entries = submitted.flatMap((d) =>
      d.rows.filter((r) => r.source && r.key !== "").map((r) => ({ alias: r.source as string, key: r.key }))
    );
    if (entries.length === 0) return;
    try {
      await fetch("/api/product-aliases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aliases: entries }),
      });
    } catch {
      // Learning is a convenience - the orders are already saved, so a failure
      // here must not read as a failed submit. Next paste just asks again.
    }
  }

  // Submits the reviewed batch one order at a time. Orders that save are dropped
  // from the list and the rest stay put with their error, so a retry can never
  // double-record what already went in.
  async function handleSubmitBatch() {
    setBatchError(null);
    setBatchNote(null);
    setBusy(true);
    const saved: Draft[] = [];
    const failed: { pending: Pending; message: string }[] = [];

    try {
      for (const item of pending) {
        try {
          const res = await fetch("/api/chat-orders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(toBody(item.draft)),
          });
          const data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to save");
          saved.push(item.draft);
        } catch (err) {
          failed.push({ pending: item, message: err instanceof Error ? err.message : "Failed to save" });
        }
      }

      await teachAliases(saved);
      setPending(failed.map((f) => ({ ...f.pending, notes: [f.message] })));
      if (saved.length > 0) {
        setPaste("");
        setBatchNote(`Recorded ${saved.length} order${saved.length === 1 ? "" : "s"}.`);
        router.refresh();
      }
      if (failed.length > 0) {
        setBatchError(`${failed.length} order${failed.length === 1 ? "" : "s"} couldn’t be saved — see the notes below.`);
      }
    } finally {
      setBusy(false);
    }
  }

  function beginEdit(order: ChatOrder) {
    setEditingId(order.id);
    setEditDraft(draftFromOrder(order));
    setEditError(null);
  }

  async function submit(url: string, method: string, d: Draft, onError: (msg: string) => void): Promise<boolean> {
    onError("");
    setBusy(true);
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toBody(d)),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to save");
      router.refresh();
      return true;
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to save");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const ok = await submit("/api/chat-orders", "POST", draft, (m) => setError(m || null));
    if (ok) setDraft(emptyDraft());
  }

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    const ok = await submit(`/api/chat-orders/${editingId}`, "PATCH", editDraft, (m) => setEditError(m || null));
    if (ok) setEditingId(null);
  }

  async function handleDelete(id: number) {
    setEditError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/chat-orders/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to delete");
      setEditingId(null);
      router.refresh();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-400">
        Record orders taken over chat and fulfilled directly — no courier is involved, so they always count as delivered.
        Revenue is the single price agreed for the whole order; the products below only price its COGS.
      </p>

      <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
        <div className="text-sm font-medium text-gray-900">Paste WhatsApp orders</div>
        <p className="text-xs text-gray-400">
          Paste the messages, one after another with a blank line between them. Only the product lines and the
          “الإجمالي قبل الشحن” total are read — name, phone, address and the after-shipping total are ignored. Nothing is
          saved until you review and submit below.
        </p>

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-500">Date for the whole batch</label>
            <input
              type="date"
              value={batchDate}
              onChange={(e) => setBatchDate(e.target.value)}
              className="mt-1 rounded border border-gray-300 px-2 py-1 text-sm"
            />
          </div>
        </div>

        <textarea
          dir="auto"
          rows={8}
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          placeholder={"الاسم:شيماء احمد\nرقم التلفون:01050382810\nالعنوان: المنيا\n\nرطب سكري القصيم\nالإجمالي قبل الشحن : ٦٣٢جنيه\nبعد الشحن ٦٧٥.٤٠"}
          className="w-full rounded border border-gray-300 px-2 py-1.5 font-mono text-sm"
        />

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleParse}
            disabled={busy || paste.trim() === ""}
            className="rounded-md bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40"
          >
            Read orders
          </button>
          {pending.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setPending([]);
                setBatchError(null);
                setBatchNote(null);
              }}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
            >
              Discard batch
            </button>
          )}
          {batchError && <span className="text-xs text-red-600">{batchError}</span>}
          {batchNote && <span className="text-xs text-green-700">{batchNote}</span>}
        </div>
      </div>

      {pending.length > 0 && (
        <div className="space-y-3 rounded-lg border border-amber-300 bg-amber-50/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium text-gray-900">
              Review {pending.length} order{pending.length === 1 ? "" : "s"} before submitting
            </div>
            <button
              type="button"
              onClick={handleSubmitBatch}
              disabled={busy}
              className="rounded-md bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40"
            >
              {busy ? "Saving…" : `Submit all ${pending.length}`}
            </button>
          </div>

          {pending.map((item, index) => (
            <div key={item.key} className="space-y-3 rounded-md border border-gray-200 bg-white p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-medium text-gray-500">Order {index + 1}</div>
                <button
                  type="button"
                  onClick={() => setPending((list) => list.filter((p) => p.key !== item.key))}
                  className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100"
                >
                  Skip
                </button>
              </div>
              {item.notes.length > 0 && (
                <ul className="space-y-0.5 text-xs text-amber-700">
                  {item.notes.map((note, i) => (
                    <li key={i}>• {note}</li>
                  ))}
                </ul>
              )}
              <DraftFields
                draft={item.draft}
                onChange={(d) => updatePending(item.key, d)}
                products={products}
                productByKey={productByKey}
              />
            </div>
          ))}
        </div>
      )}

      <form onSubmit={handleCreate} className="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
        <div className="text-sm font-medium text-gray-900">Record a Chat Order</div>
        <DraftFields draft={draft} onChange={setDraft} products={products} productByKey={productByKey} />
        {error && <div className="text-xs text-red-600">{error}</div>}
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40"
        >
          {busy ? "Saving…" : "Submit"}
        </button>
      </form>

      <div className="rounded-lg border border-gray-200 bg-white">
        <div className="border-b border-gray-100 px-4 py-3 text-sm font-medium text-gray-900">Recorded orders</div>
        {orders.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-gray-400">Nothing recorded yet.</div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {orders.map((order) => {
              const isEditing = editingId === order.id;
              return (
                <li key={order.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm text-gray-900">
                      {fmtDate(order.saleDate)}
                      <span className="text-gray-400"> · </span>
                      {order.items.reduce((n, i) => n + i.quantity, 0)} items
                      {order.orderCount > 1 && (
                        <>
                          <span className="text-gray-400"> · </span>
                          <span className="text-amber-700">{order.orderCount} orders</span>
                        </>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-sm">
                      <span className="text-gray-500">
                        {fmt(order.revenue)} − {fmt(order.cogs)} ={" "}
                        <span className={order.revenue - order.cogs >= 0 ? "text-gray-900" : "text-red-700"}>
                          {fmt(order.revenue - order.cogs)}
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => (isEditing ? setEditingId(null) : beginEdit(order))}
                        className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100"
                      >
                        {isEditing ? "Cancel" : "Edit"}
                      </button>
                    </div>
                  </div>

                  {!isEditing && (
                    <div className="mt-1 text-xs text-gray-500">
                      {order.items.map((i) => `${i.productName} × ${i.quantity}`).join(", ")}
                    </div>
                  )}

                  {isEditing && (
                    <form onSubmit={handleUpdate} className="mt-3 space-y-3 rounded-md border border-gray-200 bg-gray-50 p-3">
                      <DraftFields draft={editDraft} onChange={setEditDraft} products={products} productByKey={productByKey} />
                      {editError && <div className="text-xs text-red-600">{editError}</div>}
                      <div className="flex items-center gap-2">
                        <button
                          type="submit"
                          disabled={busy}
                          className="rounded-md bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40"
                        >
                          {busy ? "Saving…" : "Save changes"}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleDelete(order.id)}
                          className="rounded-md border border-red-300 px-4 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-40"
                        >
                          Delete
                        </button>
                      </div>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

// Product dropdown with a search box on top of the full list. Replaces a plain
// <select>: the catalogue is long enough that scrolling to an option was the
// slow part of recording an order, and a native select can only be jumped to by
// its first letters. Matches on label and SKU, so "lav" or a SKU fragment both
// land it. Ported from Laurel, keyed by option key rather than product id
// because Miraj picks a specific variant.
function ProductPicker({
  value,
  products,
  takenKeys,
  onChange,
}: {
  value: string; // "" = nothing picked yet
  products: ChatOrderProduct[];
  takenKeys: Set<string>; // already on this order - an option can only appear once
  onChange: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0); // highlighted row, driven by arrow keys
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = products.find((p) => p.key === value) ?? null;
  const label = (p: ChatOrderProduct) => `${p.label}${p.sku ? ` (SKU ${p.sku})` : ""}`;

  const q = query.trim().toLowerCase();
  const matches = q ? products.filter((p) => `${p.label} ${p.sku ?? ""}`.toLowerCase().includes(q)) : products;

  // Click anywhere else = give up on picking, leaving the current value alone.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Opening should land the caret in the search box - the whole point is to type
  // immediately rather than reach for the mouse.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Keep the highlighted row visible when arrowing past the fold.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelectorAll("li")[active]?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function choose(p: ChatOrderProduct) {
    if (takenKeys.has(p.key) && p.key !== value) return;
    onChange(p.key);
    setOpen(false);
    setQuery("");
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // This picker lives inside a form, so Enter must never reach it as a submit.
    if (e.key === "Enter") {
      e.preventDefault();
      const p = matches[active];
      if (p) choose(p);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      setQuery("");
    }
  }

  return (
    <div ref={boxRef} className="relative min-w-0 flex-1">
      {/* The trigger stays put when the panel opens, so the row doesn't shift
          and the current pick stays readable while browsing. */}
      <button
        type="button"
        onClick={() => {
          setActive(0);
          setQuery("");
          setOpen((o) => !o);
        }}
        className={`flex w-full items-center justify-between gap-2 rounded border bg-white px-2 py-1 text-left text-sm hover:bg-gray-50 ${
          open ? "border-gray-400 ring-1 ring-gray-300" : "border-gray-300"
        }`}
      >
        <span className={`truncate ${selected ? "" : "text-gray-400"}`}>{selected ? label(selected) : "Select a product…"}</span>
        <span className="shrink-0 text-[10px] text-gray-400">▼</span>
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-full min-w-[16rem] rounded border border-gray-200 bg-white shadow-lg">
          {/* Search sits above the list and stays put while it scrolls - the
              whole list is always there to browse, typing just narrows it. */}
          <div className="border-b border-gray-100 p-1.5">
            <input
              ref={inputRef}
              type="text"
              value={query}
              // A narrowing query invalidates the old highlight position, so the
              // reset rides along with the keystroke that caused it.
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Search by name or SKU…"
              className="w-full rounded border border-gray-300 px-2 py-1 text-sm outline-none focus:border-gray-400"
            />
          </div>

          <ul ref={listRef} className="max-h-60 overflow-auto py-1">
            {matches.map((p, i) => {
              // Already on another row of this order - shown but not pickable, so
              // it's obvious why it can't be chosen again.
              const taken = takenKeys.has(p.key) && p.key !== value;
              return (
                <li key={p.key}>
                  <button
                    type="button"
                    disabled={taken}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(p)}
                    className={`block w-full px-2 py-1.5 text-left text-sm ${
                      taken ? "cursor-not-allowed text-gray-300" : i === active ? "bg-gray-100 text-gray-900" : "text-gray-700"
                    } ${p.key === value ? "font-medium" : ""}`}
                  >
                    <span className="truncate">{label(p)}</span>
                    {taken && <span className="ml-1 text-[10px] text-gray-400">already added</span>}
                  </button>
                </li>
              );
            })}
            {matches.length === 0 && <li className="px-2 py-2 text-xs text-gray-400">No product matches “{query}”.</li>}
          </ul>

          <div className="border-t border-gray-100 px-2 py-1 text-[10px] text-gray-400">
            {matches.length} of {products.length} products
          </div>
        </div>
      )}
    </div>
  );
}

// Date / product rows / revenue. Shared by the create form and the inline edit
// form so the two can't drift apart.
function DraftFields({
  draft,
  onChange,
  products,
  productByKey,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  products: ChatOrderProduct[];
  productByKey: Map<string, ChatOrderProduct>;
}) {
  const chosen = new Set(draft.rows.map((r) => r.key).filter((k) => k !== ""));

  // Archived/draft products stay out of the picker, except one already on this
  // order - dropping it would silently rewrite the row on save.
  const selectable = products.filter((p) => p.isActive || chosen.has(p.key));

  // Indicative only: the saved figure is priced on the server from the current
  // built cost (see createChatOrder).
  const estCogs = draft.rows.reduce((sum, row) => {
    const product = row.key === "" ? null : productByKey.get(row.key);
    return sum + (product?.unitCost ?? 0) * (Number(row.quantity) || 0);
  }, 0);

  function setRow(index: number, patch: Partial<Row>) {
    onChange({ ...draft, rows: draft.rows.map((r, i) => (i === index ? { ...r, ...patch } : r)) });
  }

  return (
    <>
      <div className="flex flex-wrap gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-500">Date</label>
          <input
            type="date"
            value={draft.saleDate}
            onChange={(e) => onChange({ ...draft, saleDate: e.target.value })}
            className="mt-1 rounded border border-gray-300 px-2 py-1 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500"># of orders</label>
          <input
            type="number"
            min="1"
            step="1"
            value={draft.orderCount}
            onChange={(e) => onChange({ ...draft, orderCount: e.target.value })}
            className="mt-1 w-24 rounded border border-gray-300 px-2 py-1 text-right text-sm"
          />
          {/* Usually 1. Set higher only when this one record bundles several
              separate chat orders - it scales the estimated shipping difference. */}
          <p className="mt-1 max-w-[10rem] text-[10px] leading-tight text-gray-400">
            Leave at 1 per order. Raise it only if this record bundles several orders.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-xs font-medium text-gray-500">Products</div>
        {draft.rows.map((row, i) => (
          <div key={i} className="space-y-1">
            {/* The line this row was read from, so the owner can check the match
                against what the customer actually wrote. */}
            {row.source && (
              <div dir="auto" className={`text-xs ${row.key === "" ? "text-amber-700" : "text-gray-400"}`}>
                {row.key === "" ? "No match: " : "From: "}
                {row.source}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {/* An option can only appear once per order - the same one twice
                  would be two rows the report can't tell apart. */}
              <ProductPicker value={row.key} products={selectable} takenKeys={chosen} onChange={(key) => setRow(i, { key })} />
              <input
                type="number"
                min="1"
                step="1"
                value={row.quantity}
                placeholder="Qty"
                onChange={(e) => setRow(i, { quantity: e.target.value })}
                className="w-20 rounded border border-gray-300 px-2 py-1 text-right text-sm"
              />
              <button
                type="button"
                onClick={() => onChange({ ...draft, rows: draft.rows.filter((_, j) => j !== i) })}
                disabled={draft.rows.length === 1}
                aria-label="Remove product"
                className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 disabled:opacity-30"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
        <button
          type="button"
          onClick={() => onChange({ ...draft, rows: [...draft.rows, { key: "", quantity: "" }] })}
          className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100"
        >
          + Add product
        </button>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3 border-t border-gray-100 pt-3">
        <div>
          <label className="block text-xs font-medium text-gray-500">Total revenue for the whole order (EGP)</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={draft.revenue}
            placeholder="0"
            onChange={(e) => onChange({ ...draft, revenue: e.target.value })}
            className="mt-1 w-40 rounded border border-gray-300 px-2 py-1 text-right text-sm"
          />
        </div>
        <div className="text-right text-xs text-gray-500">
          <div>Est. COGS {fmt(estCogs)} EGP</div>
          <div className="text-gray-400">Priced on save from the product’s current built cost.</div>
        </div>
      </div>
    </>
  );
}
