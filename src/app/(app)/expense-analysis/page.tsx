import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { getDailyPnl } from "@/lib/reports/daily-pnl";
import {
  getCustomAccountsByMonth,
  getExpenseAccounts,
  getExpenseEntries,
  getRecordedOtherIncomeByMonth,
  getRecordedOverheadsByMonth,
} from "@/lib/reports/expenses-ledger";
import { egyptToday } from "@/lib/dates";
import { ExpenseTabs } from "../expense-tabs";

export const dynamic = "force-dynamic";

const ALL_TIME_START = "2000-01-01";

export default async function ExpenseAnalysisPage() {
  const cookieStore = await cookies();
  const isOwner = verifySessionToken(cookieStore.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET) === "owner";

  const [pnl, accounts, entries, recordedOverheads, recordedOtherIncome, analysisAccounts] = await Promise.all([
    getDailyPnl(ALL_TIME_START, egyptToday(), "performance"),
    isOwner ? getExpenseAccounts() : Promise.resolve([]),
    isOwner ? getExpenseEntries() : Promise.resolve([]),
    getRecordedOverheadsByMonth(),
    getRecordedOtherIncomeByMonth(),
    getCustomAccountsByMonth(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Expense &amp; Income</h1>
      </div>

      <ExpenseTabs
        rows={pnl.rows}
        openMonthInfo={pnl.openMonthInfo}
        isOwner={isOwner}
        accounts={accounts}
        entries={entries}
        recordedOverheads={recordedOverheads}
        recordedOtherIncome={recordedOtherIncome}
        analysisAccounts={analysisAccounts}
      />
    </div>
  );
}
