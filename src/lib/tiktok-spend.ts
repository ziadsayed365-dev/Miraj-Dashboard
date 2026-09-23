import "server-only";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";
import { egyptToday, daysAgo, addDays } from "@/lib/dates";
import { isTikTokApiConfigured } from "@/lib/tiktok";

// TikTok spend is entered by hand in a daily popup until the Marketing API sync
// (src/lib/sync/tiktok-spend.ts) is configured, and for every day before its
// TIKTOK_SPEND_SINCE cut-over after that. Each entry is an amount tagged to a product/model, or
// "General" (modelGroupId null) meaning it applies across all products. Stored
// in ad_spend with source='tiktok' so it flows into the P&L TikTok line exactly
// like Meta's synced rows.
export type TikTokEntry = { amount: number; modelGroupId: number | null };

const LOOKBACK_DAYS = 14;

// Recent days (last LOOKBACK_DAYS, up to yesterday) that have no TikTok row yet
// — the popup prompts the owner to fill these. Today is excluded (still open).
export async function getMissingTikTokDays(): Promise<string[]> {
  const start = daysAgo(LOOKBACK_DAYS);
  const yesterday = addDays(egyptToday(), -1);

  const rows = await fetchAllRows<{ date: string }>(
    supabase,
    "ad_spend",
    "id, date, source",
    (q) => q.eq("source", "tiktok").gte("date", start).lte("date", yesterday)
  );
  const have = new Set(rows.map((r) => r.date));

  // Once the API sync is on, days from its cut-over are its job - a day with no
  // TikTok rows there means no spend (or no sync yet), not a forgotten entry.
  const apiFrom = isTikTokApiConfigured() ? process.env.TIKTOK_SPEND_SINCE : undefined;

  const missing: string[] = [];
  for (let d = start; d <= yesterday; d = addDays(d, 1)) {
    if (apiFrom && d >= apiFrom) break;
    if (!have.has(d)) missing.push(d);
  }
  return missing;
}

// Replaces a day's TikTok rows with the submitted entries (summing any that
// share a group). An empty submission writes a single zero row so the day is
// recorded as "done" and stops being prompted.
export async function saveTikTokSpend(date: string, entries: TikTokEntry[]): Promise<void> {
  // Only the hand-typed rows ("tiktok:<group>"), never the API sync's
  // "tiktok_<campaign>" rows for the same day.
  await supabase.from("ad_spend").delete().eq("source", "tiktok").like("campaign_id", "tiktok:%").eq("date", date);

  const byGroup = new Map<string, { modelGroupId: number | null; amount: number }>();
  for (const e of entries) {
    const amount = Number(e.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const key = e.modelGroupId == null ? "general" : String(e.modelGroupId);
    const cur = byGroup.get(key) ?? { modelGroupId: e.modelGroupId ?? null, amount: 0 };
    cur.amount += amount;
    byGroup.set(key, cur);
  }

  const now = new Date().toISOString();
  const rows =
    byGroup.size === 0
      ? [{ date, source: "tiktok", campaign_id: "tiktok:none", campaign_name: "TikTok (no spend)", model_group_id: null, spend: 0, currency: "EGP", synced_at: now }]
      : [...byGroup.entries()].map(([key, v]) => {
          // Synthetic campaign id: TikTok spend is typed in by hand, so there is
          // no real campaign to key on. One per model group per day, which is
          // what makes (date, campaign_id) unique for these rows too.
          const id = `tiktok:${key}`;
          return {
            date,
            source: "tiktok",
            campaign_id: id,
            campaign_name: v.modelGroupId == null ? "TikTok - General" : `TikTok - ${v.modelGroupId}`,
            model_group_id: v.modelGroupId,
            spend: v.amount,
            currency: "EGP",
            synced_at: now,
          };
        });

  const { error } = await supabase.from("ad_spend").upsert(rows, { onConflict: "date,campaign_id" });
  if (error) throw new Error(`Failed to save TikTok spend: ${error.message}`);
}
