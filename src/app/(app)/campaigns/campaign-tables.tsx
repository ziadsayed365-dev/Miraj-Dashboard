import type { CampaignRow } from "@/lib/reports/campaign-pnl";

// The two Campaigns P&L views, shared by the on-screen tabs and the PDF export
// (src/app/print/campaigns) so the printout is exactly what the page shows.

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return "—";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function profitClass(n: number): string {
  return n >= 0 ? "text-green-700" : "text-red-700";
}

// Revenue, COGS and Contribution are at full value - every order delivered.
// "After returns" is the same contribution with each product's expected
// delivery rate applied to its revenue and COGS.
export function CampaignPnlTable({ campaigns, compact = false }: { campaigns: CampaignRow[]; compact?: boolean }) {
  const totals = campaigns.reduce(
    (t, c) => ({
      orders: t.orders + c.orders,
      cancelledOrders: t.cancelledOrders + c.cancelledOrders,
      items: t.items + c.items,
      grossRevenue: t.grossRevenue + c.grossRevenue,
      grossCogs: t.grossCogs + c.grossCogs,
      adSpend: t.adSpend + c.adSpend,
      grossContribution: t.grossContribution + c.grossContribution,
      contributionProfit: t.contributionProfit + c.contributionProfit,
    }),
    { orders: 0, cancelledOrders: 0, items: 0, grossRevenue: 0, grossCogs: 0, adSpend: 0, grossContribution: 0, contributionProfit: 0 }
  );

  const cell = compact ? "px-2 py-1" : "px-3 py-2";
  const head = `${cell} text-right font-medium`;

  return (
    <div className="overflow-x-auto">
      <table className={`w-full ${compact ? "text-xs" : "text-sm"}`}>
        <thead className="text-[11px] uppercase text-gray-500">
          <tr className="border-b-2 border-gray-300 bg-gray-100">
            <th className={`${cell} text-left font-medium`}>Campaign</th>
            <th className={head}>Orders</th>
            <th className={head}>Cancelled</th>
            <th className={head}>Items</th>
            <th className={head}>Revenue</th>
            <th className={head}>COGS</th>
            <th className={head}>Marketing</th>
            <th className={head}>Contribution</th>
            <th className={head}>Contribution after returns</th>
            <th className={head}>CM %</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {campaigns.map((c) => (
            <tr key={c.campaignId ?? "unmatched"} className={c.campaignId === null ? "text-gray-400" : "text-gray-800"}>
              <td className={`${cell} text-left`}>{c.name}</td>
              <td className={`${cell} text-right`}>{c.orders}</td>
              <td className={`${cell} text-right ${c.cancelledOrders > 0 ? "text-red-600" : "text-gray-300"}`}>{c.cancelledOrders}</td>
              <td className={`${cell} text-right`}>{c.items}</td>
              <td className={`${cell} text-right`}>{fmt(c.grossRevenue)}</td>
              <td className={`${cell} text-right`}>{fmt(c.grossCogs)}</td>
              <td className={`${cell} text-right`}>{fmt(c.adSpend)}</td>
              <td className={`${cell} text-right ${profitClass(c.grossContribution)}`}>{fmt(c.grossContribution)}</td>
              <td className={`${cell} text-right font-medium ${profitClass(c.contributionProfit)}`}>{fmt(c.contributionProfit)}</td>
              <td className={`${cell} text-right`}>{pct(c.grossContribution, c.grossRevenue)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold text-gray-900">
            <td className={`${cell} text-left`}>Total</td>
            <td className={`${cell} text-right`}>{totals.orders}</td>
            <td className={`${cell} text-right ${totals.cancelledOrders > 0 ? "text-red-600" : ""}`}>{totals.cancelledOrders}</td>
            <td className={`${cell} text-right`}>{totals.items}</td>
            <td className={`${cell} text-right`}>{fmt(totals.grossRevenue)}</td>
            <td className={`${cell} text-right`}>{fmt(totals.grossCogs)}</td>
            <td className={`${cell} text-right`}>{fmt(totals.adSpend)}</td>
            <td className={`${cell} text-right ${profitClass(totals.grossContribution)}`}>{fmt(totals.grossContribution)}</td>
            <td className={`${cell} text-right ${profitClass(totals.contributionProfit)}`}>{fmt(totals.contributionProfit)}</td>
            <td className={`${cell} text-right`}>{pct(totals.grossContribution, totals.grossRevenue)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export function CampaignProductsList({ campaigns, compact = false }: { campaigns: CampaignRow[]; compact?: boolean }) {
  const withOrders = campaigns.filter((c) => c.orders > 0 || c.cancelledOrders > 0);
  if (withOrders.length === 0) return <div className="text-sm text-gray-500">No campaign orders in this range.</div>;

  return (
    <div className={`grid ${compact ? "grid-cols-3 gap-2" : "gap-3 sm:grid-cols-2 lg:grid-cols-3"}`}>
      {withOrders.map((c) => (
        <div key={c.campaignId ?? "unmatched"} className="break-inside-avoid rounded-lg border border-gray-200 bg-white p-3">
          <div className="flex items-baseline justify-between gap-2">
            <div className={`font-semibold text-gray-900 ${compact ? "text-xs" : "text-sm"}`}>{c.name}</div>
            <div className="shrink-0 text-xs text-gray-400">
              {c.orders} {c.orders === 1 ? "order" : "orders"}
              {c.cancelledOrders > 0 && <span className="text-red-600"> · {c.cancelledOrders} cancelled</span>}
            </div>
          </div>
          <ul className={`mt-2 space-y-0.5 text-gray-700 ${compact ? "text-xs" : "text-sm"}`}>
            {c.products.map((p) => (
              <li key={p.name} className="flex gap-2">
                <span className="w-8 shrink-0 text-right font-medium tabular-nums">{p.units}</span>
                <span>× {p.name}</span>
              </li>
            ))}
            {/* Cancelled orders: shown for the record, never counted in the P&L. */}
            {c.cancelledProducts.map((p) => (
              <li key={`cancelled-${p.name}`} className="flex items-center gap-2 text-gray-400">
                <span className="w-8 shrink-0 text-right font-medium tabular-nums">{p.units}</span>
                <span className="line-through">× {p.name}</span>
                <span className="rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-medium uppercase text-red-600">Cancelled</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
