// Check the live database actually matches what the code expects.
//
//   npm run db:verify
//
// Read-only. Run it after `npm run db:setup` (or after pasting
// supabase/miraj-full-setup.sql into the SQL editor) to confirm every
// migration landed - a half-applied schema otherwise shows up much later as a
// confusing runtime error like "column ad_spend.campaign_id does not exist".
import pg from "pg";
import fs from "node:fs";
import path from "node:path";

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

const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
const q = async (sql) => (await c.query(sql)).rows;

try {
  const tables = await q(`select table_name from information_schema.tables
    where table_schema='public' and table_type='BASE TABLE' order by table_name`);
  const fns = await q(`select routine_name from information_schema.routines
    where routine_schema='public' and routine_type='FUNCTION' order by routine_name`);
  const adSpend = await q(`select column_name from information_schema.columns
    where table_schema='public' and table_name='ad_spend' order by ordinal_position`);
  const assign = await q(`select column_name from information_schema.columns
    where table_schema='public' and table_name='ad_model_assignments' order by ordinal_position`);
  const cons = await q(`select conname from pg_constraint
    where conrelid='public.ad_spend'::regclass and contype in ('u','p') order by conname`);

  const t = tables.map((r) => r.table_name);
  const cols = adSpend.map((r) => r.column_name);
  const acols = assign.map((r) => r.column_name);
  const cnames = cons.map((r) => r.conname);

  console.log(`tables    (${t.length}): ${t.join(", ")}`);
  console.log(`functions (${fns.length}): ${fns.map((r) => r.routine_name).join(", ")}`);
  console.log(`\nad_spend columns: ${cols.join(", ")}`);
  console.log(`ad_model_assignments columns: ${acols.join(", ")}`);

  // Tables and columns the app reads or writes by name.
  const needTables = [
    "orders", "order_line_items", "products", "product_variants", "model_groups",
    "ad_spend", "ad_model_assignments", "bosta_events", "bosta_fee_matrix",
    "settings", "sync_state", "users", "chat_orders", "chat_order_items",
    "product_aliases", "purchases", "expense_accounts", "expense_entries",
  ];
  const checks = [
    ...needTables.map((n) => [`table ${n}`, t.includes(n)]),
    ["ad_spend.campaign_id", cols.includes("campaign_id")],
    ["ad_spend.campaign_name", cols.includes("campaign_name")],
    ["ad_spend.adset_id removed", !cols.includes("adset_id")],
    ["ad_spend.ad_id removed", !cols.includes("ad_id")],
    ["ad_spend.segment", cols.includes("segment")],
    ["ad_spend.ad_account_id", cols.includes("ad_account_id")],
    ["ad_spend.is_general", cols.includes("is_general")],
    ["assignments.campaign_id", acols.includes("campaign_id")],
    ["assignments.segment", acols.includes("segment")],
    ["unique (date, campaign_id)", cnames.includes("ad_spend_date_campaign_key")],
    ["rpc daily_pnl", fns.some((r) => r.routine_name === "daily_pnl")],
    ["rpc per_product_stats", fns.some((r) => r.routine_name === "per_product_stats")],
    ["rpc product_monthly_delivery", fns.some((r) => r.routine_name === "product_monthly_delivery")],
  ];

  console.log("\nchecks:");
  const failed = checks.filter(([, ok]) => !ok);
  for (const [label, ok] of checks) if (!ok) console.log(`  FAIL  ${label}`);
  console.log(
    failed.length === 0
      ? `  all ${checks.length} passed`
      : `\n${failed.length} of ${checks.length} FAILED - the schema is incomplete, re-run the setup.`
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
} finally {
  await c.end();
}
