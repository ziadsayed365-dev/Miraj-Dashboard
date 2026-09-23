// One-off: export the Miraj product catalog to an .xlsx sheet.
// Reads the same data the /product-list page uses (products + model_groups).
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";

// Load Supabase creds from .env.local (SUPABASE_URL / SUPABASE_SECRET_KEY / SUPABASE_SCHEMA).
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

async function fetchAll(table, select) {
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}`, {
      headers: {
        apikey: SUPA_KEY,
        Authorization: `Bearer ${SUPA_KEY}`,
        "Accept-Profile": SCHEMA,
        Range: `${from}-${from + pageSize - 1}`,
        Prefer: "count=exact",
      },
    });
    if (!res.ok) throw new Error(`${table} fetch failed: ${res.status} ${await res.text()}`);
    const batch = await res.json();
    rows.push(...batch);
    if (batch.length < pageSize) break;
  }
  return rows;
}

const modelGroups = await fetchAll("model_groups", "id, name, unit_cost");
const groupById = new Map(modelGroups.map((m) => [m.id, m]));
const products = await fetchAll("products", "id, name, sku, current_price, model_group_id, status");

const rows = products
  .map((p) => {
    const g = p.model_group_id ? groupById.get(p.model_group_id) : null;
    return {
      name: p.name,
      sku: p.sku,
      modelGroupName: g?.name ?? null,
      currentPrice: p.current_price,
      unitCost: g?.unit_cost ?? null,
      status: p.status !== "ARCHIVED" && p.status !== "DRAFT" ? "Active" : (p.status === "ARCHIVED" ? "Archived" : "Draft"),
    };
  })
  .sort((a, b) => {
    if (a.modelGroupName === null && b.modelGroupName !== null) return 1;
    if (a.modelGroupName !== null && b.modelGroupName === null) return -1;
    if (a.modelGroupName !== b.modelGroupName) return (a.modelGroupName ?? "").localeCompare(b.modelGroupName ?? "");
    return (a.name ?? "").localeCompare(b.name ?? "");
  });

const wb = new ExcelJS.Workbook();
wb.creator = "Miraj Dashboard";
wb.created = new Date();
const ws = wb.addWorksheet("Products", { views: [{ state: "frozen", ySplit: 1 }] });

ws.columns = [
  { header: "Product", key: "name", width: 42 },
  { header: "SKU", key: "sku", width: 18 },
  { header: "Model Group", key: "modelGroupName", width: 28 },
  { header: "Current Price (EGP)", key: "currentPrice", width: 18 },
  { header: "Unit Cost (EGP)", key: "unitCost", width: 16 },
  { header: "Gross Margin (EGP)", key: "margin", width: 18 },
  { header: "Status", key: "status", width: 12 },
];

ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
ws.getRow(1).alignment = { vertical: "middle" };

for (const r of rows) {
  const margin =
    r.currentPrice != null && r.unitCost != null ? Number(r.currentPrice) - Number(r.unitCost) : null;
  const row = ws.addRow({ ...r, margin });
  ["currentPrice", "unitCost", "margin"].forEach((k) => {
    row.getCell(k).numFmt = "#,##0.00";
  });
}

ws.autoFilter = { from: "A1", to: `G${rows.length + 1}` };

const outPath = path.join(process.cwd(), "product-list.xlsx");
await wb.xlsx.writeFile(outPath);
console.log(`Wrote ${rows.length} products (${modelGroups.length} model groups) -> ${outPath}`);
