import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { getDailyPnl } from "@/lib/reports/daily-pnl";
import { getPerProductReport, type ModelRow } from "@/lib/reports/per-product";
import { egyptToday, addDays } from "@/lib/dates";
import { PrintReport, type ProductDepth } from "./print-report";

export const dynamic = "force-dynamic";

const ALL_TIME_START = "2000-01-01";
const MAX_COLUMNS = 7;

// Standalone print/PDF view of the Income Statement and/or Analysis by Product.
// Opened in its own tab from the Export PDF modal; it has no app chrome (it
// lives outside the (app) route group) and auto-triggers the browser's print /
// Save-as-PDF dialog. Params:
//   from, to - the day columns to show (inclusive). One day = one column,
//              capped at 7. Default: yesterday only.
//   is       - "1" to include the Income Statement (+ ratios).
//   product  - "1" to include Analysis by Product (+ Key Ratios).
//   level    - how far down Analysis by Product prints: "category" (one row per
//              category), "sub" (categories + their sub-categories), or "item"
//              (down to every product/variant). Defaults to "sub".
export default async function IncomeStatementPrintPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; is?: string; product?: string; level?: string; expand?: string }>;
}) {
  const params = await searchParams;

  const cookieStore = await cookies();
  const role = verifySessionToken(cookieStore.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);
  if (!role) redirect("/login");

  const today = egyptToday();
  const to = params.to && params.to.length > 0 ? params.to : addDays(today, -1);
  const fromRaw = params.from && params.from.length > 0 ? params.from : to;
  const from = fromRaw <= to ? fromRaw : to;

  // Default to Income Statement if neither flag is set, so a bare URL still
  // shows something.
  let showIncome = params.is === "1";
  const showProduct = params.product === "1";
  // `expand=1` is the old two-state flag this replaced; still honoured so a URL
  // saved before the three-level choice existed keeps printing what it used to.
  const productDepth: ProductDepth =
    params.level === "category" || params.level === "sub" || params.level === "item"
      ? params.level
      : params.expand === "1"
        ? "item"
        : "sub";
  if (!showIncome && !showProduct) showIncome = true;

  // Same source the on-screen Income Statement uses; the columns are exactly the
  // chosen days that have data, capped at the last 7.
  const pnl = await getDailyPnl(ALL_TIME_START, to, "performance");
  const inRange = pnl.rows.filter((r) => r.date >= from && r.date <= to);
  const window = inRange.slice(Math.max(0, inRange.length - MAX_COLUMNS));
  const colFrom = window.length > 0 ? window[0].date : from;

  let models: ModelRow[] | null = null;
  if (showProduct && window.length > 0) {
    const report = await getPerProductReport(colFrom, to, "performance");
    models = report.models;
  }

  return (
    <PrintReport
      window={window}
      rate={pnl.openMonthInfo?.rate ?? null}
      expectedDeliveryRate={pnl.expectedDeliveryRate}
      showIncome={showIncome}
      showProduct={showProduct}
      productDepth={productDepth}
      models={models}
      from={colFrom}
      to={to}
    />
  );
}
