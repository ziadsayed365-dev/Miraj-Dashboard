import "server-only";
import { unstable_cache } from "next/cache";
import { REPORT_CACHE_SECONDS, REPORT_CACHE_TAG } from "./cache";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";
import { REPORTED_AD_SEGMENT } from "@/lib/ad-segment";

export type UnmappedAd = {
  campaignId: string;
  campaignName: string | null;
  date: string;
  spend: number;
  // Which Meta ad account the campaign ran in. Shown in the popup so it is
  // obvious which business line the spend came from before choosing where it
  // belongs - "Miraj - Rugs" narrows the answer a long way on its own.
  adAccountName: string | null;
};

// Surface every synced campaign for mapping. The cutoff must reach back to the
// EARLIEST synced spend, or the oldest unmapped campaigns never appear in the
// allocation modal and their spend stays permanently unallocated.
//
// Keep this in step with META_SPEND_SINCE in .env.local - if the backfill start
// is moved earlier, move this with it.
const BACKLOG_CUTOFF = "2025-07-01";

// A campaign promotes the same model for its whole run (Miraj runs one campaign
// per product), so this is keyed by campaign_id - each new campaign needs its
// own allocation decision. The most recent unmapped day's spend is shown as a
// representative snapshot; allocating it (POST /api/ad-spend/allocate) applies
// to every day for that campaign, past and future, not just the one shown here.
// Paginates every unallocated ad_spend row, which is thousands of rows on a
// mature account - and it ran on every Analysis by Product load. Dropped by the
// allocation write below, so allocating still updates the popup at once.
export const getUnmappedAds = unstable_cache(computeUnmappedAds, ["unmapped-ads"], {
  revalidate: REPORT_CACHE_SECONDS,
  tags: [REPORT_CACHE_TAG],
});

async function computeUnmappedAds(): Promise<UnmappedAd[]> {
  const rows = await fetchAllRows<{
    campaign_id: string | null;
    campaign_name: string | null;
    date: string;
    spend: number;
    sub_categories: string[] | null;
    categories: string[] | null;
    ad_account_name: string | null;
  }>(
    supabase,
    "ad_spend",
    "campaign_id, campaign_name, date, spend, sub_categories, categories, ad_account_name",
    // is_general rows are a DELIBERATE choice ("spread across everything"), not
    // an outstanding decision - they must not come back to the popup.
    //
    // Retail only. Wholesale ads stay out until wholesale reporting exists -
    // offering them here would invite allocating wholesale spend to a retail
    // sub-category, and their spend is excluded from every report regardless.
    // They are still being synced, so they will be waiting when that phase lands.
    // A campaign pinned to a whole CATEGORY is just as decided as one pinned to
    // a sub-category, so it must not come back either.
    (query) =>
      query
        .is("sub_categories", null)
        .is("categories", null)
        .eq("is_general", false)
        .eq("segment", REPORTED_AD_SEGMENT)
        .gte("date", BACKLOG_CUTOFF)
  );

  const latestByCampaign = new Map<string, UnmappedAd>();
  for (const row of rows) {
    if (!row.campaign_id) continue;
    // A campaign allocated to nothing is still outstanding; one with any
    // sub-category OR category is done, even if some of its older rows predate
    // the allocation.
    if (row.sub_categories && row.sub_categories.length > 0) continue;
    if (row.categories && row.categories.length > 0) continue;
    const existing = latestByCampaign.get(row.campaign_id);
    if (!existing || row.date > existing.date) {
      latestByCampaign.set(row.campaign_id, {
        campaignId: row.campaign_id,
        campaignName: row.campaign_name,
        date: row.date,
        spend: Number(row.spend),
        adAccountName: row.ad_account_name,
      });
    }
  }

  return [...latestByCampaign.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

// One campaign the owner has already handled - shown in the Settings management
// view so an allocation can be reviewed and changed after the fact. isGeneral =
// "spread across all models"; otherwise modelGroupId is the one model it's
// pinned to. Metadata + total spend are rolled up from every ad_spend day.
export type AdAllocation = {
  campaignId: string;
  campaignName: string | null;
  source: string | null;
  spend: number; // total spend across every day on record for the campaign
  // Per-day spend, so Settings can re-total the campaign over any date range
  // without a round trip. Only a few thousand rows exist across every allocated
  // campaign, which is well worth sending once for an instant filter.
  daily: { date: string; spend: number }[];
  lastDate: string; // most recent day with spend (empty if none on record)
  adAccountName: string | null;
  // The sub-categories it promotes. More than one means its spend is split
  // equally between them. Empty when General.
  subCategories: string[];
  // Whole categories it promotes, each expanded to its current sub-categories
  // at read time and sharing the split with any named above.
  categories: string[];
  isGeneral: boolean;
};

// Every campaign that has an assignment (pinned to a model, or marked General),
// enriched with its name / source / spend for the Settings management view.
// Excludes still-unallocated campaigns (no assignment row - those live in the popup).
export async function getAdAllocations(): Promise<AdAllocation[]> {
  const { data: assignments, error } = await supabase
    .from("ad_model_assignments")
    .select("campaign_id, sub_categories, categories, is_general");
  if (error) throw new Error(`Failed to load campaign assignments: ${error.message}`);
  const assigned = (assignments ?? []) as {
    campaign_id: string;
    sub_categories: string[] | null;
    categories: string[] | null;
    is_general: boolean;
  }[];
  if (assigned.length === 0) return [];

  const assignmentByCampaign = new Map(assigned.map((a) => [a.campaign_id, a]));

  const rows = await fetchAllRows<{
    campaign_id: string | null;
    campaign_name: string | null;
    source: string | null;
    date: string;
    spend: number;
    ad_account_name: string | null;
  }>(
    supabase,
    "ad_spend",
    "id, campaign_id, campaign_name, source, date, spend, ad_account_name",
    (query) => query.in("campaign_id", assigned.map((a) => a.campaign_id))
  );

  const byCampaign = new Map<string, AdAllocation>();
  for (const row of rows) {
    if (!row.campaign_id) continue;
    const existing = byCampaign.get(row.campaign_id);
    if (!existing) {
      const a = assignmentByCampaign.get(row.campaign_id);
      byCampaign.set(row.campaign_id, {
        campaignId: row.campaign_id,
        campaignName: row.campaign_name,
        source: row.source,
        spend: Number(row.spend),
        daily: [{ date: row.date, spend: Number(row.spend) }],
        lastDate: row.date,
        adAccountName: row.ad_account_name,
        subCategories: a?.sub_categories ?? [],
        categories: a?.categories ?? [],
        isGeneral: a?.is_general ?? false,
      });
    } else {
      existing.spend += Number(row.spend);
      existing.daily.push({ date: row.date, spend: Number(row.spend) });
      if (row.date > existing.lastDate) existing.lastDate = row.date;
      if (!existing.campaignName && row.campaign_name) existing.campaignName = row.campaign_name;
      if (!existing.source && row.source) existing.source = row.source;
      if (!existing.adAccountName && row.ad_account_name) existing.adAccountName = row.ad_account_name;
    }
  }

  // An assignment whose campaign has no ad_spend rows left still shows (spend 0),
  // so it can be corrected or removed rather than being invisible.
  for (const a of assigned) {
    if (byCampaign.has(a.campaign_id)) continue;
    byCampaign.set(a.campaign_id, {
      campaignId: a.campaign_id,
      campaignName: null,
      source: null,
      spend: 0,
      daily: [],
      lastDate: "",
      adAccountName: null,
      subCategories: a.sub_categories ?? [],
      categories: a.categories ?? [],
      isGeneral: a.is_general,
    });
  }

  return [...byCampaign.values()].sort((a, b) => b.spend - a.spend);
}
