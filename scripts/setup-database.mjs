// One-shot database setup for a FRESH Miraj Supabase project.
//
//   supabase/miraj-setup.sql   -> the base 18 tables + 4 RPCs
//   supabase/migrations/0034.. -> everything added after that base was frozen
//                                 (variants, BOM, chat orders, purchasing,
//                                  product aliases, self-delivered, RLS, ...)
//
// Migrations 0001..0033 are deliberately skipped: the base file already IS
// their end state, which is why it starts at 0034. Each file runs in its own
// transaction, in filename order, and the run stops at the first failure.
//
// Usage:
//   DATABASE_URL='postgresql://...' npm run db:setup
//   DATABASE_URL='postgresql://...' npm run db:setup -- --migrations-only
//
// WARNING: without --migrations-only this DROPS AND RECREATES the "public"
// schema, destroying every table in the target project. Point it only at
// Miraj's own database.
import pg from "pg";
import fs from "node:fs";
import path from "node:path";

const FIRST_MIGRATION = 34;
const root = path.join(import.meta.dirname, "..");

// An explicit DATABASE_URL wins (handy for pointing at a scratch database);
// otherwise fall back to .env.local, so the documented `npm run db:setup` works
// with no extra ceremony.
function urlFromEnvFile() {
  const file = path.join(root, ".env.local");
  if (!fs.existsSync(file)) return null;
  const line = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.match(/^\s*DATABASE_URL\s*=\s*(.*)$/))
    .find(Boolean);
  const value = line?.[1]?.trim();
  return value ? value : null;
}

const url = process.env.DATABASE_URL || urlFromEnvFile();
if (!url) {
  console.error("No DATABASE_URL - set it in .env.local (Supabase > Project Settings > Database > URI).");
  process.exit(1);
}

const migrationsOnly = process.argv.includes("--migrations-only");
const sqlDir = path.join(root, "supabase");

const migrations = fs
  .readdirSync(path.join(sqlDir, "migrations"))
  .filter((f) => f.endsWith(".sql") && Number(f.slice(0, 4)) >= FIRST_MIGRATION)
  .sort()
  .map((f) => path.join(sqlDir, "migrations", f));

const files = migrationsOnly ? migrations : [path.join(sqlDir, "miraj-setup.sql"), ...migrations];

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

let applied = 0;
try {
  for (const file of files) {
    const name = path.relative(root, file).replace(/\\/g, "/");
    const sql = fs.readFileSync(file, "utf8");
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("commit");
      applied++;
      console.log(`  ok   ${name}`);
    } catch (e) {
      await client.query("rollback").catch(() => {});
      console.error(`  FAIL ${name}\n       ${e.message}`);
      console.error(`\nStopped after ${applied} file(s). Fix the above, then re-run with`);
      console.error(`--migrations-only to resume without wiping what already applied.`);
      process.exitCode = 1;
      break;
    }
  }

  if (!process.exitCode) {
    // PostgREST caches the schema; without this the API 404s on new tables.
    await client.query("notify pgrst, 'reload schema'");
    console.log(`\n${applied} file(s) applied. Schema cache reloaded.`);
  }
} finally {
  await client.end();
}
