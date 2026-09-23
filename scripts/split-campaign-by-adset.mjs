// Migrate a campaign from campaign-level to AD-SET-level spend tracking.
//
// The ids come from src/lib/ad-split.ts (ADSET_LEVEL_CAMPAIGNS) - keep the two
// in step. This script only fixes up the history: it drops the campaign-level
// ad_spend rows (and any allocation pinned to the campaign as a whole), then
// rewinds the Meta sync cursor to the campaign's first day so the next sync
// passes rewrite that window one row per ad set.
//
// Usage: node scripts/split-campaign-by-adset.mjs 120247094619880578
// Then run the Meta sync until it reports reachedEnd.
import fs from "node:fs";
import pg from "pg";

const campaignIds = process.argv.slice(2);
if (campaignIds.length === 0) {
  console.error("Usage: node scripts/split-campaign-by-adset.mjs <campaign_id> [...]");
  process.exit(1);
}

const env = Object.fromEntries(
  fs
    .readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const schema = env.SUPABASE_SCHEMA || "public";
if (!env.DATABASE_URL) {
  console.error("Set DATABASE_URL in .env.local");
  process.exit(1);
}

const client = new pg.Client({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  const { rows: existing } = await client.query(
    `select min(date)::text as first_date, count(*)::int as days, sum(spend)::numeric(12,2) as spend
       from ${schema}.ad_spend where ad_id = any($1::text[])`,
    [campaignIds]
  );
  const { first_date: firstDate, days, spend } = existing[0];
  if (!firstDate) {
    console.log("No campaign-level rows found - nothing to migrate.");
    process.exit(0);
  }
  console.log(`Found ${days} campaign-level day(s) from ${firstDate}, ${spend} EGP total.`);

  const del = await client.query(`delete from ${schema}.ad_spend where ad_id = any($1::text[])`, [campaignIds]);
  console.log(`Deleted ${del.rowCount} ad_spend row(s).`);

  const delAssign = await client.query(
    `delete from ${schema}.ad_model_assignments where ad_id = any($1::text[])`,
    [campaignIds]
  );
  console.log(`Deleted ${delAssign.rowCount} campaign-level assignment(s).`);

  // Rewind only as far as the campaign's own history - re-walking those days
  // re-upserts every other campaign in place too, which is harmless.
  const rewind = await client.query(
    `update ${schema}.sync_state set cursor = $1, updated_at = now() where source = 'meta'`,
    [firstDate]
  );
  console.log(`Rewound Meta sync cursor to ${firstDate} (${rewind.rowCount} row).`);
  console.log("Now run the Meta sync until it reports reachedEnd.");
} finally {
  await client.end();
}
