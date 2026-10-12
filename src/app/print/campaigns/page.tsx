import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { getCampaignPnl } from "@/lib/reports/campaign-pnl";
import { egyptToday, addDays } from "@/lib/dates";
import { PrintCampaigns } from "./print-campaigns";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Standalone print/PDF view of the Campaigns P&L - the P&L table, then the
// Products Sold summary on a second page. Opened from the page's Export PDF
// button; lives outside the (app) group so it prints without the app chrome.
// Params: from, to (inclusive Egypt days; default yesterday).
export default async function CampaignsPrintPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const params = await searchParams;

  // Owner and staff both see the on-screen page, so both can export it.
  const cookieStore = await cookies();
  const role = verifySessionToken(cookieStore.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);
  if (!role) redirect("/login");

  const to = params.to && params.to.length > 0 ? params.to : addDays(egyptToday(), -1);
  const fromRaw = params.from && params.from.length > 0 ? params.from : to;
  const from = fromRaw <= to ? fromRaw : to;

  const report = await getCampaignPnl(from, to);

  return <PrintCampaigns report={report} showPnl showProducts />;
}
