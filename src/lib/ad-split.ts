// Campaigns that must be allocated AD SET by AD SET instead of as one lump.
//
// Meta spend is normally tracked one row per campaign per day, because a
// campaign here maps to a single product. An ABO testing campaign breaks that
// assumption: each ad set inside it pushes a different product, so allocating
// the campaign to one model would misattribute every other ad set's spend.
//
// For a campaign listed here the sync stores one ad_spend row per AD SET, with
// the ad set id written into campaign_id, so the existing ad_model_assignments
// mechanism pins each ad set to its own model with no schema change. The
// campaign-level row is never written for these, or the spend would be counted
// twice. (campaign_id therefore means "the thing being allocated" - the
// campaign, unless that campaign is deliberately split here.)
// Empty for Miraj: campaign ids are account-specific, so a sibling client's ids
// mean nothing here. Add Miraj's own ABO/testing campaign ids as they appear -
// you can copy an id straight from the Meta Ads Manager URL, or from the
// unallocated rows in the ad-allocation popup. While this is empty the sync
// skips the ad-set request entirely (see fetchMetaAdsetInsights).
//
// This list spans ALL of Miraj's ad accounts (retail and wholesale). Campaign
// ids are globally unique, so there is no ambiguity - but the sync applies the
// filter to every account, and an account that owns none of these campaigns
// just returns nothing. Harmless, one wasted request per account per day; only
// worth splitting per-account if this list grows large.
export const ADSET_LEVEL_CAMPAIGNS = new Set<string>([]);
