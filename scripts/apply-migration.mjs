// Apply a migration file over a direct Postgres connection, in one transaction,
// then reload the PostgREST schema cache.
// Usage: DATABASE_URL='postgresql://...' node scripts/apply-migration.mjs supabase/migrations/0034_product_cost_structure.sql
import pg from "pg";
import fs from "node:fs";

const url = process.env.DATABASE_URL;
const file = process.argv[2];
if (!url) { console.error("Set DATABASE_URL"); process.exit(1); }
if (!file) { console.error("Pass a migration file path"); process.exit(1); }

const sql = fs.readFileSync(file, "utf8");
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

await client.connect();
try {
  await client.query("begin");
  await client.query(sql);
  await client.query("commit");
  console.log(`${file} applied.`);
} catch (e) {
  await client.query("rollback").catch(() => {});
  console.error("Failed, rolled back:", e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
