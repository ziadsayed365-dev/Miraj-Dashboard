import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { REPORT_CACHE_TAG } from "@/lib/reports/cache";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { saveTikTokSpend, type TikTokEntry } from "@/lib/tiktok-spend";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const role = verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);
  if (role !== "owner") {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 403 });
  }

  let body: { date?: string; entries?: TikTokEntry[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid body" }, { status: 400 });
  }

  if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    return NextResponse.json({ ok: false, error: "invalid date" }, { status: 400 });
  }

  const entries: TikTokEntry[] = Array.isArray(body.entries)
    ? body.entries.map((e) => ({ amount: Number(e.amount), modelGroupId: e.modelGroupId == null ? null : Number(e.modelGroupId) }))
    : [];

  try {
    await saveTikTokSpend(body.date, entries);
    // The figures behind the Income Statement just changed - drop the cached
    // reports so the next page load rebuilds with this in it.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "failed" }, { status: 500 });
  }
}
