"use client";

import { useState } from "react";
import { BostaRateTable } from "./bosta-rate-table";
import { UnresolvedOrdersTab } from "./unresolved-orders-tab";
import { ChatOrdersTab } from "../chat-orders-tab";
import type { MonthlyRate, ProductRatesResult, UnresolvedOrder } from "@/lib/bosta/shared";
import type { ChatOrder, ChatOrderProduct } from "@/lib/chat-orders/shared";
import type { ProductAlias } from "@/lib/chat-orders/whatsapp";

// The Bosta page's views. Delivery Rate is the courier report; Unresolved
// Orders is where an order Bosta never resolved (usually because it was
// delivered privately) gets its real outcome recorded; Chat Orders records
// sales taken over chat, which never touch a courier at all - all three live
// here because this is the page about how orders reach the customer.
type TabKey = "rate" | "unresolved" | "chat";

export function BostaTabs({
  overall,
  product,
  unresolved,
  chatOrders,
  chatProducts,
  chatAliases,
}: {
  overall: MonthlyRate[];
  product: ProductRatesResult;
  unresolved: UnresolvedOrder[];
  chatOrders: ChatOrder[];
  chatProducts: ChatOrderProduct[];
  chatAliases: ProductAlias[];
}) {
  const [tab, setTab] = useState<TabKey>("rate");

  const TABS: { key: TabKey; label: string }[] = [
    { key: "rate", label: "Delivery Rate" },
    // The count is the point of the tab - it is the backlog waiting on someone.
    { key: "unresolved", label: unresolved.length > 0 ? `Unresolved Orders (${unresolved.length})` : "Unresolved Orders" },
    { key: "chat", label: "Chat Orders" },
  ];

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-gray-200">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium ${
              tab === t.key ? "border-b-2 border-gray-900 text-gray-900" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "rate" && <BostaRateTable overall={overall} product={product} />}
      {tab === "unresolved" && <UnresolvedOrdersTab orders={unresolved} />}
      {tab === "chat" && <ChatOrdersTab orders={chatOrders} products={chatProducts} aliases={chatAliases} />}
    </div>
  );
}
