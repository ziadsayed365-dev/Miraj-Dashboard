import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { REPORT_CACHE_TAG } from "@/lib/reports/cache";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { updateExpenseEntry, deleteExpenseEntry } from "@/lib/reports/expenses-ledger";

export const dynamic = "force-dynamic";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const role = verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);
  if (role !== "owner") return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 403 });

  const { id } = await params;
  const entryId = Number(id);
  if (!Number.isFinite(entryId)) return NextResponse.json({ ok: false, error: "Invalid id" }, { status: 400 });

  const body = await request.json();
  const patch: { date?: string; accountId?: number; amount?: number; note?: string | null } = {};
  if (body.date !== undefined) patch.date = body.date;
  if (body.accountId !== undefined) patch.accountId = body.accountId;
  if (body.amount !== undefined) patch.amount = body.amount;
  if (body.note !== undefined) patch.note = body.note;

  try {
    await updateExpenseEntry(entryId, patch);
    // The figures behind the Income Statement just changed - drop the cached
    // reports so the next page load rebuilds with this in it.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const role = verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);
  if (role !== "owner") return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 403 });

  const { id } = await params;
  const entryId = Number(id);
  if (!Number.isFinite(entryId)) return NextResponse.json({ ok: false, error: "Invalid id" }, { status: 400 });

  try {
    await deleteExpenseEntry(entryId);
    // The figures behind the Income Statement just changed - drop the cached
    // reports so the next page load rebuilds with this in it.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}
