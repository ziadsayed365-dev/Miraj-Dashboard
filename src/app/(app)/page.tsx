import { cookies } from "next/headers";
import { getDailyPnl, sumTotals } from "@/lib/reports/daily-pnl";
import { egyptToday, daysAgo, addDays } from "@/lib/dates";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { getMissingTikTokDays } from "@/lib/tiktok-spend";
import { listModelGroups } from "@/lib/products/catalog";
import { IncomeStatementTabs } from "./income-statement-tabs";
import { TikTokSpendModal } from "./tiktok-spend-modal";
import { ExportPdfModal } from "./export-pdf-modal";

export const dynamic = "force-dynamic";

const ALL_TIME_START = "2000-01-01";

export default async function DailyPnlPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const params = await searchParams;
  const from = params.from ?? daysAgo(30);
  const to = params.to ?? egyptToday();
  const today = egyptToday();

  const cookieStore = await cookies();
  const role = verifySessionToken(cookieStore.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);

  // Compute the full-history rows once per mode; the summary cards (scoped to
  // [from, to]) are derived by filtering those rows, not a separate full query.
  const [performanceAllTime, actualAllTime, missingTikTokDays, modelGroups] = await Promise.all([
    getDailyPnl(ALL_TIME_START, today, "performance"),
    getDailyPnl(ALL_TIME_START, today, "actual"),
    role === "owner" ? getMissingTikTokDays() : Promise.resolve([]),
    role === "owner" ? listModelGroups() : Promise.resolve([]),
  ]);

  const inRange = (r: { date: string }) => r.date >= from && r.date <= to;
  const performanceSummaryTotals = sumTotals(performanceAllTime.rows.filter(inRange));
  const actualSummaryTotals = sumTotals(actualAllTime.rows.filter(inRange));

  return (
    <div className="space-y-6">
      {role === "owner" && <TikTokSpendModal missingDays={missingTikTokDays} modelGroups={modelGroups} />}
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-gray-900">Income Statement</h1>
        <ExportPdfModal defaultTo={addDays(today, -1)} />
      </div>

      <IncomeStatementTabs
        performance={{
          totals: performanceSummaryTotals,
          rows: performanceAllTime.rows,
          openMonthInfo: performanceAllTime.openMonthInfo,
          expectedDeliveryRate: performanceAllTime.expectedDeliveryRate,
        }}
        actual={{
          totals: actualSummaryTotals,
          rows: actualAllTime.rows,
          openMonthInfo: actualAllTime.openMonthInfo,
          expectedDeliveryRate: actualAllTime.expectedDeliveryRate,
        }}
        from={from}
        to={to}
        isOwner={role === "owner"}
      />
    </div>
  );
}
