// Pull what Bosta ACTUALLY charged per shipment into orders.bosta_actual_*.
//
//   node scripts/pull-bosta-fees.mjs [--all] [--concurrency 8] [--limit N]
//
// Two calls per order is unavoidable: /deliveries/search returns the delivery's
// _id but NOT its wallet block, and only /deliveries/{_id} carries
// wallet.cashCycle. The search half is batched 50 tracking numbers at a time,
// so the cost is ~1 call per order plus 2%.
//
// Resumable: by default it only fetches orders whose bosta_fees_synced_at is
// null, so an interrupted run picks up where it stopped. --all re-fetches
// everything (use after a Bosta billing correction).
//
// Read-only against Bosta; the only writes are to the six bosta_actual_*
// columns on orders.
import pg from "pg";
import fs from "node:fs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const refetchAll = args.includes("--all");
const CONCURRENCY = Number(flag("concurrency", 8));
const LIMIT = Number(flag("limit", 0));
const SEARCH_BATCH = 50;
const VAT = 1.14;

const env = Object.fromEntries(
  fs
    .readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .map((l) => l.match(/^\s*([A-Za-z_0-9]+)\s*=\s*(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim()])
);
const apiKey = env.BOSTA_API_KEY;
if (!apiKey) throw new Error("BOSTA_API_KEY missing from .env.local");

const client = new pg.Client({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();

const { rows: orders } = await client.query(`
  select id, order_number, bosta_tracking_number as tn
  from orders
  where cancelled_at is null
    and bosta_tracking_number is not null
    ${refetchAll ? "" : "and bosta_fees_synced_at is null"}
  order by egypt_day
  ${LIMIT ? "limit " + LIMIT : ""}
`);
console.log(`${orders.length} orders to fetch (concurrency ${CONCURRENCY})`);
if (orders.length === 0) {
  await client.end();
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bosta's /deliveries/{id} endpoint allows roughly ONE request per second and
// nothing more. Measured, not guessed: 300 sequential calls at 900ms passed
// clean, while 4 workers at 250ms hit 429 on every single request - and a 429
// is not just a skipped call, it carries an 80s+ retry-after that the naive
// retry loop then burned through, which is how an earlier run managed 37
// orders in nine minutes.
//
// So: strictly sequential, and the gap ADAPTS. Every 429 widens it and waits
// out the server's own retry-after; a long clean streak narrows it again. That
// finds the fastest safe rate on its own instead of trusting a hardcoded one.
const MIN_GAP = 500;
const MAX_GAP = 3000;
let gap = Number(flag("gap", 800));
let streak = 0;
let throttles = 0;

async function call(url, init, attempt = 0) {
  await sleep(gap);
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (attempt >= 4) throw err;
    await sleep(2000 * (attempt + 1));
    return call(url, init, attempt + 1);
  }
  if (res.status === 429) {
    throttles++;
    streak = 0;
    gap = Math.min(MAX_GAP, gap + 150);
    // Honour the server's own number rather than inventing a backoff - it
    // tells us exactly how long the window stays shut.
    const retry = Number(res.headers.get("retry-after") ?? 60);
    console.log(`  429 - waiting ${retry}s, gap now ${gap}ms`);
    await sleep((retry + 2) * 1000);
    if (attempt >= 6) throw new Error("HTTP 429 (gave up)");
    return call(url, init, attempt + 1);
  }
  if (res.status >= 500) {
    if (attempt >= 4) throw new Error("HTTP " + res.status);
    await sleep(2000 * (attempt + 1));
    return call(url, init, attempt + 1);
  }
  if (++streak >= 250 && gap > MIN_GAP) {
    gap = Math.max(MIN_GAP, gap - 50);
    streak = 0;
  }
  return await res.json();
}

// tracking number -> delivery _id, 50 at a time.
async function resolveIds(batch) {
  const body = await call("https://app.bosta.co/api/v0/deliveries/search", {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ pageNumber: 1, pageLimit: SEARCH_BATCH, trackingNumbers: batch.map((o) => o.tn) }),
  });
  const byTn = new Map((body.deliveries ?? []).map((d) => [String(d.trackingNumber), d._id]));
  return batch.map((o) => ({ ...o, deliveryId: byTn.get(String(o.tn)) ?? null }));
}

const num = (v) => (v === undefined || v === null || v === "" ? 0 : Number(v));

let done = 0;
let withFee = 0;
let noDelivery = 0;
let noWallet = 0;
const started = Date.now();

async function fetchOne(o) {
  if (!o.deliveryId) {
    noDelivery++;
    return null;
  }
  const full = await call("https://app.bosta.co/api/v0/deliveries/" + o.deliveryId, {
    headers: { Authorization: apiKey },
  });
  const cc = full?.wallet?.cashCycle;
  if (!cc) {
    noWallet++;
    // Still stamp it so a resumed run doesn't retry forever.
    return { id: o.id, cc: null };
  }
  withFee++;
  return { id: o.id, cc };
}

async function flush(updates) {
  if (updates.length === 0) return;
  // One statement per flush: unnest the arrays and join, rather than N updates.
  const ids = [];
  const total = [];
  const shipping = [];
  const openPkg = [];
  const cod = [];
  const other = [];
  const raw = [];
  for (const u of updates) {
    const cc = u.cc;
    ids.push(u.id);
    if (!cc) {
      total.push(null); shipping.push(null); openPkg.push(null); cod.push(null); other.push(null); raw.push(null);
      continue;
    }
    const feeTotal = num(cc.bosta_fees); // VAT-inclusive
    const ship = num(cc.shipping_fees);
    const pkg = num(cc.opening_package_fees);
    const codFee = num(cc.cod_fees);
    // Whatever else Bosta billed, derived so the parts always reconcile to the
    // VAT-inclusive total rather than being enumerated field by field (Bosta
    // adds new fee lines over time - fulfillment, flex, escrow, insurance...).
    const rest = feeTotal / VAT - ship - pkg - codFee;
    total.push(feeTotal);
    shipping.push(ship);
    openPkg.push(pkg);
    cod.push(codFee);
    other.push(Number(rest.toFixed(2)));
    raw.push(JSON.stringify(cc));
  }
  await client.query(
    `update orders o set
       bosta_actual_fee = v.total,
       bosta_actual_shipping_fee = v.shipping,
       bosta_actual_open_package_fee = v.openpkg,
       bosta_actual_cod_fee = v.cod,
       bosta_actual_other_fee = v.other,
       bosta_cash_cycle = v.raw,
       bosta_fees_synced_at = now()
     from (
       select * from unnest(
         $1::bigint[], $2::numeric[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[], $7::jsonb[]
       ) as t(id, total, shipping, openpkg, cod, other, raw)
     ) v
     where o.id = v.id`,
    [ids, total, shipping, openPkg, cod, other, raw]
  );
}

for (let i = 0; i < orders.length; i += SEARCH_BATCH) {
  const batch = await resolveIds(orders.slice(i, i + SEARCH_BATCH));
  const updates = [];
  // Sequential on purpose - see the note on `call`. Parallelism here is what
  // trips the limiter, and a tripped limiter is far slower than no parallelism.
  for (const o of batch) {
    const r = await fetchOne(o).catch((e) => {
      console.log("  " + o.order_number + ": " + e.message);
      return null;
    });
    if (r) updates.push(r);
    done++;
  }
  await flush(updates);
  const rate = done / ((Date.now() - started) / 1000);
  const left = Math.round((orders.length - done) / rate / 60);
  console.log(
    `${done}/${orders.length}  fees=${withFee}  no_delivery=${noDelivery}  no_wallet=${noWallet}  ` +
      `throttles=${throttles}  gap=${gap}ms  ${rate.toFixed(2)}/s  ~${left}m left`
  );
}

console.log(`\nDone. ${withFee} orders now carry Bosta's actual charge; ${noDelivery} had no delivery, ${noWallet} no wallet block.`);
await client.end();
