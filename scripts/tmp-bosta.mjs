// Read-only feasibility probe: batch search, businessReference-with-prefix,
// detail throughput, and how consistently wallet.cashCycle is populated.
import pg from "pg";
import fs from "node:fs";

const env = Object.fromEntries(
  fs
    .readFileSync("D:/Clients/Other/Finvisor/7- Miraj/.env.local", "utf8")
    .split("\n")
    .map((l) => l.match(/^\s*([A-Za-z_0-9]+)\s*=\s*(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim()])
);
const apiKey = env.BOSTA_API_KEY;
const H = { Authorization: apiKey, "Content-Type": "application/json" };

const client = new pg.Client({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();

console.log("=== coverage: orders with/without a tracking number ===");
console.table(
  (
    await client.query(`
      select to_char(egypt_day,'YYYY-MM') as month, count(*) as orders,
             count(*) filter (where bosta_tracking_number is not null) as with_tn,
             count(*) filter (where bosta_tracking_number is null) as no_tn
      from orders where cancelled_at is null group by 1 order by 1
    `)
  ).rows
);

const { rows: sample } = await client.query(`
  select order_number, bosta_tracking_number as tn from orders
  where cancelled_at is null and bosta_tracking_number is not null
  order by random() limit 20
`);
const { rows: noTn } = await client.query(`
  select order_number from orders
  where cancelled_at is null and bosta_tracking_number is null
    and egypt_day between date '2026-01-01' and date '2026-01-31'
  order by random() limit 5
`);
await client.end();

console.log("\n=== can one search call take MANY tracking numbers? ===");
const t0 = Date.now();
const res = await fetch("https://app.bosta.co/api/v0/deliveries/search", {
  method: "POST",
  headers: H,
  body: JSON.stringify({ pageNumber: 1, pageLimit: 50, trackingNumbers: sample.map((r) => r.tn) }),
});
const body = await res.json();
const list = body.deliveries ?? [];
console.log("sent 20 tracking numbers -> returned " + list.length + " in " + (Date.now() - t0) + "ms");

console.log("\n=== businessReference WITH store prefix (orders we have no tracking for) ===");
for (const r of noTn) {
  const q = await fetch("https://app.bosta.co/api/v0/deliveries/search", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ pageNumber: 1, pageLimit: 5, businessReference: "tu1ssd-ws:" + r.order_number }),
  });
  const b = await q.json();
  const n = (b.deliveries ?? []).length;
  console.log("  " + r.order_number + " -> " + n + (n ? "  tn=" + b.deliveries[0].trackingNumber + " state=" + JSON.stringify(b.deliveries[0].state?.value) : ""));
}

console.log("\n=== detail throughput + cashCycle completeness (10 orders) ===");
const t1 = Date.now();
let withWallet = 0;
for (const d of list.slice(0, 10)) {
  const r = await fetch("https://app.bosta.co/api/v0/deliveries/" + d._id, { headers: { Authorization: apiKey } });
  const full = await r.json();
  const cc = full?.wallet?.cashCycle;
  if (cc) withWallet++;
  console.log(
    "  " + full.trackingNumber +
    "  type=" + (full.type?.value ?? "?") +
    "  state=" + (full.state?.value ?? "?") +
    "  bosta_fees=" + (cc?.bosta_fees ?? "-") +
    "  shipping=" + (cc?.shipping_fees ?? "-") +
    "  openpkg=" + (cc?.opening_package_fees ?? "-") +
    "  cod=" + (cc?.cod_fees ?? "-")
  );
}
const ms = Date.now() - t1;
console.log("\n10 detail calls in " + ms + "ms  (~" + Math.round(ms / 10) + "ms each); wallet present on " + withWallet + "/10");
console.log("=> 35,866 orders ~= " + Math.round((35866 * (ms / 10)) / 1000 / 60) + " min single-threaded");
