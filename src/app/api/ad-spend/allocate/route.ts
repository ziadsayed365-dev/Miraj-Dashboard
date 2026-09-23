import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { REPORT_CACHE_TAG } from "@/lib/reports/cache";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const role = verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);
  if (role !== "owner") {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 403 });
  }

  const body = await request.json();
  const { campaignId, subCategories, categories, isGeneral } = body;
  // Three ways to pin a campaign: named sub-categories, whole categories (each
  // expanded to its sub-categories at read time), or general - spread across
  // everything selling. Allocation is keyed on the campaign, so it covers that
  // campaign's whole run: every day already on record and every day it spends
  // from here on.
  const general = isGeneral === true;
  if (typeof campaignId !== "string" || !campaignId) {
    return NextResponse.json({ ok: false, error: "Invalid input" }, { status: 400 });
  }

  const clean = (input: unknown): string[] | null => {
    if (input === undefined || input === null) return [];
    if (!Array.isArray(input) || input.some((s) => typeof s !== "string")) return null;
    // De-duplicated: the same label twice would halve its own share.
    return [...new Set((input as string[]).map((s) => s.trim()).filter(Boolean))];
  };

  let labels: string[] = [];
  let categoryLabels: string[] = [];
  if (!general) {
    const subs = clean(subCategories);
    const cats = clean(categories);
    if (subs === null || cats === null) {
      return NextResponse.json({ ok: false, error: "Invalid sub-categories or categories" }, { status: 400 });
    }
    labels = subs;
    categoryLabels = cats;
    if (labels.length === 0 && categoryLabels.length === 0) {
      return NextResponse.json({ ok: false, error: "Pick at least one category or sub-category" }, { status: 400 });
    }
  }

  try {
    // A campaign lives in exactly one ad account, so its segment is already
    // stamped on its spend rows by the Meta sync. Read it back rather than
    // letting the client assert it - the browser has no business deciding
    // whether spend lands in the retail or the wholesale P&L.
    const { data: spendRow, error: segmentErr } = await supabase
      .from("ad_spend")
      .select("segment")
      .eq("campaign_id", campaignId)
      .limit(1)
      .maybeSingle();
    if (segmentErr) throw new Error(`Failed to resolve campaign segment: ${segmentErr.message}`);
    const segment = spendRow?.segment ?? "retail";

    const { error: assignErr } = await supabase
      .from("ad_model_assignments")
      .upsert(
        {
          campaign_id: campaignId,
          sub_categories: general || labels.length === 0 ? null : labels,
          categories: general || categoryLabels.length === 0 ? null : categoryLabels,
          is_general: general,
          segment,
        },
        { onConflict: "campaign_id" }
      );
    if (assignErr) throw new Error(`Failed to save assignment: ${assignErr.message}`);

    // Applies to every day already on record for this campaign, not just the one
    // shown in the popup - future days get backfilled by the Meta sync. The
    // spend figure itself is never divided here: several sub-categories share it
    // equally at read time, so the stored number stays what Meta charged.
    const { error: updateErr } = await supabase
      .from("ad_spend")
      .update({
        // Null rather than an empty array when a kind isn't used, so "has no
        // sub-category pin" reads the same whether the campaign is general,
        // category-pinned, or untouched - the unmapped query keys off exactly that.
        sub_categories: general || labels.length === 0 ? null : labels,
        categories: general || categoryLabels.length === 0 ? null : categoryLabels,
        is_general: general,
      })
      .eq("campaign_id", campaignId);
    if (updateErr) throw new Error(`Failed to allocate existing spend: ${updateErr.message}`);

    // The unmapped-ads list is cached (src/lib/reports/cache.ts) - drop it so the

    // popup reflects this allocation straight away.

    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}

// Undo an allocation: drop the assignment and clear the campaign's spend rows,
// so it falls back to unallocated and reappears in the allocation popup.
export async function DELETE(request: NextRequest) {
  const role = verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);
  if (role !== "owner") {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 403 });
  }

  const body = await request.json();
  const { campaignId } = body;
  if (typeof campaignId !== "string" || !campaignId) {
    return NextResponse.json({ ok: false, error: "Invalid input" }, { status: 400 });
  }

  try {
    const { error: delErr } = await supabase.from("ad_model_assignments").delete().eq("campaign_id", campaignId);
    if (delErr) throw new Error(`Failed to remove assignment: ${delErr.message}`);

    const { error: updateErr } = await supabase
      .from("ad_spend")
      .update({ sub_categories: null, categories: null, is_general: false })
      .eq("campaign_id", campaignId);
    if (updateErr) throw new Error(`Failed to clear spend allocation: ${updateErr.message}`);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}
