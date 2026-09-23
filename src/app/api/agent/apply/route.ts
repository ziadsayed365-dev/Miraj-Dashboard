import { NextRequest, NextResponse } from "next/server";
import { dropReportCache } from "@/lib/reports/cache";
import { applyAgentActions, type AgentAction } from "@/lib/agent/actions";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const MAX_ACTIONS = 25;

const stringList = (v: unknown): string[] | null =>
  v === undefined ? [] : Array.isArray(v) && v.every((s) => typeof s === "string") ? (v as string[]) : null;

function parseAction(raw: unknown): AgentAction | null {
  if (typeof raw !== "object" || raw === null) return null;
  const a = raw as Record<string, unknown>;
  if (a.type === "set_tiktok_spend" && typeof a.date === "string" && typeof a.amount === "number") {
    return { type: "set_tiktok_spend", date: a.date, amount: a.amount };
  }
  if (a.type === "allocate_campaign" && typeof a.campaignId === "string" && a.campaignId) {
    const subCategories = stringList(a.subCategories);
    const categories = stringList(a.categories);
    if (!subCategories || !categories) return null;
    return { type: "allocate_campaign", campaignId: a.campaignId, subCategories, categories, general: a.general === true };
  }
  if (a.type === "set_product_cost" && typeof a.productId === "number" && typeof a.unitCost === "number") {
    return { type: "set_product_cost", productId: a.productId, unitCost: a.unitCost };
  }
  return null;
}

// The fixes AI MIRAJ applies after the owner answers a nightly message. Every
// action is one the owner could make on the dashboard, and none overwrites an
// existing entry, allocation or cost (see src/lib/agent/actions.ts).
export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ ok: false, error: "CRON_SECRET not configured" }, { status: 403 });
  }
  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const raw = Array.isArray(body?.actions) ? body.actions : null;
  if (!raw || raw.length === 0) {
    return NextResponse.json({ ok: false, error: "actions must be a non-empty array" }, { status: 400 });
  }
  if (raw.length > MAX_ACTIONS) {
    return NextResponse.json({ ok: false, error: `at most ${MAX_ACTIONS} actions per request` }, { status: 400 });
  }

  const actions: AgentAction[] = [];
  for (const item of raw) {
    const parsed = parseAction(item);
    if (!parsed) {
      return NextResponse.json({ ok: false, error: `Unrecognised action: ${JSON.stringify(item)}` }, { status: 400 });
    }
    actions.push(parsed);
  }

  const results = await applyAgentActions(actions);
  // The reports are cached (src/lib/reports/cache.ts); retire them so the
  // re-check and PDF that follow see these changes.
  if (results.some((r) => r.ok)) dropReportCache();
  return NextResponse.json({ ok: results.every((r) => r.ok), results });
}
