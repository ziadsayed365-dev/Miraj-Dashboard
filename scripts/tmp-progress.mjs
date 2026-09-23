// Read-only: how far the Bosta fee pull has got.
import pg from "pg";
import fs from "node:fs";

const env = Object.fromEntries(
  fs
    .readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .map((l) => l.match(/^\s*([A-Za-z_0-9]+)\s*=\s*(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim()])
);
const c = new pg.Client({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
console.table(
  (
    await c.query(`
      select count(*) as trackable,
             count(*) filter (where bosta_fees_synced_at is not null) as synced,
             count(*) filter (where bosta_actual_fee is not null) as with_fee
      from orders where cancelled_at is null and bosta_tracking_number is not null
    `)
  ).rows
);
console.table(
  (
    await c.query(`
      select to_char(egypt_day,'YYYY-MM') as month,
             count(*) filter (where bosta_actual_fee is not null) as with_fee,
             round(avg(bosta_actual_fee), 2) as avg_fee,
             round(avg(bosta_actual_open_package_fee), 2) as avg_openpkg,
             round(avg(bosta_actual_cod_fee), 2) as avg_cod
      from orders where cancelled_at is null and bosta_actual_fee is not null
      group by 1 order by 1
    `)
  ).rows
);
await c.end();
