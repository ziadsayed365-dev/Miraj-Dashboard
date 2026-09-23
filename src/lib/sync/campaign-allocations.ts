import "server-only";
import { supabase } from "@/lib/supabase";

// ALLOCATION IS PERMANENT, PER CAMPAIGN. Once a campaign is pinned, every day it
// ever spends belongs to the same target - including days synced later, and
// including spend from ads created inside it afterwards. The ad-spend syncs
// (Meta, TikTok) only write the money, never the allocation columns, so each new
// day arrives unallocated; this stamps them from the standing decision in
// ad_model_assignments. Without it the campaign came back to the allocation
// popup every single day.
//
// This used to read and write model_group_id, which allocation moved off in
// migration 0063 (sub_categories) and 0067 (categories) - so it was writing a
// column nothing reads and leaving the two the popup actually keys on
// (sub_categories / categories, both still null) untouched. Every allocated
// campaign reappeared as unallocated on its next day of spend.
export async function reapplyCampaignAllocations(): Promise<void> {
  const { data: assignments, error: assignmentsErr } = await supabase
    .from("ad_model_assignments")
    .select("campaign_id, sub_categories, categories, is_general");
  if (assignmentsErr) throw new Error(`Failed to load campaign allocations: ${assignmentsErr.message}`);

  // Grouped by target so campaigns pinned to the same thing are stamped in one
  // statement - one round trip per distinct target instead of one per campaign.
  type Target = { subCategories: string[] | null; categories: string[] | null; isGeneral: boolean };
  const byTarget = new Map<string, { target: Target; campaignIds: string[] }>();
  for (const a of assignments ?? []) {
    const target: Target = {
      // Normalised to null exactly as the allocate route stores it, so "has no
      // pin of this kind" reads the same everywhere - the unmapped-ads query
      // keys off precisely that.
      subCategories: a.is_general || !a.sub_categories?.length ? null : a.sub_categories,
      categories: a.is_general || !a.categories?.length ? null : a.categories,
      isGeneral: a.is_general,
    };
    const key = JSON.stringify(target);
    const entry = byTarget.get(key);
    if (entry) entry.campaignIds.push(a.campaign_id);
    else byTarget.set(key, { target, campaignIds: [a.campaign_id] });
  }

  for (const { target, campaignIds } of byTarget.values()) {
    // Only rows that carry no allocation yet: a campaign whose pin was later
    // changed already had every one of its rows rewritten by the allocate
    // route, and those must not be reverted here.
    const { error: reapplyErr } = await supabase
      .from("ad_spend")
      .update({
        sub_categories: target.subCategories,
        categories: target.categories,
        is_general: target.isGeneral,
      })
      .is("sub_categories", null)
      .is("categories", null)
      .eq("is_general", false)
      .in("campaign_id", campaignIds);
    if (reapplyErr) throw new Error(`Failed to re-apply campaign allocations: ${reapplyErr.message}`);
  }
}
