// Drive a full historical backfill against a RUNNING app.
//
//   npm run dev                     # in one terminal
//   node scripts/backfill.mjs       # in another
//   node scripts/backfill.mjs --base http://localhost:3002
//
// Runs the same pipeline as the nightly cron, in the same order, but hits each
// step's own endpoint so a long backfill isn't fighting one function's timeout:
//
//   shopify -> shopify-products -> meta -> calibrate
//           -> monthly-rate -> sku-monthly-rate -> margins
//
// Orders and Meta spend are resumable: each pass checkpoints a cursor and self-
// caps at ~40s, so they are looped until they report reachedEnd. Every endpoint
// authenticates with CRON_SECRET, so no login is needed.
//
// NOTE: no "bosta" step, matching src/app/api/sync/run/route.ts. See the README.
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, ".env.local"), "utf8").split("\n")
    .map((l) => l.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)$/)).filter(Boolean)
    .map((m) => [m[1], m[2].trim()])
);

const secret = process.env.CRON_SECRET || env.CRON_SECRET;
if (!secret) { console.error("No CRON_SECRET."); process.exit(1); }

const baseArg = process.argv.indexOf("--base");
const BASE = baseArg !== -1 ? process.argv[baseArg + 1] : "http://localhost:3000";

const started = Date.now();
const elapsed = () => `${String(Math.round((Date.now() - started) / 1000)).padStart(5)}s`;

// A pass self-caps at ~40s, so anything past this is a dead connection rather
// than slow work. Without it, fetch waits indefinitely: a laptop sleeping
// mid-backfill once hung a single request for two hours before failing.
const REQUEST_TIMEOUT_MS = 180_000;
const NETWORK_RETRIES = 5;

async function callOnce(pathname) {
  const res = await fetch(`${BASE}${pathname}`, {
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`${pathname} -> HTTP ${res.status}: ${text.slice(0, 200)}`); }
  if (!res.ok || body.ok === false) throw new Error(`${pathname} -> ${body.error ?? `HTTP ${res.status}`}`);
  return body;
}

// Retry only TRANSPORT failures (dropped Wi-Fi, sleep, a cold function timing
// out). An error the app itself reported is a real problem and still aborts the
// run - retrying it would just hammer a broken endpoint. Every pass has already
// checkpointed its cursor, so a retry resumes rather than repeating work.
async function call(pathname) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await callOnce(pathname);
    } catch (e) {
      const transport = e.name === "TimeoutError" || e.name === "AbortError" || e.cause !== undefined;
      if (!transport || attempt > NETWORK_RETRIES) throw e;
      const wait = Math.min(60, 2 ** attempt) * 1000;
      console.log(`${elapsed()}  network error on ${pathname.trim()} (${e.message}) - retry ${attempt}/${NETWORK_RETRIES} in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// A resumable step: keep calling until it says it reached the end.
async function loopUntilEnd(label, pathname, maxPasses) {
  let total = 0;
  for (let i = 1; i <= maxPasses; i++) {
    const r = await call(pathname);
    const n = r.rowsUpserted ?? r.ordersUpserted ?? r.processed ?? 0;
    total += n;
    console.log(`${elapsed()}  ${label} pass ${String(i).padStart(3)}  ${JSON.stringify(r)}`);
    if (r.reachedEnd) { console.log(`${elapsed()}  ${label} COMPLETE after ${i} pass(es), ~${total} rows\n`); return; }
  }
  console.log(`${elapsed()}  ${label} stopped at the ${maxPasses}-pass cap - re-run to continue\n`);
}

async function once(label, pathname) {
  const r = await call(pathname);
  console.log(`${elapsed()}  ${label}  ${JSON.stringify(r)}`);
}

console.log(`backfill against ${BASE}\n`);
try {
  await loopUntilEnd("shopify        ", "/api/sync/shopify", 200);
  await once("shopify-products", "/api/sync/shopify-products");
  await loopUntilEnd("meta           ", "/api/sync/meta", 60);
  await once("calibrate       ", "/api/engine/calibrate");
  await once("monthly-rate    ", "/api/engine/finalize-monthly-rate");
  await once("sku-monthly-rate", "/api/engine/finalize-sku-monthly-rate");
  await once("margins         ", "/api/engine/compute-margins");
  console.log(`\n${elapsed()}  BACKFILL DONE`);
} catch (e) {
  console.error(`\n${elapsed()}  FAILED: ${e.message}`);
  console.error("Steps checkpoint their cursor, so re-running resumes rather than starting over.");
  process.exitCode = 1;
}
