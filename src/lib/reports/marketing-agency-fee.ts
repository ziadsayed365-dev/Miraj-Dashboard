import "server-only";
import { supabase } from "@/lib/supabase";

// The marketing agency's billing changed on this date. Before it, the agency
// billed 12.5% of what Miraj spent on ads; from it on, a flat monthly fee the
// owner sets in Settings. The split is by DATE, not by month: the transition
// month (2026-10) keeps the percentage on its days up to the 18th and carries
// the flat fee only from the 19th, so no already-reported day moves.
export const MARKETING_AGENCY_FLAT_FROM = "2026-10-19";

// The old basis: the agency's cut was this share of total marketing (Meta +
// TikTok). Still applied to every day before the switch, forever.
export const MARKETING_AGENCY_FEE_PCT = 0.125;

// The flat monthly fee is spread at month / 30 per day (the owner's convention:
// 50,000/month reads as 1,666.67/day), applied uniformly regardless of how many
// days the calendar month actually has. Deliberately NOT days-in-month, so every
// day from the switch carries the same figure the owner quoted.
export const MARKETING_AGENCY_FEE_DAYS = 30;

// The owner-set flat monthly fee, read from the settings singleton.
export async function getMarketingAgencyFeeMonthly(): Promise<number> {
  const { data, error } = await supabase
    .from("settings")
    .select("marketing_agency_fee_monthly")
    .eq("id", 1)
    .single();
  if (error) throw new Error(`Failed to load settings: ${error.message}`);
  return Number(data?.marketing_agency_fee_monthly ?? 0);
}

export async function setMarketingAgencyFeeMonthly(amount: number): Promise<void> {
  if (!Number.isFinite(amount) || amount < 0) throw new Error("Fee must be zero or a positive number");
  const { error } = await supabase
    .from("settings")
    .update({ marketing_agency_fee_monthly: amount, updated_at: new Date().toISOString() })
    .eq("id", 1);
  if (error) throw new Error(`Failed to save agency fee: ${error.message}`);
}

// The agency fee charged against a single day ("YYYY-MM-DD"): the flat monthly
// fee / 30 on or after the switch date, otherwise the old percentage of that
// day's ad spend. `date` is a plain date string, so the comparison is a safe
// lexical compare.
export function marketingAgencyFeeForDay(date: string, adSpend: number, monthlyFee: number): number {
  return date >= MARKETING_AGENCY_FLAT_FROM
    ? monthlyFee / MARKETING_AGENCY_FEE_DAYS
    : adSpend * MARKETING_AGENCY_FEE_PCT;
}
