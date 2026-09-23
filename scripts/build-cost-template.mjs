// Builds the 3-tab product cost template from the marked-up product-list.xlsx.
// Tab 1 "Costs":   single base costs + packaging price list (blank for user).
// Tab 2 "Assembly": singles (base + packaging -> total), then bundle mapping.
// Tab 3 "Summary":  final cost of each single, then each bundle (live formulas).
import ExcelJS from "exceljs";
import path from "node:path";

const SRC = "D:\\Clients\\Other\\Finvisor\\Miraj\\product-list.xlsx";
const OUT = path.join(process.cwd(), "product-costs.xlsx");

// ---- read the marked-up source ----
const srcWb = new ExcelJS.Workbook();
await srcWb.xlsx.readFile(SRC);
const srcWs = srcWb.getWorksheet("Products");
const singles = [];
const bundlesRaw = [];
srcWs.eachRow((row, n) => {
  if (n === 1) return;
  const name = (row.getCell(1).value ?? "").toString().trim();
  const type = (row.getCell(2).value ?? "").toString().trim();
  const mg = (row.getCell(3).value ?? "").toString().trim();
  if (!name) return;
  if (type === "Single Product") singles.push({ name, mg });
  else if (type === "Bundle") bundlesRaw.push({ name, mg });
});
// dedupe bundles by name (3 repeat), keep first
const seen = new Set();
const bundles = [];
for (const b of bundlesRaw) {
  if (seen.has(b.name)) continue;
  seen.add(b.name);
  bundles.push(b);
}

const S = singles.length; // 34
const B = bundles.length; // 50
const PKG_ROWS = 25; // blank packaging slots
const MAP_ROWS = 200; // blank bundle-component mapping rows

// ---- styling helpers ----
const HEAD_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
const SUB_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF374151" } };
const INPUT_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEF9C3" } }; // pale yellow = you fill this
const CALC_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFECFDF5" } }; // pale green = auto
const MONEY = "#,##0.00";
const thin = { style: "thin", color: { argb: "FFD1D5DB" } };
const border = { top: thin, left: thin, bottom: thin, right: thin };
function headRow(ws, r, fill = HEAD_FILL) {
  const row = ws.getRow(r);
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.eachCell((c) => { c.fill = fill; c.border = border; c.alignment = { vertical: "middle" }; });
  return row;
}

const wb = new ExcelJS.Workbook();
wb.creator = "Miraj Dashboard";
wb.created = new Date();

// Named ranges for the two CROSS-SHEET dropdowns (direct cross-sheet list
// validation is unreliable in older Excel / LibreOffice; a name always works).
wb.definedNames.add(`Costs!$G$2:$G$${1 + 25}`, "PkgList");
wb.definedNames.add(`Summary!$A$40:$A$${39 + bundles.length}`, "BundleList");

// ============================================================= TAB 1: Costs
const costs = wb.addWorksheet("Costs", { views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }] });
costs.columns = [
  { key: "id", width: 8 }, { key: "name", width: 48 }, { key: "mg", width: 20 }, { key: "base", width: 16 },
  { key: "gap", width: 3 },
  { key: "pid", width: 8 }, { key: "ptype", width: 28 }, { key: "pcost", width: 16 },
];
costs.getCell("A1").value = "ID";
costs.getCell("B1").value = "Single Product";
costs.getCell("C1").value = "Model Group";
costs.getCell("D1").value = "Base Cost (EGP)";
costs.getCell("F1").value = "Pkg ID";
costs.getCell("G1").value = "Packaging Type";
costs.getCell("H1").value = "Unit Cost (EGP)";
headRow(costs, 1);
singles.forEach((s, i) => {
  const r = 2 + i;
  costs.getCell(`A${r}`).value = `S${String(i + 1).padStart(2, "0")}`;
  costs.getCell(`B${r}`).value = s.name;
  costs.getCell(`C${r}`).value = s.mg || null;
  const base = costs.getCell(`D${r}`);
  base.numFmt = MONEY; base.fill = INPUT_FILL; base.border = border;
});
for (let i = 0; i < PKG_ROWS; i++) {
  const r = 2 + i;
  costs.getCell(`F${r}`).value = `P${String(i + 1).padStart(2, "0")}`;
  const ptype = costs.getCell(`G${r}`); ptype.fill = INPUT_FILL; ptype.border = border;
  const pcost = costs.getCell(`H${r}`); pcost.numFmt = MONEY; pcost.fill = INPUT_FILL; pcost.border = border;
}
costs.getCell("J1").value = "Fill the yellow cells: each single product's base cost (before packaging), and your packaging types with their unit cost.";
costs.getCell("J1").font = { italic: true, color: { argb: "FF6B7280" } };

// ranges used elsewhere
const PKG_LAST = 1 + PKG_ROWS; // 26
const S_LAST = 1 + S; // 35

// ============================================================= TAB 2: Assembly
const asm = wb.addWorksheet("Assembly", { views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }] });
asm.columns = [
  { width: 48 }, { width: 15 }, { width: 20 }, { width: 12 }, { width: 20 }, { width: 12 }, { width: 20 }, { width: 12 }, { width: 16 },
];
const asmHeaders = ["Single Product", "Base Cost", "Packaging 1", "Cost 1", "Packaging 2", "Cost 2", "Packaging 3", "Cost 3", "Single Total Cost"];
asmHeaders.forEach((h, i) => (asm.getCell(1, i + 1).value = h));
headRow(asm, 1);
singles.forEach((s, i) => {
  const r = 2 + i;
  asm.getCell(`A${r}`).value = s.name;
  const b = asm.getCell(`B${r}`); b.value = { formula: `IFERROR(VLOOKUP(A${r},Costs!$B:$D,3,FALSE),0)` }; b.numFmt = MONEY; b.fill = CALC_FILL;
  for (const [typeCol, costCol] of [["C", "D"], ["E", "F"], ["G", "H"]]) {
    asm.getCell(`${typeCol}${r}`).fill = INPUT_FILL;
    const cc = asm.getCell(`${costCol}${r}`);
    cc.value = { formula: `IFERROR(VLOOKUP(${typeCol}${r},Costs!$G$2:$H$${PKG_LAST},2,FALSE),0)` };
    cc.numFmt = MONEY; cc.fill = CALC_FILL;
  }
  const tot = asm.getCell(`I${r}`); tot.value = { formula: `B${r}+D${r}+F${r}+H${r}` }; tot.numFmt = MONEY;
  tot.font = { bold: true }; tot.fill = CALC_FILL;
});
// packaging dropdowns on the 3 type columns
for (let r = 2; r <= S_LAST; r++) {
  for (const col of ["C", "E", "G"]) {
    asm.getCell(`${col}${r}`).dataValidation = {
      type: "list", allowBlank: true, formulae: ["PkgList"],
    };
  }
}

// --- bundle mapping section ---
const MAP_TITLE = S_LAST + 2;      // e.g. 37
const MAP_HEAD = MAP_TITLE + 1;    // 38
const MAP_FIRST = MAP_HEAD + 1;    // 39
const MAP_LAST = MAP_HEAD + MAP_ROWS; // 238
asm.mergeCells(`A${MAP_TITLE}:E${MAP_TITLE}`);
asm.getCell(`A${MAP_TITLE}`).value = "BUNDLES — one row per component single product (pick the bundle, pick the component, set the qty)";
asm.getCell(`A${MAP_TITLE}`).font = { bold: true, color: { argb: "FFFFFFFF" } };
asm.getCell(`A${MAP_TITLE}`).fill = SUB_FILL;
["Bundle", "Component (Single Product)", "Qty", "Unit Cost", "Line Cost"].forEach((h, i) => (asm.getCell(MAP_HEAD, i + 1).value = h));
headRow(asm, MAP_HEAD);
for (let r = MAP_FIRST; r <= MAP_LAST; r++) {
  asm.getCell(`A${r}`).fill = INPUT_FILL;
  asm.getCell(`B${r}`).fill = INPUT_FILL;
  const q = asm.getCell(`C${r}`); q.fill = INPUT_FILL;
  const uc = asm.getCell(`D${r}`); uc.value = { formula: `IF($B${r}="","",IFERROR(VLOOKUP($B${r},$A$2:$I$${S_LAST},9,FALSE),0))` }; uc.numFmt = MONEY; uc.fill = CALC_FILL;
  const lc = asm.getCell(`E${r}`); lc.value = { formula: `IF($C${r}="","",$C${r}*$D${r})` }; lc.numFmt = MONEY; lc.fill = CALC_FILL;
  asm.getCell(`A${r}`).dataValidation = { type: "list", allowBlank: true, formulae: ["BundleList"] };
  asm.getCell(`B${r}`).dataValidation = { type: "list", allowBlank: true, formulae: [`$A$2:$A$${S_LAST}`] };
  asm.getCell(`C${r}`).dataValidation = { type: "whole", operator: "greaterThan", allowBlank: true, formulae: ["0"] };
}

// ============================================================= TAB 3: Summary
const sum = wb.addWorksheet("Summary", { views: [{ rightToLeft: true, state: "frozen", ySplit: 2 }] });
sum.columns = [{ width: 48 }, { width: 20 }, { width: 16 }];
sum.mergeCells("A1:C1");
sum.getCell("A1").value = "SINGLE PRODUCTS";
sum.getCell("A1").font = { bold: true, color: { argb: "FFFFFFFF" } };
sum.getCell("A1").fill = SUB_FILL;
["Single Product", "Model Group", "Total Cost (EGP)"].forEach((h, i) => (sum.getCell(2, i + 1).value = h));
headRow(sum, 2);
singles.forEach((s, i) => {
  const r = 3 + i;
  sum.getCell(`A${r}`).value = s.name;
  sum.getCell(`B${r}`).value = s.mg || null;
  const c = sum.getCell(`C${r}`); c.value = { formula: `IFERROR(VLOOKUP(A${r},Assembly!$A$2:$I$${S_LAST},9,FALSE),0)` }; c.numFmt = MONEY; c.font = { bold: true };
});
const B_TITLE = 3 + S + 1;   // gap then title
const B_HEAD = B_TITLE + 1;
const B_FIRST = B_HEAD + 1;  // must equal 40 for the Assembly bundle dropdown range
sum.mergeCells(`A${B_TITLE}:C${B_TITLE}`);
sum.getCell(`A${B_TITLE}`).value = "BUNDLES";
sum.getCell(`A${B_TITLE}`).font = { bold: true, color: { argb: "FFFFFFFF" } };
sum.getCell(`A${B_TITLE}`).fill = SUB_FILL;
["Bundle", "Total Cost (EGP)"].forEach((h, i) => (sum.getCell(B_HEAD, i + 1).value = h));
headRow(sum, B_HEAD);
bundles.forEach((b, i) => {
  const r = B_FIRST + i;
  sum.getCell(`A${r}`).value = b.name;
  const c = sum.getCell(`B${r}`); c.value = { formula: `SUMIFS(Assembly!$E$${MAP_FIRST}:$E$${MAP_LAST},Assembly!$A$${MAP_FIRST}:$A$${MAP_LAST},A${r})` }; c.numFmt = MONEY; c.font = { bold: true };
});

// sanity: the Assembly bundle dropdown assumed bundles start at Summary row 40
if (B_FIRST !== 40) console.warn(`WARNING: bundle first row is ${B_FIRST}, not 40 — fix the Assembly dropdown range.`);

await wb.xlsx.writeFile(OUT);
console.log(`Wrote ${OUT}`);
console.log(`  singles=${S}, bundles=${B} (unique), packaging slots=${PKG_ROWS}, bundle map rows=${MAP_ROWS}`);
console.log(`  bundle rows on Summary: ${B_FIRST}..${B_FIRST + B - 1}`);
