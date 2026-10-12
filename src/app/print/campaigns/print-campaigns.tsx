"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { CampaignPnlResult } from "@/lib/reports/campaign-pnl";
import { CampaignPnlTable, CampaignProductsList } from "@/app/(app)/campaigns/campaign-tables";
import { egyptToday } from "@/lib/dates";

const BRAND_NAVY = "#050a30";

// The printable area of A4 portrait at the 10mm margins below, in CSS pixels
// (190mm x 277mm at 96dpi), less a few pixels of slack for rounding.
const SHEET_W = 716;
const SHEET_H = 1040;

function fmtLongDate(d: string): string {
  return new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

// Same print setup as the Income Statement export: A4 portrait, keep the
// on-screen colours, hide the on-screen-only toolbar.
const PRINT_CSS = `
  @page { size: A4 portrait; margin: 10mm; }
  @media print {
    .no-print { display: none !important; }
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
`;

export function PrintCampaigns({
  report,
  showPnl,
  showProducts,
}: {
  report: CampaignPnlResult;
  showPnl: boolean;
  showProducts: boolean;
}) {
  // Two pages: the P&L on the first, Products Sold on the second (just one if
  // the viewer may only see one of them). Each page is laid out at the
  // printable width, measured, and zoomed down just enough to fit A4's height -
  // the same as the print dialog's "fit to page", but without relying on it.
  // While zoomed a page is laid out wider (width / scale), so it still spans
  // the full page width and only gets shorter.
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

  // Print only once the fitted layout is in place, after a beat for fonts.
  useEffect(() => {
    if (scales === null) return;
    const t = setTimeout(() => window.print(), 500);
    return () => clearTimeout(t);
  }, [scales]);

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

  const pages: ReactNode[] = [];
  if (showPnl)
    pages.push(
      <section>
        <h2 className="mb-2 text-base font-bold" style={{ color: BRAND_NAVY }}>
          P&amp;L by Campaign
        </h2>
        <CampaignPnlTable campaigns={report.campaigns} compact />
        <p className="mt-2 text-[10px] text-gray-500">
          {report.attributedOrders} of {report.placedOrders} orders credited to a Meta campaign. Revenue and COGS are the
          full value of every order. Contribution = Revenue − COGS − Marketing; after returns applies each product&apos;s
          expected delivery rate.
        </p>
      </section>
    );
  if (showProducts)
    pages.push(
      <section>
        <h2 className="mb-2 text-base font-bold" style={{ color: BRAND_NAVY }}>
          Products Sold by Campaign
        </h2>
        <CampaignProductsList campaigns={report.campaigns} compact />
      </section>
    );

  return (
    <div className="bg-white p-6 text-gray-900 print:p-0">
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />

      <div className="no-print mb-4 flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-2">
        <span className="text-xs text-gray-500">Use your browser&apos;s dialog to save as PDF. It should open automatically.</span>
        <button
          type="button"
          onClick={() => window.print()}
          className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700"
        >
          Print / Save as PDF
        </button>
      </div>

      {pages.map((content, i) => {
        const scale = scales?.[i] ?? null;
        return (
          // The page break sits on an unzoomed wrapper, so each page starts a new sheet.
          <div
            key={i}
            className={i > 0 ? "mt-10 border-t border-dashed border-gray-300 pt-10 print:mt-0 print:border-0 print:pt-0" : ""}
            style={i > 0 ? { breakBefore: "page" } : undefined}
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
