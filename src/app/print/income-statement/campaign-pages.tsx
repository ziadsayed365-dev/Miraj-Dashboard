"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CampaignPnlResult } from "@/lib/reports/campaign-pnl";
import { CampaignPnlTable, CampaignProductsList } from "@/app/(app)/campaigns/campaign-tables";
import { egyptToday } from "@/lib/dates";

const BRAND_NAVY = "#050a30";

// The printable area of A4 portrait at the page's 10mm margins, in CSS pixels
// (190mm x 277mm at 96dpi), less a few pixels of slack for rounding - the same
// sheet as the Campaigns P&L's own export (src/app/print/campaigns).
const SHEET_W = 716;
const SHEET_H = 1040;

// A4 portrait with the on-screen colours kept - the same as the report's own
// print CSS, repeated so these pages print right when they are the whole export.
const PRINT_CSS = `
  @page { size: A4 portrait; margin: 10mm; }
  @media print {
    .no-print { display: none !important; }
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
`;

function fmtLongDate(d: string): string {
  return new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

// The Campaigns P&L as the last two pages of the Income Statement export ("Campaigns
// P&L" in the Export PDF dialog, and always in the nightly bot's PDF): P&L by
// Campaign, then Products Sold by Campaign, each zoomed to fit its own A4 page
// the way the Campaigns P&L's own export does. Once both are fitted the wrapper
// is marked data-campaigns="fitted", which the bot's PDF step waits for.
//
// `newPage` starts the first page on a fresh sheet (when the report comes
// before it); `autoPrint` opens the print dialog once fitted (when these pages
// are the whole export, so nothing else will).
export function CampaignPages({
  report,
  newPage,
  autoPrint,
}: {
  report: CampaignPnlResult;
  newPage: boolean;
  autoPrint: boolean;
}) {
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [scales, setScales] = useState<number[] | null>(null);
  useLayoutEffect(() => {
    setScales(
      pageRefs.current.map((el) => {
        const height = el?.scrollHeight ?? 0;
        return height > SHEET_H ? SHEET_H / height : 1;
      })
    );
  }, []);

  useEffect(() => {
    if (scales === null || !autoPrint) return;
    const t = setTimeout(() => window.print(), 500);
    return () => clearTimeout(t);
  }, [scales, autoPrint]);

  const closed = report.to >= report.from;
  const header = (
    <header className="mb-4 flex items-end justify-between border-b-2 pb-2" style={{ borderColor: BRAND_NAVY }}>
      <div>
        <div className="text-lg font-bold" style={{ color: BRAND_NAVY }}>
          Miraj — Campaigns P&amp;L
        </div>
        <div className="text-xs text-gray-500">
          {closed ? `${fmtLongDate(report.from)} – ${fmtLongDate(report.to)}` : "No closed days in the selected range"} · Meta
          campaigns, last ad click · EGP excluding shipping
        </div>
      </div>
      <div className="text-right text-[10px] text-gray-400">Generated {fmtLongDate(egyptToday())}</div>
    </header>
  );

  const pages = [
    <section key="pnl">
      <h2 className="mb-2 text-base font-bold" style={{ color: BRAND_NAVY }}>
        P&amp;L by Campaign
      </h2>
      <CampaignPnlTable campaigns={report.campaigns} compact />
      <p className="mt-2 text-[10px] text-gray-500">
        {report.attributedOrders} of {report.placedOrders} orders credited to a Meta campaign. Revenue and COGS are the full
        value of every order. Contribution = Revenue − COGS − Marketing; after returns applies each product&apos;s expected
        delivery rate.
      </p>
    </section>,
    <section key="products">
      <h2 className="mb-2 text-base font-bold" style={{ color: BRAND_NAVY }}>
        Products Sold by Campaign
      </h2>
      <CampaignProductsList campaigns={report.campaigns} compact />
    </section>,
  ];

  return (
    <div className="bg-white px-6 pb-6 text-gray-900 print:p-0" data-campaigns={scales ? "fitted" : "fitting"}>
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />
      {pages.map((content, i) => {
        const scale = scales?.[i] ?? null;
        const breakBefore = i > 0 || newPage;
        return (
          // The page break sits on an unzoomed wrapper, so each page starts a new sheet.
          <div
            key={i}
            className={breakBefore ? "mt-10 border-t border-dashed border-gray-300 pt-10 print:mt-0 print:border-0 print:pt-0" : ""}
            style={breakBefore ? { breakBefore: "page" } : undefined}
          >
            <div
              ref={(el) => {
                pageRefs.current[i] = el;
              }}
              className="mx-auto"
              style={{ width: scale ? SHEET_W / scale : SHEET_W, zoom: scale ?? 1 }}
            >
              {header}
              {content}
            </div>
          </div>
        );
      })}
    </div>
  );
}
