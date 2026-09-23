import "server-only";
import { supabase } from "@/lib/supabase";
import { fetchMetaAdInsights, fetchMetaAdsetInsights, fetchAdAccountNames } from "@/lib/meta";
import { getMetaAdAccounts, type AdSegment } from "@/lib/meta-accounts";
import { ADSET_LEVEL_CAMPAIGNS } from "@/lib/ad-split";
import { egyptToday } from "@/lib/dates";
import { reapplyCampaignAllocations } from "@/lib/sync/campaign-allocations";

const TIME_BUDGET_MS = 45_000; // leave headroom under Vercel's 60s function limit
const RECHECK_DAYS = 3; // re-pull the last few days each run to catch Meta's attribution corrections

type SyncResult = {
  ok: boolean;
  daysProcessed: number;
  rowsUpserted: number;
  reachedEnd: boolean;
  error?: string;
};

function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return toDateString(d);
}

export async function syncMetaSpend(): Promise<SyncResult> {
  const startedAt = Date.now();

  try {
    // Throws on a misconfigured env (non-numeric id, an account listed in both
    // segments) rather than silently syncing spend into the wrong segment.
    const accounts = getMetaAdAccounts();

    // Resolved once per run, not per day: the allocation popup labels each
    // campaign with the account it ran in, and an account is renamed rarely
    // enough that re-reading it every sync is plenty fresh. A failure here must
    // not stop the spend sync, so an unnamed account just stays null.
    const accountNames = await fetchAdAccountNames(accounts.map((a) => a.id));

    const { data: state, error: stateErr } = await supabase
      .from("sync_state")
      .select("*")
      .eq("source", "meta")
      .single();
    if (stateErr) throw new Error(`Failed to read sync_state: ${stateErr.message}`);

    let cursor = state?.cursor ?? null;

    if (!cursor) {
      // Start the very first backfill from META_SPEND_SINCE if set (e.g. to pull
      // spend history from before the Shopify store existed), else from the
      // earliest order date, else the last 90 days.
      const floor = process.env.META_SPEND_SINCE;
      if (floor) {
        cursor = floor;
      } else {
        const { data: earliestOrder } = await supabase
          .from("orders")
          .select("order_created_at")
          .order("order_created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        cursor = earliestOrder ? toDateString(new Date(earliestOrder.order_created_at)) : addDays(toDateString(new Date()), -90);
      }
    } else if (state?.last_synced_at) {
      // Already caught up once -> re-check the last few days in case Meta
      // revised the spend figures. Only do this rollback once we've reached
      // the end at least once; during the initial backfill it must NOT roll
      // back, or a day whose ad volume exceeds the time budget traps the
      // cursor and it never advances.
      cursor = addDays(cursor, -RECHECK_DAYS);
    }

    // Sync through today (Egypt day, matching orders.egypt_day) rather than
    // stopping at yesterday - today's figure is provisional and will keep
    // getting corrected by the RECHECK_DAYS window on later runs, the same
    // way Meta's own attribution corrections are handled. (The dashboard hides
    // the open day at the reporting layer - see getDailyPnl - so the sync
    // itself deliberately stays normal and keeps the DB complete.)
    const today = egyptToday();

    let daysProcessed = 0;
    let rowsUpserted = 0;
    let reachedEnd = false;
    let date = cursor;

    while (date <= today) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) break;

      // Every account is pulled for the SAME day before the cursor advances, so
      // a day is never left half-synced (retail written, wholesale missing) if
      // the time budget runs out mid-loop.
      const spendRows: {
        key: string;
        name: string | null;
        date: string;
        spend: string;
        segment: AdSegment;
        accountId: string;
      }[] = [];

      for (const account of accounts) {
        // Campaign-level: Miraj maps one campaign per product, so campaign_id is
        // the allocation key and campaign_name is what the popup displays.
        // ad_spend is unique on (date, campaign_id), and ad_model_assignments
        // maps campaign_id -> model.
        //
        // Campaign and ad set ids are unique across all of Meta, not just
        // within an account, so pooling several accounts into one table cannot
        // collide on that unique key.
        const rows = await fetchMetaAdInsights(account.id, date, date);
        for (const row of rows) {
          // ADSET_LEVEL_CAMPAIGNS come back below as one row per ad set - taking
          // the campaign row too would double the spend for that day.
          if (ADSET_LEVEL_CAMPAIGNS.has(row.campaign_id)) continue;
          spendRows.push({
            key: row.campaign_id,
            name: row.campaign_name ?? null,
            date: row.date_start,
            spend: row.spend,
            segment: account.segment,
            accountId: account.id,
          });
        }

        // Ad-set-level for the split campaigns: the ad set id takes the place of
        // the campaign id, so each ad set becomes its own allocation decision.
        // The name is prefixed with the campaign so it stays recognisable in the
        // allocation popup.
        const adsetRows = await fetchMetaAdsetInsights(account.id, date, date, [...ADSET_LEVEL_CAMPAIGNS]);
        for (const row of adsetRows) {
          spendRows.push({
            key: row.adset_id,
            name: [row.campaign_name, row.adset_name].filter(Boolean).join(" - ") || null,
            date: row.date_start,
            spend: row.spend,
            segment: account.segment,
            accountId: account.id,
          });
        }
      }

      // One upsert for the whole day rather than one per row - a day is ~20
      // rows and the round trips alone were most of the function's runtime.
      if (spendRows.length > 0) {
        const syncedAt = new Date().toISOString();
        const { error: upsertErr } = await supabase.from("ad_spend").upsert(
          spendRows.map((row) => ({
            date: row.date,
            campaign_id: row.key,
            campaign_name: row.name,
            spend: row.spend,
            currency: "EGP",
            source: "meta",
            segment: row.segment,
            ad_account_id: row.accountId,
            // Shown in the allocation popup, so it is obvious which business
            // line a campaign's spend came from before choosing where it goes.
            ad_account_name: accountNames.get(row.accountId) ?? null,
            synced_at: syncedAt,
          })),
          { onConflict: "date,campaign_id" }
        );
        if (upsertErr) throw new Error(`Failed to upsert ad_spend for ${date}: ${upsertErr.message}`);
        rowsUpserted += spendRows.length;
      }

      daysProcessed++;
      await supabase
        .from("sync_state")
        .update({ cursor: date, updated_at: new Date().toISOString() })
        .eq("source", "meta");

      date = addDays(date, 1);
    }

    if (date > today) {
      reachedEnd = true;
      await supabase
        .from("sync_state")
        .update({ last_synced_at: new Date().toISOString() })
        .eq("source", "meta");
    }

    // Stamp standing campaign pins onto the days just synced - see
    // reapplyCampaignAllocations for why this runs on every pass.
    await reapplyCampaignAllocations();

    return { ok: true, daysProcessed, rowsUpserted, reachedEnd };
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
