import "server-only";
import { supabase } from "@/lib/supabase";

// The "record data synced" marker. A cutoff timestamp on settings: report views
// (the Shipping Orders / Movers report) only reflect entries last touched at or
// before it, so new/edited entries wait for the next Sync rather than shifting a
// report mid-review. Advanced by the sync pipeline (cron/daily + sync/run).
export async function getRecordDataSyncedAt(): Promise<string | null> {
  const { data, error } = await supabase.from("settings").select("record_data_synced_at").eq("id", 1).single();
  if (error) throw new Error(`Failed to load settings: ${error.message}`);
  return data?.record_data_synced_at ?? null;
}

export async function markRecordDataSynced(): Promise<void> {
  const { error } = await supabase
    .from("settings")
    .update({ record_data_synced_at: new Date().toISOString() })
    .eq("id", 1);
  if (error) throw new Error(`Failed to update settings: ${error.message}`);
}
