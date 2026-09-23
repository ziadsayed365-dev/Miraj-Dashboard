import { getMoversOrders, getMoversOrdersReport } from "@/lib/movers/orders";
import { getRecordDataSyncedAt } from "@/lib/record-data/expenses";
import { MoversOrdersTabs } from "../movers-orders-tabs";

export const dynamic = "force-dynamic";

export default async function MoversOrdersPage() {
  const [orders, report, syncedAt] = await Promise.all([
    getMoversOrders(),
    getMoversOrdersReport(),
    getRecordDataSyncedAt(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Movers Orders</h1>
        <p className="text-xs text-gray-400">
          Orders already synced from Shopify, shipped via Movers instead of Bosta. Flagging an order here changes how
          it&apos;s treated in the Income Statement (Actual) and Analysis by Product (Actual) - run Sync afterward to
          recompute.
        </p>
      </div>

      <MoversOrdersTabs orders={orders} report={report} syncedAt={syncedAt} />
    </div>
  );
}
