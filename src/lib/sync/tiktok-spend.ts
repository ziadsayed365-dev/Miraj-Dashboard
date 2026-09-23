import "server-only";
import { supabase } from "@/lib/supabase";
import {
  fetchTikTokAdvertisers,
  fetchTikTokCampaignSpend,
  getTikTokAdvertiserIds,
  isTikTokApiConfigured,
} from "@/lib/tiktok";
import { egyptToday, addDays } from "@/lib/dates";
import { reapplyCampaignAllocations } from "@/lib/sync/campaign-allocations";

const TIME_BUDGET_MS = 45_000; // leave headroom under Vercel's 60s function limit
const RECHECK_DAYS = 3; // re-pull the last few days each run, same as Meta, for TikTok's late spend corrections
const CHUNK_DAYS = 30; // TikTok's max range for a daily-breakdown report

type SyncResult = {
  ok: boolean;
  skipped?: boolean;
  daysProcessed: number;
  rowsUpserted: number;
  reachedEnd: boolean;
  warnings?: string[];
  error?: string;
};

// Pulls TikTok campaign spend into ad_spend with source='tiktok', one row per
// campaign per day - the same shape as Meta's rows, so the campaigns go through
// the same allocation popup and land on the P&L's TikTok line.
//
// Replaces the hand-typed popup only FROM TIKTOK_SPEND_SINCE onward. Days before
// it keep the figures the owner typed in: those P&Ls have already been sent to
// the client, and re-pulling them from the API would restate them.
export async function syncTikTokSpend(): Promise<SyncResult> {
  const startedAt = Date.now();

  // Not set up yet -> a no-op, not a failure. TikTok keeps using the manual
  // popup, and the nightly cron must not go red over an integration that was
  // never switched on.
  if (!isTikTokApiConfigured()) {
    return { ok: true, skipped: true, daysProcessed: 0, rowsUpserted: 0, reachedEnd: true };
  }

  try {
    const since = process.env.TIKTOK_SPEND_SINCE;
    if (!since || !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
      // Deliberately no fallback to "earliest order": that would overwrite
      // every hand-entered TikTok day already reported to the client.
      throw new Error("Set TIKTOK_SPEND_SINCE (YYYY-MM-DD) - the first day the API replaces the manual TikTok entries");
    }

    const advertiserIds = getTikTokAdvertiserIds();
    const advertisers = await fetchTikTokAdvertisers(advertiserIds);
    const missing = advertiserIds.filter((id) => !advertisers.some((a) => a.id === id));
    if (missing.length > 0) {
      throw new Error(`TikTok token cannot see advertiser(s): ${missing.join(", ")}`);
    }

    // Every figure in the P&L is EGP. Silently storing a USD account's spend as
    // EGP would understate TikTok ~50x, so refuse instead.
    const wrongCurrency = advertisers.filter((a) => a.currency && a.currency !== "EGP");
    if (wrongCurrency.length > 0) {
      throw new Error(
        `TikTok advertiser(s) not billed in EGP: ${wrongCurrency.map((a) => `${a.id} (${a.currency})`).join(", ")}`
      );
    }

    // TikTok cuts days at the account's own timezone. Anything but Cairo shifts
    // spend across the day boundary against orders.egypt_day - worth flagging,
    // not worth failing the sync over.
    const warnings = advertisers
      .filter((a) => a.timezone && a.timezone !== "Africa/Cairo")
      .map((a) => `TikTok advertiser ${a.id} reports in ${a.timezone}, not Africa/Cairo - days may be shifted`);

    const { data: state, error: stateErr } = await supabase
      .from("sync_state")
      .select("*")
      .eq("source", "tiktok")
      .single();
    if (stateErr) throw new Error(`Failed to read sync_state: ${stateErr.message}`);

    let cursor: string = state?.cursor ?? since;
    // Already caught up once -> re-check the last few days. Never during the
    // first backfill, for the same reason as the Meta sync: it would trap the
    // cursor.
    if (state?.cursor && state?.last_synced_at) cursor = addDays(state.cursor, -RECHECK_DAYS);
    // Never reach back past the cut-over, whatever the cursor says.
    if (cursor < since) cursor = since;

    const today = egyptToday();
    let daysProcessed = 0;
    let rowsUpserted = 0;
    let from = cursor;

    while (from <= today) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) break;

      const to = addDays(from, CHUNK_DAYS - 1) < today ? addDays(from, CHUNK_DAYS - 1) : today;

      // All advertisers for the SAME range before anything is written, so a
      // chunk is never left half-synced if one account's request fails.
      const rows: Record<string, unknown>[] = [];
      const syncedAt = new Date().toISOString();
      for (const advertiser of advertisers) {
        const spend = await fetchTikTokCampaignSpend(advertiser.id, from, to);
        for (const r of spend) {
          rows.push({
            date: r.date,
            // Prefixed: ad_spend is unique on (date, campaign_id) across BOTH
            // sources, and TikTok ids are bare numbers like Meta's. Also keeps
            // them apart from the manual popup's synthetic "tiktok:<group>" keys.
            campaign_id: `tiktok_${r.campaign_id}`,
            campaign_name: r.campaign_name,
            spend: r.spend,
            currency: "EGP",
            source: "tiktok",
            segment: "retail",
            ad_account_id: advertiser.id,
            // Shown in the allocation popup - makes it obvious the campaign is a
            // TikTok one before choosing where its spend goes.
            ad_account_name: `TikTok - ${advertiser.name ?? advertiser.id}`,
            synced_at: syncedAt,
          });
        }
      }

      // Any hand-typed TikTok entry in this range is superseded by the API's
      // figures - keeping both would count the day's TikTok spend twice. Only
      // ever inside [since, today], so reported manual days are never touched.
      const { error: delErr } = await supabase
        .from("ad_spend")
        .delete()
        .eq("source", "tiktok")
        .like("campaign_id", "tiktok:%")
        .gte("date", from)
        .lte("date", to);
      if (delErr) throw new Error(`Failed to clear manual TikTok rows ${from}..${to}: ${delErr.message}`);

      if (rows.length > 0) {
        const { error: upsertErr } = await supabase.from("ad_spend").upsert(rows, { onConflict: "date,campaign_id" });
        if (upsertErr) throw new Error(`Failed to upsert TikTok ad_spend ${from}..${to}: ${upsertErr.message}`);
        rowsUpserted += rows.length;
      }

      await supabase
        .from("sync_state")
        .update({ cursor: to, updated_at: new Date().toISOString() })
        .eq("source", "tiktok");

      for (let d = from; d <= to; d = addDays(d, 1)) daysProcessed++;
      from = addDays(to, 1);
    }

    const reachedEnd = from > today;
    if (reachedEnd) {
      await supabase
        .from("sync_state")
        .update({ last_synced_at: new Date().toISOString() })
        .eq("source", "tiktok");
    }

    await reapplyCampaignAllocations();

    return { ok: true, daysProcessed, rowsUpserted, reachedEnd, ...(warnings.length ? { warnings } : {}) };
  } catch (err) {
    return {
      ok: false,
      daysProcessed: 0,
      rowsUpserted: 0,
      reachedEnd: false,
      error: err instanceof Error ? err.message : "unknown error",
    };
  }
}
