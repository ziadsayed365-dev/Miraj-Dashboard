// Reset a sync cursor so the next passes re-walk everything from the configured
// floor (SHOPIFY_ORDERS_SINCE / META_SPEND_SINCE) forward.
//
// Needed whenever the history window is widened: neither sync reaches back past
// its own cursor on its own. The Shopify upsert is keyed on
// shopify_line_item_id and Meta's on (account, campaign, date), so re-walking
// updates rows in place - no duplicates, no data loss.
//
// Usage: DATABASE_URL='postgresql://...' node scripts/reset-orders-sync.mjs [source ...]
//   default sources: shopify meta
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) { console.error("Set DATABASE_URL"); process.exit(1); }

// Miraj owns its Supabase project, so its tables live in "public". Kept as an
// env override for the sibling dashboards that share a project under a named
// schema.
const schema = process.env.SUPABASE_SCHEMA || "public";

const sources = process.argv.slice(2);
if (sources.length === 0) sources.push("shopify", "meta");

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  const { rowCount } = await client.query(
    `update ${schema}.sync_state set last_synced_at = null, cursor = null, updated_at = now() where source = any($1)`,
    [sources],
  );
  console.log(`Reset ${rowCount} sync_state row(s) in ${schema} for: ${sources.join(", ")}.`);
  console.log("Run the syncs repeatedly until each reports reachedEnd.");
} finally {
  await client.end();
}
