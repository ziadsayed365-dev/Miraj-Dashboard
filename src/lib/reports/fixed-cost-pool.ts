// The Income Statement's contribution-to-net gap across a set of days - every
// below-Contribution line, netted: the six fixed overheads, the marketing agency
// fee, the courier costs (bosta penalty, next-day fee, open-package fee, and
// shipping differences - charged minus paid, so a negative value is a net cost
// and subtracts here), the "Other - Income"
// credit, and each owner-added P&L account (an expense adds to the pool, an
// income reduces it).
//
// This is the fixed-cost pool Analysis by Product allocates over products, so
// the on-screen report and the printed PDF charge products the same total.
// Equals `contributionProfit - netProfit` from sumTotals.
//
// Plain module (no "server-only") so the client-side print report can use it
// alongside the server-rendered products page. Only the row TYPE is imported,
// which erases at compile time.
import type { DailyPnlRow } from "./daily-pnl";

// `skipDate` drops the still-open day, which is shown as zero everywhere and so
// carries no fixed cost (and no items) until it closes.
export function fixedCostPool(rows: DailyPnlRow[], opts?: { skipDate?: string }): number {
  return rows.reduce((s, r) => {
    if (opts?.skipDate !== undefined && r.date === opts.skipDate) return s;
    const custom = r.customLines.reduce((c, l) => c + (l.kind === "income" ? -l.amount : l.amount), 0);
    return (
      s +
      r.salary +
      r.postProduction +
      r.subscription +
      r.rent +
      r.transportation +
      r.other +
      r.marketingAgencyFee +
      r.bostaPenalty +
      r.nextDayFee +
      r.openPackageFee -
      r.shippingDifferencesFee -
      r.otherIncome +
      custom
    );
  }, 0);
}
