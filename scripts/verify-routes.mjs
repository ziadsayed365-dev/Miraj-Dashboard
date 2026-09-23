// Smoke test for the auth proxy. Run after touching src/proxy.ts or adding
// a new top-level page route: confirms public pages render (not 404) and
// protected pages still redirect unauthenticated visitors to /login.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = process.env.VERIFY_ROUTES_PORT ?? "3000";
const BASE = `http://localhost:${PORT}`;

function loadEnvLocal() {
  const path = new URL("../.env.local", import.meta.url);
  if (!existsSync(path)) return {};
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

async function isUp() {
  try {
    await fetch(BASE, { redirect: "manual" });
    return true;
  } catch {
    return false;
  }
}

async function waitUntilUp(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isUp()) return true;
    await sleep(300);
  }
  return false;
}

function killTree(proc) {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"]);
  } else {
    proc.kill("SIGTERM");
  }
}

function getSetCookie(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? "OK  " : "FAIL"} ${name}${detail ? ` -- ${detail}` : ""}`);
}

async function run() {
  let startedHere = false;
  let devProcess = null;

  if (!(await isUp())) {
    console.log(`No server on port ${PORT}, starting "npm run dev"...`);
    devProcess = spawn("npm", ["run", "dev", "--", "-p", PORT], {
      shell: true,
      stdio: ["ignore", "ignore", "inherit"],
    });
    startedHere = true;
    if (!(await waitUntilUp(30000))) {
      console.error("Server never came up after 30s.");
      killTree(devProcess);
      process.exit(1);
    }
  } else {
    console.log(`Reusing existing server on port ${PORT}.`);
  }

  try {
    const loginRes = await fetch(`${BASE}/login`, { redirect: "manual" });
    check("GET /login renders (200)", loginRes.status === 200, `got ${loginRes.status}`);

    const rootRes = await fetch(`${BASE}/`, { redirect: "manual" });
    check(
      "GET / redirects unauthenticated visitors to /login",
      rootRes.status === 307 && (rootRes.headers.get("location") ?? "").endsWith("/login"),
      `got ${rootRes.status} -> ${rootRes.headers.get("location")}`
    );

    const productsRes = await fetch(`${BASE}/products`, { redirect: "manual" });
    check(
      "GET /products redirects unauthenticated visitors to /login",
      productsRes.status === 307 && (productsRes.headers.get("location") ?? "").endsWith("/login"),
      `got ${productsRes.status}`
    );

    const env = loadEnvLocal();
    const ownerUser = env.OWNER_USERNAME;
    const ownerPass = env.OWNER_PASSWORD;
    if (!ownerUser || !ownerPass) {
      check("POST /api/login round trip", false, "OWNER_USERNAME/OWNER_PASSWORD missing from .env.local");
    } else {
      const loginPost = await fetch(`${BASE}/api/login`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: ownerUser, password: ownerPass }),
      });
      const setCookie = getSetCookie(loginPost.headers)[0];
      const cookieOk = loginPost.status === 303 && !!setCookie;
      check("POST /api/login sets a session cookie", cookieOk, `got ${loginPost.status}`);

      if (cookieOk) {
        const authedRoot = await fetch(`${BASE}/`, {
          redirect: "manual",
          headers: { Cookie: setCookie.split(";")[0] },
        });
        check("GET / with session cookie loads the dashboard (200)", authedRoot.status === 200, `got ${authedRoot.status}`);
      }
    }
  } finally {
    if (startedHere && devProcess) {
      console.log("Stopping the dev server we started...");
      killTree(devProcess);
    }
  }

  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.error(`\n${failed.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll route checks passed.");
}

await run();
