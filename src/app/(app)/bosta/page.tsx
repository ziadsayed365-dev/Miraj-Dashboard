import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { getOverallMonthlyRates, getProductMonthlyRates } from "@/lib/bosta/delivery-rate";
import { listUnresolvedOrders } from "@/lib/bosta/unresolved";
import { getChatOrderProducts, listChatOrders } from "@/lib/chat-orders/orders";
import { listProductAliases } from "@/lib/chat-orders/aliases";
import { BostaTabs } from "./bosta-tabs";

export const dynamic = "force-dynamic";

export default async function BostaPage() {
  const cookieStore = await cookies();
  const role = verifySessionToken(cookieStore.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);
  const isOwner = role === "owner";

  const [overall, product, unresolved, chatProducts, chatOrders, chatAliases] = await Promise.all([
    getOverallMonthlyRates(),
    getProductMonthlyRates(),
    listUnresolvedOrders(),
    getChatOrderProducts(),
    listChatOrders(),
    listProductAliases(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Bosta</h1>
        {isOwner && (
          <p className="text-xs text-gray-400">
            Delivery rate = delivered ÷ every order received — cancellations and orders never handed to a courier included —
            bucketed by the month each order came in, grouped by model (click a model to see its products). Returns come directly
            from Bosta; a month with orders still in progress isn&apos;t closed yet, so its rate rises as those resolve.
          </p>
        )}
      </div>

      <BostaTabs
        overall={overall}
        product={product}
        unresolved={unresolved}
        chatOrders={chatOrders}
        chatProducts={chatProducts}
        chatAliases={chatAliases}
      />
    </div>
  );
}
