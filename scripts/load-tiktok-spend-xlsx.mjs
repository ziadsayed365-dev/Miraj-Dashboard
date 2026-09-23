// Load a TikTok Ads "by day" spend export into ad_spend.
//
//   node scripts/load-tiktok-spend-xlsx.mjs "<file.xlsx>"           # dry run
//   node scripts/load-tiktok-spend-xlsx.mjs "<file.xlsx>" --apply   # write
//
// TikTok has no usable Marketing API for this account, so spend is normally
// typed into the daily popup. When a stretch of days was never entered, this
// loads them from the TikTok Ads UI export instead. It writes exactly the rows
// saveTikTokSpend() in src/lib/tiktok-spend.ts would write for a "General"
// entry, so a loaded day is indistinguishable from a hand-entered one.
//
// The export is account-level (one total per day, no campaign or product
// breakdown), so every row lands on model_group_id null = General.
//
// Idempotent: each day's existing tiktok rows are replaced, same as the popup.
// Days already recorded with a non-zero spend are skipped unless --overwrite,
// so re-running can never silently clobber a hand-entered number.
import ExcelJS from "exceljs";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const overwrite = args.includes("--overwrite");
// Also record the zero-spend days from the export, not just the days with
// spend. Off by default: an absent row already counts as zero everywhere in
// the reports, so months of "no spend" rows would be noise. Worth it only for
// recent days, which the popup keeps prompting for until a row exists.
const zerosFrom = (args.find((a) => a.startsWith("--zeros-from=")) ?? "").split("=")[1] || null;
const file = args.find((a) => !a.startsWith("--"));

if (!file) {
  console.error("Usage: node scripts/load-tiktok-spend-xlsx.mjs <file.xlsx> [--apply] [--overwrite] [--zeros-from=YYYY-MM-DD]");
  process.exit(1);
}

const envPath = path.join(import.meta.dirname, "..", ".env.local");
const env = Object.fromEntries(
  fs
    .readFileSync(envPath, "utf8")
    .split("\n")
    .map((l) => l.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim()])
);

const url = process.env.DATABASE_URL || env.DATABASE_URL;
if (!url) {
  console.error("No DATABASE_URL (env or .env.local).");
  process.exit(1);
}

// The export's date column comes through as text on some exports and as a real
// date on others, depending on the browser locale TikTok rendered it under.
function toIsoDate(v) {
  if (v == null) return null;
  if (v instanceof Date) {
    // Excel serial dates land as UTC midnight; reading UTC parts avoids the
    // local timezone pulling the day back by one.
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, "0")}-${String(v.getUTCDate()).padStart(2, "0")}`;
  }
  const s = String(typeof v === "object" ? (v.text ?? v.result ?? "") : v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function cellText(v) {
  if (v == null) return "";
  if (typeof v === "object") return String(v.text ?? v.result ?? "").trim();
  return String(v).trim();
}

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(file);
const ws = wb.worksheets[0];
if (!ws) {
  console.error("Workbook has no sheets.");
  process.exit(1);
}

// Find the columns by header rather than by position - TikTok reorders them
// depending on which metrics were picked in the report builder.
const header = ws.getRow(1);
let dateCol = 0;
let spendCol = 0;
let currencyCol = 0;
header.eachCell({ includeEmpty: false }, (cell, col) => {
  const h = cellText(cell.value).toLowerCase();
  if (!dateCol && (h === "by day" || h === "date" || h.includes("day"))) dateCol = col;
  else if (!spendCol && h.includes("spend")) spendCol = col;
  else if (!currencyCol && h.includes("currency")) currencyCol = col;
});

if (!dateCol || !spendCol) {
  console.error(`Could not find the date and spend columns. Header row was: ${header.values}`);
  process.exit(1);
}

const parsed = [];
const bad = [];
for (let r = 2; r <= ws.rowCount; r++) {
  const row = ws.getRow(r);
  const date = toIsoDate(row.getCell(dateCol).value);
  const raw = cellText(row.getCell(spendCol).value).replace(/,/g, "");
  const currency = currencyCol ? cellText(row.getCell(currencyCol).value) : "EGP";
  if (!date && !raw) continue;
  const spend = Number(raw);
  if (!date || !Number.isFinite(spend)) {
    bad.push(`row ${r}: date=${JSON.stringify(row.getCell(dateCol).value)} spend=${JSON.stringify(row.getCell(spendCol).value)}`);
    continue;
  }
  parsed.push({ date, spend, currency: currency || "EGP" });
}

if (bad.length) {
  console.error(`Refusing to load - ${bad.length} row(s) did not parse:`);
  for (const b of bad.slice(0, 20)) console.error(`  ${b}`);
  process.exit(1);
}

const currencies = [...new Set(parsed.map((p) => p.currency))];
if (currencies.length !== 1 || currencies[0] !== "EGP") {
  // ad_spend stores EGP; a non-EGP export would need converting first, and
  // silently loading it would understate or overstate the P&L.
  console.error(`Expected every row in EGP, found: ${currencies.join(", ")}`);
  process.exit(1);
}

// A day appearing twice would make the totals wrong in a way that is very hard
// to spot later, so treat it as fatal rather than summing.
const seen = new Set();
const dupes = parsed.filter((p) => (seen.has(p.date) ? true : (seen.add(p.date), false)));
if (dupes.length) {
  console.error(`Duplicate dates in the export: ${[...new Set(dupes.map((d) => d.date))].join(", ")}`);
  process.exit(1);
}

const candidates = parsed
  .filter((p) => p.spend > 0 || (zerosFrom && p.date >= zerosFrom))
  .sort((a, b) => a.date.localeCompare(b.date));

const lo = parsed.reduce((m, p) => (p.date < m ? p.date : m), parsed[0].date);
const hi = parsed.reduce((m, p) => (p.date > m ? p.date : m), parsed[0].date);
console.log(`export: ${parsed.length} rows, ${lo} .. ${hi}, total ${parsed.reduce((s, p) => s + p.spend, 0).toFixed(2)} EGP`);
console.log(`candidates to load: ${candidates.length} (${candidates.filter((c) => c.spend > 0).length} with spend, ${candidates.filter((c) => c.spend === 0).length} zero)`);

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  const dates = candidates.map((c) => c.date);
  const { rows: existing } = await client.query(
    `select date::text as date, campaign_id, spend from ad_spend where source='tiktok' and date = any($1::date[])`,
    [dates]
  );

  const existingByDate = new Map();
  for (const e of existing) {
    const cur = existingByDate.get(e.date) ?? 0;
    existingByDate.set(e.date, cur + Number(e.spend));
  }

  const skipped = [];
  const toLoad = [];
  for (const c of candidates) {
    const prior = existingByDate.get(c.date);
    if (prior !== undefined && prior > 0 && !overwrite) {
      skipped.push(`${c.date} (db has ${prior.toFixed(2)}, export has ${c.spend.toFixed(2)})`);
      continue;
    }
    toLoad.push({ ...c, replaces: prior });
  }

  if (skipped.length) {
    console.log(`\nskipping ${skipped.length} day(s) that already have non-zero spend (pass --overwrite to replace):`);
    for (const s of skipped) console.log(`  ${s}`);
  }

  console.log(`\nwill write ${toLoad.length} day(s):`);
  for (const t of toLoad) {
    const note = t.replaces === undefined ? "new" : `replaces ${t.replaces.toFixed(2)}`;
    console.log(`  ${t.date}  ${t.spend.toFixed(2)} EGP  (${note})`);
  }
  console.log(`  total ${toLoad.reduce((s, t) => s + t.spend, 0).toFixed(2)} EGP`);

  if (!apply) {
    console.log("\nDRY RUN - nothing written. Re-run with --apply to write.");
    process.exit(0);
  }

  // One transaction: a half-loaded range is worse than none, because the P&L
  // would look plausible while being wrong.
  await client.query("begin");
  for (const t of toLoad) {
    await client.query(`delete from ad_spend where source='tiktok' and date=$1::date`, [t.date]);
    // Mirrors saveTikTokSpend(): synthetic campaign id, General bucket, and an
    // explicit zero row for a day confirmed to have had no spend.
    const isZero = t.spend <= 0;
    await client.query(
      `insert into ad_spend (date, source, campaign_id, campaign_name, model_group_id, spend, currency, synced_at)
       values ($1::date, 'tiktok', $2, $3, null, $4, 'EGP', now())`,
      [
        t.date,
        isZero ? "tiktok:none" : "tiktok:general",
        isZero ? "TikTok (no spend)" : "TikTok - General",
        t.spend,
      ]
    );
  }
  await client.query("commit");

  const { rows: after } = await client.query(
    `select count(*)::int n, coalesce(sum(spend),0)::numeric total, min(date)::text lo, max(date)::text hi
     from ad_spend where source='tiktok'`
  );
  console.log(`\nwrote ${toLoad.length} day(s).`);
  console.log(`ad_spend tiktok now: ${after[0].n} rows, ${after[0].lo} .. ${after[0].hi}, total ${Number(after[0].total).toFixed(2)} EGP`);
} catch (err) {
  try { await client.query("rollback"); } catch { }
  throw err;
} finally {
  await client.end();
}
