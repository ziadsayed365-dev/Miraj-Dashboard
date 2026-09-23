import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { getPurchases, getPurchaseTargets } from "@/lib/purchases/purchases";
import { PurchasingTab } from "../purchasing-tab";

export const dynamic = "force-dynamic";

export default async function PurchasingPage() {
  const cookieStore = await cookies();
  const role = verifySessionToken(cookieStore.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);

  if (role !== "owner") {
    return <p className="text-sm text-gray-500">Owner access only.</p>;
  }

  const [targets, purchases] = await Promise.all([getPurchaseTargets(), getPurchases()]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Purchasing</h1>
        <p className="text-xs text-gray-400">
          Enter the quantity and the total paid; the cost per unit is worked out from them and becomes that item&apos;s
          current cost. Buying a component re-costs every product whose bill of materials uses it. The total posts to the
          Purchasing account, which shows in Expense Analysis only — inventory is already deducted per delivered order as
          COGS.
        </p>
      </div>
      <PurchasingTab targets={targets} initialPurchases={purchases} />
    </div>
  );
}
