// Client report: shipping rate card per governorate - what we charge on the
// website vs. what Bosta charges us, and the difference.
//
// This is a RATE card (per-order rates), not a total of all orders. Each row
// answers "for one order to this governorate, what do we charge and what do we
// pay". The Delivered column is context only (how much volume sits behind the
// rate).
//
// Basis: Bosta DELIVERED orders only (outcome = 'delivered'), grouped by
// Bosta's governorate (outcome_governorate). Cancelled, failed/RTO, exchange,
// pickup-return, and still-in-transit orders are excluded.
//
//   Our Rate    - the shipping fee charged on the website. Taken as the most
//                 common (modal) shipping_fee_charged across that governorate's
//                 real orders, since there's no rate-card table in the DB. Real
//                 tiers: 75 Cairo/Giza/Delta, 90 Upper Egypt, 100 Red Sea,
//                 120 Sinai/New Valley.
//   Bosta Rate  - bosta_fee_matrix.deliver for the governorate's zone (the
//                 owner's rate card, seeded from AL.xlsx).
//   Next Day    - Bosta's 1% next-day cash-settlement fee. Not a flat rate: it
//                 tracks order value, so this is 1% of the average COD collected
//                 per delivered order in that governorate.
//   Open Pkg    - flat 7 EGP + 14% VAT = 7.98, same everywhere.
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";

const env = Object.fromEntries(
  fs
    .readFileSync(path.join(process.cwd(), ".env.local"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")];
    })
);

const SUPA_URL = env.SUPABASE_URL;
const SUPA_KEY = env.SUPABASE_SECRET_KEY;
const SCHEMA = env.SUPABASE_SCHEMA || "public";

// Mirrors normalizeGovernorate in src/lib/governorates.ts - scripts are plain
// .mjs and can't import the TS module. Keep in sync if aliases are added there.
const ALIASES = {
  "al sharqia": "Sharqia",
  "kafr el-sheikh": "Kafr El Sheikh",
  "6th of october": "Giza",
  assuit: "Asyut",
  "bani suif": "Beni Suef",
  behira: "Beheira",
  "el kalioubia": "Qalyubia",
  fayoum: "Faiyum",
  "kafr alsheikh": "Kafr El Sheikh",
  menya: "Minya",
};

function normalizeGovernorate(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  return ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

async function get(pathAndQuery) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "Accept-Profile": SCHEMA },
  });
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Rolling window: only orders placed (order_created_at) in the last N months.
// The rate figures are per-order and window-independent, but the Delivered
// column (volume context) and the modal Our Rate now reflect recent activity
// only.
const WINDOW_MONTHS = 6;
const sinceDate = new Date();
sinceDate.setMonth(sinceDate.getMonth() - WINDOW_MONTHS);
const since = sinceDate.toISOString();
const WINDOW_LABEL = `last ${WINDOW_MONTHS} months`;

// Keyset pagination on id - deep Range offsets over the orders table blow
// Supabase's statement timeout (same reason margin.ts windows its recompute).
async function fetchOrders() {
  const select = "id, outcome, cod_amount_collected, total_price, shipping_fee_charged, outcome_governorate, governorate_shopify";
  const rows = [];
  let lastId = 0;
  for (;;) {
    const batch = await get(
      `orders?select=${encodeURIComponent(select)}&outcome=eq.delivered&cancelled_at=is.null&order_created_at=gte.${since}&id=gt.${lastId}&order=id.asc&limit=1000`
    );
    rows.push(...batch);
    if (batch.length < 1000) break;
    lastId = batch[batch.length - 1].id;
  }
  return rows;
}

const today = new Date().toISOString().slice(0, 10);

const [settings] = await get("settings?select=default_box_size_tier&id=eq.1");

// Both fee tables are effective-dated (0053), so take the newest period/row that
// has already taken effect - rows sort ascending, so the last one standing wins.
// NOTE: this report spans six months, which now straddles the 2026-08-04
// re-pricing. It is a snapshot of TODAY's card applied across the window, not a
// month-by-month history - the P&L is the place to see fees as actually billed.
const [period] = await get(
  `bosta_fee_periods?select=open_package_fee,open_package_vat_pct,cod_cash_fee_pct&effective_from=lte.${today}&order=effective_from.desc&limit=1`
);
const openPackageFee = Number(period.open_package_fee) * (1 + Number(period.open_package_vat_pct));
const codCashFeePct = Number(period.cod_cash_fee_pct);

const govZones = await get("governorate_fees?select=governorate,zone");
const zoneByGov = new Map(govZones.map((g) => [g.governorate, g.zone]));

const matrix = await get(
  `bosta_fee_matrix?select=zone,shipment_size,effective_from,deliver&effective_from=lte.${today}&order=effective_from.asc`
);
const deliverByZone = new Map(
  matrix.filter((m) => m.shipment_size === settings.default_box_size_tier).map((m) => [m.zone, Number(m.deliver)])
);

const orders = await fetchOrders();

const byGov = new Map();
for (const o of orders) {
  const gov = normalizeGovernorate(o.outcome_governorate) ?? normalizeGovernorate(o.governorate_shopify);
  if (!gov) continue;

  let g = byGov.get(gov);
  if (!g) g = { governorate: gov, orders: 0, rateCounts: new Map(), codSum: 0, codCount: 0 };
  byGov.set(gov, g);

  g.orders++;
  if (o.shipping_fee_charged != null) {
    const fee = Number(o.shipping_fee_charged);
    g.rateCounts.set(fee, (g.rateCounts.get(fee) ?? 0) + 1);
  }
  // Next-day fee only applies to money actually collected, so average COD over
  // delivered orders only.
  if (o.outcome === "delivered") {
    g.codSum += Number(o.cod_amount_collected ?? o.total_price ?? 0);
    g.codCount++;
  }
}

const rows = [...byGov.values()]
  .map((g) => {
    // Modal website rate - a handful of orders carry a one-off manual fee, so
    // the most common value is the real published rate, not the average.
    let ourRate = null;
    let best = 0;
    for (const [fee, count] of g.rateCounts) {
      if (count > best) {
        best = count;
        ourRate = fee;
      }
    }
    const zone = zoneByGov.get(g.governorate) ?? null;
    const bostaRate = deliverByZone.get(zone) ?? null;
    const avgCod = g.codCount > 0 ? g.codSum / g.codCount : 0;
    const nextDayFee = avgCod * codCashFeePct;
    const totalCost = (bostaRate ?? 0) + nextDayFee + openPackageFee;
    return {
      governorate: g.governorate,
      orders: g.orders,
      ourRate,
      bostaRate,
      difference: ourRate != null && bostaRate != null ? ourRate - bostaRate : null,
      nextDayFee,
      openPackageFee,
      totalCost,
      netPerOrder: ourRate != null ? ourRate - totalCost : null,
    };
  })
  .sort((a, b) => (a.netPerOrder ?? 0) - (b.netPerOrder ?? 0)); // worst first

const wb = new ExcelJS.Workbook();
wb.creator = "Miraj Dashboard";
wb.created = new Date();
const ws = wb.addWorksheet(`Shipping Rates (${WINDOW_LABEL})`, { views: [{ state: "frozen", ySplit: 1 }] });

ws.columns = [
  { header: "Governorate", key: "governorate", width: 20 },
  { header: "Delivered Orders", key: "orders", width: 16 },
  { header: "Our Rate (website)", key: "ourRate", width: 18 },
  { header: "Bosta Rate (charged to us)", key: "bostaRate", width: 24 },
  { header: "Difference", key: "difference", width: 13 },
  { header: "Next Day Fee (1% COD)", key: "nextDayFee", width: 20 },
  { header: "Open Package Fee", key: "openPackageFee", width: 18 },
  { header: "Total Cost to Us", key: "totalCost", width: 17 },
  { header: "Net per Order", key: "netPerOrder", width: 14 },
];

ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
ws.getRow(1).alignment = { vertical: "middle", wrapText: true };

const MONEY = ["ourRate", "bostaRate", "difference", "nextDayFee", "openPackageFee", "totalCost", "netPerOrder"];

for (const r of rows) {
  const row = ws.addRow(r);
  MONEY.forEach((k) => (row.getCell(k).numFmt = "#,##0.00;[Red]-#,##0.00"));
  for (const k of ["difference", "netPerOrder"]) {
    if (r[k] != null && r[k] < 0) row.getCell(k).font = { color: { argb: "FFB91C1C" }, bold: true };
  }
}

ws.autoFilter = { from: "A1", to: "I1" };

const outPath = path.join(process.cwd(), "shipping-differences-6m.xlsx");
await wb.xlsx.writeFile(outPath);

const totalDelivered = rows.reduce((s, r) => s + r.orders, 0);
console.log(`Wrote ${rows.length} governorates, ${totalDelivered} delivered orders (placed since ${since.slice(0, 10)}, ${WINDOW_LABEL}) -> ${outPath}\n`);
const pad = (s, n) => String(s).padStart(n);
console.log(`${"Governorate".padEnd(18)}${pad("Deliv", 7)}${pad("Ours", 8)}${pad("Bosta", 8)}${pad("Diff", 9)}${pad("NextDay", 9)}${pad("OpenPkg", 9)}${pad("Total", 9)}${pad("Net", 9)}`);
for (const r of rows) {
  console.log(
    r.governorate.padEnd(18) +
      pad(r.orders, 7) +
      pad(r.ourRate?.toFixed(2) ?? "-", 8) +
      pad(r.bostaRate?.toFixed(2) ?? "-", 8) +
      pad(r.difference?.toFixed(2) ?? "-", 9) +
      pad(r.nextDayFee.toFixed(2), 9) +
      pad(r.openPackageFee.toFixed(2), 9) +
      pad(r.totalCost.toFixed(2), 9) +
      pad(r.netPerOrder?.toFixed(2) ?? "-", 9)
  );
}
