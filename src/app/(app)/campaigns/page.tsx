import { getCampaignPnl } from "@/lib/reports/campaign-pnl";
import { egyptToday, addDays } from "@/lib/dates";
import { CampaignsTabs } from "./campaigns-tabs";
import { ExportCampaignsPdf } from "./export-campaigns-pdf";

export const dynamic = "force-dynamic";

export default async function CampaignsPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const params = await searchParams;
  // Yesterday by default, like Analysis by Product - the most recent full day.
  const yesterday = addDays(egyptToday(), -1);
  const to = params.to && params.to.length > 0 ? params.to : yesterday;
  const fromRaw = params.from && params.from.length > 0 ? params.from : to;
  const from = fromRaw <= to ? fromRaw : to;

  const report = await getCampaignPnl(from, to);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Campaigns P&amp;L</h1>
          <p className="text-xs text-gray-400">Meta campaigns · all amounts in EGP, excluding shipping.</p>
        </div>
        <ExportCampaignsPdf defaultFrom={from} defaultTo={report.to < from ? to : report.to} />
      </div>

      <form className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-white p-4">
        <div>
          <label className="block text-xs font-medium text-gray-500">From</label>
          <input type="date" name="from" defaultValue={from} className="mt-1 rounded border border-gray-300 px-2 py-1 text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500">To</label>
          <input type="date" name="to" defaultValue={to} className="mt-1 rounded border border-gray-300 px-2 py-1 text-sm" />
        </div>
        <button type="submit" className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700">
          Apply
        </button>
        <a href="/campaigns" className="px-3 py-1.5 text-sm font-medium text-gray-500 hover:text-gray-700">
          Reset to yesterday
        </a>
        <span className="text-xs text-gray-400">
          {report.to < from
            ? "Today is still open - pick a day up to yesterday."
            : `${report.attributedOrders} of ${report.placedOrders} orders credited to a Meta campaign${
                report.to !== to ? ` (through ${report.to}; today is still open)` : ""
              }.`}
        </span>
      </form>

      {report.uncheckedOrders > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
          {report.uncheckedOrders} {report.uncheckedOrders === 1 ? "order in this range hasn't" : "orders in this range haven't"} had
          {" "}their ad source read from Shopify yet, so they aren&apos;t credited to any campaign. Run Sync to pick them up.
        </div>
      )}

      <CampaignsTabs
        campaigns={report.campaigns}
        canViewPnl
        canViewProducts
      />
    </div>
  );
}
