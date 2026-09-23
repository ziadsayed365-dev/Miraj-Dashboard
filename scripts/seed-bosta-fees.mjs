// Loads Bosta per-governorate delivery fees from the owner's AL.xlsx into
// miraj.bosta_fee_matrix (+ governorate_fees.zone). Uses zone = governorate
// (identity) since the fees are per governorate, not per zone/size.
// deliver = the AL.xlsx fee; return_to_origin = deliver - 5.7 (Bosta's return
// fee, per owner); exchange/return_pickup/cash_collection stay 0.
// Run: node scripts/seed-bosta-fees.mjs
import ExcelJS from "exceljs";
import pg from "pg";

const FILE = "C:\\Users\\MSI\\OneDrive\\Desktop\\AL.xlsx";
const SIZE = "Small & Medium"; // settings.default_box_size_tier
const RETURN_DISCOUNT = 5.7; // return-to-origin fee = delivery fee - 5.7

// AL.xlsx spelling -> canonical governorate_fees name (see src/lib/governorates.ts).
const TO_CANON = {
  "cairo": "Cairo", "giza": "Giza", "6th of october": "Giza", "helwan": "Cairo",
  "alexandria": "Alexandria", "beheira": "Beheira", "dakahlia": "Dakahlia",
  "qalyubia": "Qalyubia", "al sharqia": "Sharqia", "gharbia": "Gharbia",
  "ismailia": "Ismailia", "damietta": "Damietta", "suez": "Suez",
  "port said": "Port Said", "monufia": "Monufia", "kafr el-sheikh": "Kafr El Sheikh",
  "asyut": "Asyut", "faiyum": "Faiyum", "sohag": "Sohag", "beni suef": "Beni Suef",
  "minya": "Minya", "red sea": "Red Sea", "qena": "Qena", "matrouh": "Matrouh",
  "aswan": "Aswan", "luxor": "Luxor", "south sinai": "South Sinai", "north sinai": "North Sinai",
  "new valley": "New Valley",
};

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(FILE);
const ws = wb.worksheets[0];
const canonicalFee = {};
const unmapped = [];
ws.eachRow((row) => {
  const name = (row.getCell(1).value ?? "").toString().trim();
  const fee = Number(row.getCell(2).value);
  if (!name || !Number.isFinite(fee)) return;
  const canon = TO_CANON[name.toLowerCase()];
  if (!canon) { unmapped.push(name); return; }
  // First occurrence wins (Cairo beats Helwan, Giza beats 6th of October).
  if (!(canon in canonicalFee)) canonicalFee[canon] = Math.round(fee * 100) / 100;
});

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  const govs = (await client.query("select governorate from miraj.governorate_fees")).rows.map((r) => r.governorate);
  let matrix = 0, zoned = 0;
  const missing = [];
  for (const gov of govs) {
    // zone = governorate (identity) so the fee lookup resolves per governorate.
    await client.query("update miraj.governorate_fees set zone = $1, updated_at = now() where governorate = $2", [gov, gov]);
    zoned++;
    const fee = canonicalFee[gov];
    if (fee === undefined) { missing.push(gov); continue; }
    const rto = Math.round((fee - RETURN_DISCOUNT) * 100) / 100;
    await client.query(
      // The matrix is effective-dated (0053); this script seeds the opening
      // period only. Later rate cards are added as their own dated rows.
      `insert into miraj.bosta_fee_matrix (zone, shipment_size, effective_from, deliver, exchange, return_pickup, cash_collection, return_to_origin, updated_at)
       values ($1,$2,date '2000-01-01',$3,0,0,0,$4,now())
       on conflict (zone, shipment_size, effective_from) do update set deliver = excluded.deliver, return_to_origin = excluded.return_to_origin, updated_at = now()`,
      [gov, SIZE, fee, rto]
    );
    matrix++;
  }
  console.log(`governorate_fees zoned: ${zoned}; bosta_fee_matrix rows (deliver): ${matrix}`);
  if (missing.length) console.log(`No fee provided for: ${missing.join(", ")}`);
  if (unmapped.length) console.log(`Unmapped AL.xlsx names (ignored): ${unmapped.join(", ")}`);
  console.log("Sample:", Object.entries(canonicalFee).slice(0, 6).map(([k, v]) => `${k}=${v}`).join(", "));
} finally {
  await client.end();
}
