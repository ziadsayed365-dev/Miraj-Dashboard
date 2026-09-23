// Where the backfill has got to. Read-only.
//
//   npm run sync:status
//
// Safe to run at any time, including while a sync is in flight.
import pg from "pg";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, ".env.local"), "utf8").split("\n")
    .map((l) => l.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)$/)).filter(Boolean)
    .map((m) => [m[1], m[2].trim()])
);

const c = new pg.Client({
  connectionString: process.env.DATABASE_URL || env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await c.connect();
const q = async (s) => (await c.query(s)).rows;

try {
  const [o] = await q(`select count(*) n, min(egypt_day)::text d0, max(egypt_day)::text d1,
    count(*) filter (where outcome is not null) with_outcome,
    count(*) filter (where cancelled_at is not null) cancelled from orders`);
  // Unmapped line items are the integrity metric that matters during a
  // backfill: a line item with no product_id contributes revenue but shows up
  // against no product, so Analysis by Product silently under-reports.
  // shopify-products backfills these when it first inserts a product, so a
  // non-zero count here means the catalog sync has not caught up yet.
  const [li] = await q(`select count(*) n,
    count(*) filter (where product_id is null) unmapped,
    count(*) filter (where product_id is null and shopify_product_id is null) unmappable
    from order_line_items`);
  const [p] = await q(`select count(*) n from products`);
  const [v] = await q(`select count(*) n from product_variants`);
  const [m] = await q(`select count(*) n from order_line_items where margin_computed_at is not null`);

  console.log(`orders        ${o.n}   ${o.d0 ?? "-"} .. ${o.d1 ?? "-"}`);
  console.log(`  cancelled   ${o.cancelled}`);
  console.log(`  w/ outcome  ${o.with_outcome}`);
  console.log(`line items    ${li.n}`);
  console.log(`  unmapped    ${li.unmapped}${Number(li.unmapped) ? "  <- run shopify-products" : ""}`);
  console.log(`  no shopify id ${li.unmappable}${Number(li.unmappable) ? "  <- cannot be mapped automatically" : ""}`);
  console.log(`  margins done ${m.n}`);
  console.log(`products      ${p.n}  (variants ${v.n})`);

  const ad = await q(`select segment, count(*) rows, count(distinct campaign_id) campaigns,
    round(sum(spend))::text total, min(date)::text d0, max(date)::text d1
    from ad_spend group by segment order by segment`);
  console.log(`\nad_spend`);
  if (!ad.length) console.log("  (none)");
  for (const r of ad) {
    console.log(`  ${r.segment.padEnd(10)} ${String(r.rows).padStart(5)} rows  ${String(r.campaigns).padStart(3)} campaigns  ${String(r.total).padStart(9)} EGP  ${r.d0}..${r.d1}`);
  }

  console.log(`\nsync_state`);
  for (const r of await q(`select source, last_synced_at, cursor from sync_state order by source`)) {
    const cur = r.cursor ? (r.cursor.length > 44 ? r.cursor.slice(0, 44) + "…" : r.cursor) : "-";
    console.log(`  ${r.source.padEnd(9)} last=${r.last_synced_at ? String(r.last_synced_at).slice(0, 19) : "never"}  cursor=${cur}`);
  }
} finally {
  await c.end();
}
