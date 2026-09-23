import "server-only";
import { supabase } from "@/lib/supabase";

// Owner-entered monthly P&L lines. Keyed by `${YYYY-MM}|${account}`.
export async function getManualExpenses(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const { data, error } = await supabase.from("monthly_manual_expenses").select("month, account, amount");
  if (error) return map; // table not created yet -> everything reads as 0
  for (const r of (data ?? []) as { month: string; account: string; amount: number }[]) {
    map.set(`${String(r.month).slice(0, 7)}|${r.account}`, Number(r.amount));
  }
  return map;
}
