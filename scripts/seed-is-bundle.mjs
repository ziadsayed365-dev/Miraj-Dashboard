// Seeds products.is_bundle from the owner-marked product-list.xlsx
// (SKU column = "Single Product" | "Bundle"). Run AFTER the 0034 migration.
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";

const env = Object.fromEntries(
  fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")]; })
);
const SUPA_URL = env.SUPABASE_URL, SUPA_KEY = env.SUPABASE_SECRET_KEY, SCHEMA = env.SUPABASE_SCHEMA || "public";
const H = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "Accept-Profile": SCHEMA, "Content-Profile": SCHEMA, "Content-Type": "application/json" };

// Read the classification from the marked-up sheet.
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(path.join(process.cwd(), "product-list.xlsx"));
const ws = wb.getWorksheet("Products");
const kindByName = new Map();
ws.eachRow((row, n) => {
  if (n === 1) return;
  const name = (row.getCell(1).value ?? "").toString().trim();
  const type = (row.getCell(2).value ?? "").toString().trim();
  if (name) kindByName.set(name, type === "Bundle");
});

// Load DB products.
const res = await fetch(`${SUPA_URL}/rest/v1/products?select=id,name,is_bundle`, { headers: H });
if (!res.ok) throw new Error(`load products failed: ${res.status} ${await res.text()}`);
const products = await res.json();

let updated = 0, unmatched = [];
for (const p of products) {
  const name = (p.name ?? "").toString().trim();
  if (!kindByName.has(name)) { unmatched.push(name); continue; }
  const isBundle = kindByName.get(name);
  if (p.is_bundle === isBundle) continue;
  const u = await fetch(`${SUPA_URL}/rest/v1/products?id=eq.${p.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ is_bundle: isBundle }) });
  if (!u.ok) throw new Error(`update ${p.id} failed: ${u.status} ${await u.text()}`);
  updated++;
}

const bundles = products.filter((p) => kindByName.get((p.name ?? "").toString().trim()) === true).length;
console.log(`Products: ${products.length}. Set is_bundle on ${updated} rows. Bundles=${bundles}, Singles=${products.length - bundles - unmatched.length}.`);
if (unmatched.length) console.log(`Unmatched (not in sheet, left as-is): ${unmatched.length}`, unmatched.slice(0, 10));
