import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { REPORT_CACHE_TAG } from "@/lib/reports/cache";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { learnProductAliases, parseAliasBody } from "@/lib/chat-orders/aliases";

export const dynamic = "force-dynamic";

// Records the Arabic phrasings the owner resolved by hand while reviewing a
// pasted batch, so the next paste matches them itself. Same access rule as
// recording a chat order - anyone who can record one can teach a name.
export async function POST(request: NextRequest) {
  const role = verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);
  if (!role) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid body" }, { status: 400 });
  }

  try {
    const learned = await learnProductAliases(parseAliasBody(body));
    // The figures behind the Income Statement just changed - drop the cached
    // reports so the next page load rebuilds with this in it.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true, learned });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 400 });
  }
}
