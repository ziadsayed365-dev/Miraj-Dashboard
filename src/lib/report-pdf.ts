import "server-only";
import fs from "node:fs";
import path from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";
import { createSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";

// Renders the /print/income-statement view to a PDF, so the dashboard itself
// can send the report - with the Campaigns P&L as its last two pages - the
// moment the owner's last answer comes in (see
// src/lib/agent/requests.ts). Same page and layout the nightly agent prints
// with Playwright (scripts/ai-miraj/miraj.mjs pdf).
//
// On Vercel it uses @sparticuz/chromium (a serverless-sized Chromium); locally,
// whatever Chrome LOCAL_CHROME_PATH points at. Ported from the O Garage
// dashboard.

const PAGE_TIMEOUT_MS = 180_000;

// A4 inside the page's 10mm margins, in CSS pixels: 190 x 277 mm.
const A4_CONTENT_WIDTH_PX = 718;
const A4_CONTENT_HEIGHT_PX = 1047;
// Room each page keeps for the report's own padding and the gap above
// Analysis by Product, so rounding never tips a section onto a new page.
const SECTION_ALLOWANCE_PX = 100;

// The serverless Chromium ships only Open Sans, which has no Arabic - and
// Miraj's product names are Arabic. Its fontconfig reads /tmp/fonts, so the
// bundled Noto Sans Arabic is added there and Chromium falls back to it for
// every Arabic glyph.
//
// Only AFTER the package has unpacked its own fonts into /tmp/fonts: it skips
// unpacking when that folder already exists, so creating it first left
// Chromium with no fonts and no fonts.conf at all - and every PDF came out
// with its tables but not a single word (13 Oct).
const FONT_DIR = "/tmp/fonts";
const ARABIC_FONT = path.join(process.cwd(), "src/lib/pdf-fonts/NotoSansArabic.ttf");

function installArabicFont(): void {
  const target = path.join(FONT_DIR, "NotoSansArabic.ttf");
  if (!fs.existsSync(target)) fs.copyFileSync(ARABIC_FONT, target);
}

async function launch(): Promise<Browser> {
  const localPath = process.env.LOCAL_CHROME_PATH?.trim();
  if (localPath) {
    return puppeteer.launch({ executablePath: localPath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  }
  // A font folder left by the old order, without the package's fonts.conf,
  // would still block the unpacking - clear it first.
  if (fs.existsSync(FONT_DIR) && !fs.existsSync(path.join(FONT_DIR, "fonts.conf"))) {
    fs.rmSync(FONT_DIR, { recursive: true, force: true });
  }
  const chromium = (await import("@sparticuz/chromium")).default;
  const executablePath = await chromium.executablePath();
  installArabicFont();
  return puppeteer.launch({ executablePath, args: chromium.args, headless: true });
}

// "2026-10-11" -> "miraj-2026-10-11.pdf", the name the nightly report has always had.
export function reportFileName(day: string): string {
  return `miraj-${day}.pdf`;
}

// `origin` is this deployment's own address; `day` the single day reported.
export async function renderReportPdf(origin: string, day: string): Promise<Buffer> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set - cannot open the report page");

  const base = origin.replace(/\/+$/, "");
  // level=category: the owner wants Analysis by Product at category level.
  const url = `${base}/print/income-statement?from=${day}&to=${day}&is=1&product=1&campaigns=1&level=category`;

  let browser: Browser | null = null;
  try {
    browser = await launch();
    const page = await browser.newPage();
    // The page opens the print dialog by itself; the PDF is saved here instead.
    await page.evaluateOnNewDocument(() => {
      window.print = () => {};
    });
    // The print page is owner-only. Mint a session rather than log in.
    await browser.setCookie({
      name: SESSION_COOKIE_NAME,
      value: createSessionToken("owner", secret),
      domain: new URL(base).hostname,
      path: "/",
      httpOnly: true,
      secure: base.startsWith("https://"),
    });

    const res = await page.goto(url, { waitUntil: "load", timeout: PAGE_TIMEOUT_MS });
    if (new URL(page.url()).pathname !== "/print/income-statement") {
      throw new Error(`report page redirected to ${new URL(page.url()).pathname} - session rejected`);
    }
    // An error page printed would be a blank report (this sent the owner an
    // "upstream request failed" PDF on 28 Sep), so check the answer and wait
    // for the report itself.
    if (!res || !res.ok()) throw new Error(`report page answered HTTP ${res?.status() ?? "none"}`);
    await page.waitForSelector("[data-pdf-page]", { timeout: 60_000 });
    // The Campaigns P&L pages fit themselves to A4 once rendered; print only after.
    await page.waitForSelector('[data-campaigns="fitted"]', { timeout: 60_000 });
    await page.evaluate(() => document.fonts.ready);

    // One page per section - Income Statement, then Analysis by Product - each
    // shrunk to fit A4 rather than spill onto a second page.
    await page.setViewport({ width: A4_CONTENT_WIDTH_PX, height: A4_CONTENT_HEIGHT_PX });
    await page.emulateMediaType("print");
    await page.evaluate((maxHeight) => {
      for (const el of document.querySelectorAll<HTMLElement>("[data-pdf-page]")) {
        const height = el.getBoundingClientRect().height;
        if (height > maxHeight) el.style.zoom = String(maxHeight / height);
      }
    }, A4_CONTENT_HEIGHT_PX - SECTION_ALLOWANCE_PX);

    const pdf = await page.pdf({ format: "a4", printBackground: true, preferCSSPageSize: true });
    return Buffer.from(pdf);
  } finally {
    await browser?.close();
  }
}
