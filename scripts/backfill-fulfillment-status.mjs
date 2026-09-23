// Fills orders.shopify_fulfillment_status for orders that have no final courier
// outcome yet. The normal Shopify sync is incremental (it only revisits orders
// whose updatedAt moved), so an order that has sat unresolved since February
// would never get the new column filled by itself.
//
// Usage: node scripts/backfill-fulfillment-status.mjs [--all]
//   default : only unresolved, not-cancelled orders (what the tab reads)
//   --all   : every non-cancelled order
//
// Reads .env.local from the project root. Safe to re-run.

import fs from "node:fs";
import pg from "pg";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);

const SCHEMA = env.SUPABASE_SCHEMA;
const ALL = process.argv.includes("--all");
const RESOLVED = "'delivered','failed_rto','exchange','pickup_return'";

const shop = env.SHOPIFY_SHOP_DOMAIN;
const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.SHOPIFY_CLIENT_ID,
    client_secret: env.SHOPIFY_CLIENT_SECRET,
  }),
});
const token = (await tokenRes.json()).access_token;
if (!token) throw new Error("Shopify token exchange failed");

async function gql(query, variables) {
  const r = await fetch(`https://${shop}/admin/api/2026-04/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  const b = await r.json();
  if (b.errors) throw new Error(JSON.stringify(b.errors));
  return b.data;
}

const QUERY = `query($q: String!) {
  orders(first: 10, query: $q) {
    edges { node { name fulfillments(first: 5) { displayStatus } } }
  }
}`;

const client = new pg.Client({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();

const { rows } = await client.query(`
  select id, order_number from ${SCHEMA}.orders
  where cancelled_at is null
    ${ALL ? "" : `and coalesce(outcome,'') not in (${RESOLVED})`}
  order by egypt_day`);
console.log(`${rows.length} order(s) to check`);

let filled = 0;
let cleared = 0;
for (const r of rows) {
  const data = await gql(QUERY, { q: `name:${r.order_number}` });
  const node = data.orders.edges.map((e) => e.node).find((n) => n.name === r.order_number);
  if (!node) {
    console.log(`  not found in Shopify: ${r.order_number}`);
    continue;
  }
  const status =
    [...new Set((node.fulfillments ?? []).map((f) => f.displayStatus).filter(Boolean))].join(",") || null;
  await client.query(`update ${SCHEMA}.orders set shopify_fulfillment_status = $1 where id = $2`, [status, r.id]);
  if (status) filled++;
  else cleared++;
}

console.log(`done - ${filled} with a fulfilment status, ${cleared} never fulfilled`);
console.table(
  (await client.query(`
    select coalesce(shopify_fulfillment_status,'(never fulfilled)') as status, count(*)::int as orders
    from ${SCHEMA}.orders
    where cancelled_at is null and coalesce(outcome,'') not in (${RESOLVED})
    group by 1 order by 2 desc`)).rows
);
await client.end();
