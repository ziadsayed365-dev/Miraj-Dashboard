// AI MIRAJ's hands. Each command does one thing the owner would do by hand on
// the live dashboard, so the agent can run them in order and stop on trouble:
//
//   node miraj.mjs sync               press Sync (every step, in the button's order)
//   node miraj.mjs audit [day]        TikTok entered?, unallocated campaigns, missing costs, report tie-out -> out/audit.json
//   node miraj.mjs pdf [day]          Export PDF (Income Statement + Analysis by Product) -> out/miraj-<day>.pdf
//   node miraj.mjs nightly [day]      ask on Telegram for what the report is missing, or send the report (with PDF)
//   node miraj.mjs webhook            point the Telegram bot at the dashboard, so answers are recorded instantly
//   node miraj.mjs tg <body-file> [attachment]                 send a message on Telegram
//   node miraj.mjs apply <actions-json-file>                   record TikTok spend / allocate campaigns / set costs
//
// Env: MIRAJ_URL, MIRAJ_CRON_SECRET (the dashboard's CRON_SECRET), and
// MIRAJ_USERNAME + MIRAJ_PASSWORD (a dashboard login, for the PDF). The
// Telegram bot token lives on the dashboard, not here.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { execFileSync } from "node:child_process";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "out");
fs.mkdirSync(OUT, { recursive: true });

// Mirrors src/app/(app)/sync-button.tsx.
const SYNC_STEPS = ["shopify", "shopify-products", "attribution", "meta", "tiktok", "calibrate", "monthly-rate", "sku-monthly-rate", "margins"];

// Steps that checkpoint a cursor and stop after ~40s, so one request clears only
// part of the backlog: they must be called until they answer reachedEnd, as the
// Sync button does. Pressing each once reported 27 Sep with every order after
// 8:51 PM missing (130 orders instead of ~200), since Shopify orders are walked
// oldest-update first and the newest land last. The caps are higher than the
// button's because nobody is here to click Sync again.
const MAX_PASSES = { shopify: 25, meta: 5, tiktok: 5 };

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

const base = () => env("MIRAJ_URL").replace(/\/$/, "");
const cronHeaders = () => ({ authorization: `Bearer ${env("MIRAJ_CRON_SECRET")}` });

function yesterdayInEgypt() {
  // Same fixed +3h the dashboard's egyptToday() uses, so both agree on "yesterday".
  return new Date(Date.now() + 3 * 3600_000 - 86_400_000).toISOString().slice(0, 10);
}

// A step can time out on one slow Meta or TikTok response (HTTP 504) and pass on
// the next try. Every step only re-reads and saves the same data, so running it
// again is safe.
const STEP_ATTEMPTS = 2;

async function syncStep(step) {
  const res = await fetch(`${base()}/api/sync/run?step=${step}`, { method: "POST", headers: cronHeaders() });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  return { ok: res.ok && data.ok, data, error: data.error ?? res.status };
}

async function sync() {
  const results = [];
  const fail = (step) => {
    fs.writeFileSync(path.join(OUT, "sync.json"), JSON.stringify({ ok: false, failedStep: step, results }, null, 2));
    process.exit(1);
  };
  for (const step of SYNC_STEPS) {
    const maxPasses = MAX_PASSES[step] ?? 1;
    let drained = false;
    for (let pass = 1; pass <= maxPasses && !drained; pass++) {
      let attempt = await syncStep(step);
      for (let i = 2; !attempt.ok && i <= STEP_ATTEMPTS; i++) {
        console.log(`${step}: failed (${attempt.error}), trying again`);
        attempt = await syncStep(step);
      }
      const { ok, data } = attempt;
      results.push(data);
      if (!ok) {
        console.log(`${step}: FAILED - ${attempt.error}`);
        fail(step);
      }
      drained = maxPasses === 1 || data.reachedEnd === true;
      console.log(`${step}${maxPasses > 1 ? ` pass ${pass}` : ""}: ok${drained ? "" : " (more to fetch)"}`);
    }
    // A half-finished pull is not a sync: the report would be short of the
    // day's latest orders or spend, so stop here rather than audit it.
    if (!drained) {
      console.log(`${step}: FAILED - still not caught up after ${maxPasses} passes`);
      fail(step);
    }
  }
  fs.writeFileSync(path.join(OUT, "sync.json"), JSON.stringify({ ok: true, results }, null, 2));
}

// Right after Sync the dashboard is busy recomputing, and a read can time out
// (an error page from Vercel or the sandbox's proxy) and pass a minute later.
// Reads change nothing, so trying again is safe.
const READ_ATTEMPTS = 3;
const RETRY_PAUSE_MS = 20_000;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetries(label, fn) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= READ_ATTEMPTS) throw err;
      console.log(`${label}: failed (${err instanceof Error ? err.message.split("\n")[0] : err}), trying again`);
      await pause(RETRY_PAUSE_MS);
    }
  }
}

async function audit(day = yesterdayInEgypt()) {
  const { res, data } = await withRetries("audit", async () => {
    const res = await fetch(`${base()}/api/agent/audit?day=${day}`, { headers: cronHeaders() });
    const data = await res.json().catch(() => null);
    if (!data || res.status >= 500) throw new Error(`HTTP ${res.status}`);
    return { res, data };
  });
  fs.writeFileSync(path.join(OUT, "audit.json"), JSON.stringify(data, null, 2));
  console.log(JSON.stringify(data, null, 2));
  if (!res.ok) process.exit(1);
}

async function login() {
  const form = new URLSearchParams({ username: env("MIRAJ_USERNAME"), password: env("MIRAJ_PASSWORD") });
  const res = await fetch(`${base()}/api/login`, { method: "POST", body: form, redirect: "manual" });
  const cookie = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("miraj_session="));
  if (!cookie) throw new Error("Login failed - check MIRAJ_USERNAME / MIRAJ_PASSWORD");
  return cookie.split(";")[0].slice("miraj_session=".length);
}

// Claude's cloud sandbox sends traffic through a proxy that signs with its own
// certificate authority. Node already trusts it (via the CA bundle the sandbox
// points at), but Chromium only trusts what is in its NSS store, so add that
// bundle's certificates there. Certificate checking stays fully on. Needs
// certutil (apt package libnss3-tools); a no-op outside the sandbox.
function trustSandboxCa() {
  const bundle = [process.env.NODE_EXTRA_CA_CERTS, process.env.SSL_CERT_FILE, process.env.AWS_CA_BUNDLE].find(
    (p) => p && fs.existsSync(p)
  );
  if (!bundle || process.platform !== "linux") return;

  const db = path.join(os.homedir(), ".pki", "nssdb");
  if (!fs.existsSync(path.join(db, "cert9.db"))) {
    fs.mkdirSync(db, { recursive: true });
    execFileSync("certutil", ["-N", "-d", `sql:${db}`, "--empty-password"]);
  }
  const certs = fs.readFileSync(bundle, "utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  certs.forEach((pem, i) => {
    execFileSync("certutil", ["-A", "-d", `sql:${db}`, "-t", "C,,", "-n", `sandbox-ca-${i}`], { input: pem });
  });
  console.log(`trusted ${certs.length} CA certificate(s) from ${bundle} in Chromium`);
}

async function pdf(day = yesterdayInEgypt()) {
  trustSandboxCa();
  const { chromium } = await import("playwright");
  const token = await login();
  // level=category: the owner wants Analysis by Product at category level.
  const url = `${base()}/print/income-statement?from=${day}&to=${day}&is=1&product=1&level=category`;

  const file = path.join(OUT, `miraj-${day}.pdf`);
  await withRetries("pdf", () => renderPdf(chromium, token, url, file));
  console.log(file);
}

async function renderPdf(chromium, token, url, file) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await context.addCookies([{ name: "miraj_session", value: token, url: base() }]);
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.print = () => {}; // the page auto-opens the print dialog; we save the PDF ourselves
    });
    // The page is rendered on the server from the whole P&L history, which can
    // take well over 30s right after Sync. When it takes too long, Chromium is
    // handed an error page instead ("upstream request failed" from the sandbox's
    // proxy) and printing it sent the owner a blank PDF on 28 Sep. So check the
    // answer, and wait for the report itself rather than for the network to go
    // quiet.
    const response = await page.goto(url, { waitUntil: "load", timeout: 180_000 });
    if (new URL(page.url()).pathname === "/login") throw new Error("PDF page redirected to login");
    if (response && !response.ok()) {
      const body = (await page.innerText("body").catch(() => "")).trim().split("\n")[0].slice(0, 120);
      throw new Error(`report page answered HTTP ${response.status()}${body ? ` (${body})` : ""}`);
    }
    await page.waitForSelector("[data-pdf-page]", { timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    // One page per section - Income Statement, then Analysis by Product. Lay
    // the page out at A4's printed width (190mm inside the page's 10mm margins,
    // 718px) and shrink any section taller than a page (277mm, 1047px, less
    // room for the page's padding and the gap above Analysis by Product) until
    // it fits, rather than let it spill onto a second page.
    await page.setViewportSize({ width: 718, height: 1047 });
    await page.emulateMedia({ media: "print" });
    await page.evaluate((maxHeight) => {
      for (const el of document.querySelectorAll("[data-pdf-page]")) {
        const height = el.getBoundingClientRect().height;
        if (height > maxHeight) el.style.zoom = String(maxHeight / height);
      }
    }, 1047 - 100);
    await page.pdf({ path: file, format: "A4", printBackground: true, preferCSSPageSize: true });
  } finally {
    await browser.close();
  }
}

// Telegram, relayed by the dashboard (POST /api/agent/telegram): Claude's cloud
// sandbox permits only HTTPS, and the bot token stays there. `replies` returns each message once - reading one marks it read,
// so act on what comes back rather than expecting to see it again.
async function tg(bodyFile, attachment) {
  if (!bodyFile) throw new Error("usage: tg <body-file> [attachment]");
  const res = await fetch(`${base()}/api/agent/telegram`, {
    method: "POST",
    headers: { ...cronHeaders(), "content-type": "application/json" },
    body: JSON.stringify({
      text: fs.readFileSync(bodyFile, "utf8"),
      pdfBase64: attachment ? fs.readFileSync(attachment).toString("base64") : undefined,
      filename: attachment ? path.basename(attachment) : undefined,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error ?? `Telegram send failed (HTTP ${res.status})`);
  console.log("sent on Telegram");
}

// The dashboard does the asking and the reporting (src/lib/agent/requests.ts):
// one Telegram message per missing item, and the report with its PDF once
// nothing is missing. Answers then reach it straight from Telegram.
// Retried like audit: right after Sync the reports are rebuilt from cold and a
// heavy query can hit the database's statement timeout (12 Oct). Safe to
// repeat - nothing already asked is asked again, and the report goes out once.
async function nightly(day = yesterdayInEgypt()) {
  const data = await withRetries("nightly", async () => {
    const res = await fetch(`${base()}/api/agent/nightly?day=${day}`, { method: "POST", headers: cronHeaders() });
    const data = await res.json().catch(() => null);
    if (!data || res.status >= 500) throw new Error(data?.error ?? `HTTP ${res.status}`);
    return data;
  });
  console.log(JSON.stringify(data, null, 2));
  if (!data.ok) process.exit(1);
}

async function webhook() {
  const res = await fetch(`${base()}/api/agent/webhook`, { method: "PUT", headers: cronHeaders() });
  const data = await res.json().catch(() => ({}));
  console.log(JSON.stringify(data, null, 2));
  if (!res.ok || !data.ok) process.exit(1);
}

async function apply(actionsFile) {
  if (!actionsFile) throw new Error("usage: apply <actions-json-file>");
  const res = await fetch(`${base()}/api/agent/apply`, {
    method: "POST",
    headers: { ...cronHeaders(), "content-type": "application/json" },
    body: fs.readFileSync(actionsFile, "utf8"),
  });
  const data = await res.json().catch(() => ({}));
  console.log(JSON.stringify(data, null, 2));
  if (!res.ok) process.exit(1);
}

const [command, ...args] = process.argv.slice(2);
const commands = { sync, audit, pdf, nightly, webhook, tg, apply };
if (!commands[command]) {
  console.error(`unknown command "${command}" - expected one of ${Object.keys(commands).join(", ")}`);
  process.exit(2);
}
await commands[command](...args).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
