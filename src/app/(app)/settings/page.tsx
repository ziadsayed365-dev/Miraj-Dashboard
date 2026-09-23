import { getUsers } from "@/lib/settings/users";
import { getExpenseAssumptions } from "@/lib/reports/expenses-ledger";
import { getAdAllocations } from "@/lib/reports/ad-allocation";
import { listAllocationCategories } from "@/lib/products/catalog";
import { SettingsTabs } from "../settings-tabs";

export const dynamic = "force-dynamic";

export default async function Settings() {
  const [users, assumptions, adAllocations, categoryTree] = await Promise.all([
    getUsers(),
    getExpenseAssumptions(),
    getAdAllocations(),
    listAllocationCategories(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Settings</h1>
      </div>

      <SettingsTabs users={users} assumptions={assumptions} adAllocations={adAllocations} categoryTree={categoryTree} />
    </div>
  );
}
