// Backfills orders.bosta_picked_up_day from the collectedFromBusiness stamp
// already stored in bosta_events.raw_payload - the JS equivalent of part 1 of
// supabase/migrations/0039_actual_pickup_day_basis.sql, for when only the
// Supabase REST credentials are available (no DATABASE_URL).
//
// Migrations 0027/0028 were meant to do this but were gated on `courier =
// 'bosta'`, which is NULL on every Miraj order, so they matched zero rows.
//
// Usage:  node scripts/backfill-pickup-day.mjs          (dry run - writes nothing)
//         node scripts/backfill-pickup-day.mjs --apply  (performs the update)
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

const APPLY = process.argv.includes("--apply");
const ROOT = path.resolve(import.meta.dirname, "..");

const env = Object.fromEntries(
  fs
    .readFileSync(path.join(ROOT, ".env.local"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);

const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
  db: { schema: env.SUPABASE_SCHEMA || "public" },
});

// Egypt day = fixed UTC+3 offset (matches toEgyptDay() in the sync code and the
// '+ interval 3 hours' in the SQL migration).
const toEgyptDay = (iso) => new Date(new Date(iso).getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);

async function fetchAll(table, select, tweak) {
  const out = [];
  for (let page = 0; ; page++) {
    let q = sb.from(table).select(select).order("id", { ascending: true }).range(page * 1000, page * 1000 + 999);
    if (tweak) q = tweak(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

// Earliest collectedFromBusiness across every non-"Created" leg. Bosta mutates a
// leg's type in place on RTO/Exchange, so this must not filter on type 'Send';
// earliest so a genuine second shipment never overrides the original pickup.
const events = await fetchAll("bosta_events", "id, order_id, bosta_state, raw_payload");
const earliest = new Map();
for (const e of events) {
  if (e.bosta_state === "Created") continue;
  const stamp = e.raw_payload?.collectedFromBusiness;
  if (!stamp) continue;
  const t = new Date(stamp).getTime();
  if (!Number.isFinite(t)) continue;
  const prev = earliest.get(e.order_id);
  if (prev === undefined || t < prev) earliest.set(e.order_id, t);
}

const orders = await fetchAll("orders", "id, order_number, egypt_day, outcome, bosta_picked_up_day");
const targets = orders
  .filter((o) => o.bosta_picked_up_day === null && earliest.has(o.id))
  .map((o) => ({ ...o, pickedUpDay: toEgyptDay(new Date(earliest.get(o.id)).toISOString()) }));

console.log(`bosta_events rows:            ${events.length}`);
console.log(`orders:                       ${orders.length}`);
console.log(`orders with a pickup stamp:   ${earliest.size}`);
console.log(`orders to backfill:           ${targets.length}`);

const lag = targets.map((t) => (Date.parse(t.pickedUpDay) - Date.parse(t.egypt_day)) / 86_400_000);
if (lag.length) {
  lag.sort((a, b) => a - b);
  const same = lag.filter((d) => d === 0).length;
  console.log(`\norder day -> pickup day lag: min=${lag[0]}d median=${lag[lag.length >> 1]}d max=${lag[lag.length - 1]}d`);
  console.log(`same-day handovers: ${same} / ${lag.length} (${((same / lag.length) * 100).toFixed(1)}%)`);
  console.log(`negative lag (pickup BEFORE order - should be 0): ${lag.filter((d) => d < 0).length}`);
}

const noStamp = orders.filter((o) => !earliest.has(o.id));
console.log(`\norders with NO pickup stamp (excluded from Actual): ${noStamp.length}`);
const byOutcome = {};
for (const o of noStamp) byOutcome[o.outcome ?? "(null)"] = (byOutcome[o.outcome ?? "(null)"] ?? 0) + 1;
console.log("  by outcome:", JSON.stringify(byOutcome));

console.log("\nsample:");
for (const t of targets.slice(0, 8)) console.log(`  ${t.order_number.padEnd(7)} ordered ${t.egypt_day} -> picked up ${t.pickedUpDay}`);

if (!APPLY) {
  console.log("\nDRY RUN - nothing written. Re-run with --apply to perform the update.");
  process.exit(0);
}

let done = 0;
for (const t of targets) {
  const { error } = await sb.from("orders").update({ bosta_picked_up_day: t.pickedUpDay }).eq("id", t.id);
  if (error) {
    console.error(`  order ${t.order_number}: ${error.message}`);
    continue;
  }
  if (++done % 250 === 0) console.log(`  ...${done}/${targets.length}`);
}
console.log(`\nBackfilled ${done}/${targets.length} orders.`);
