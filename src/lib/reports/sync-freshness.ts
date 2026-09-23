import "server-only";
import { supabase } from "@/lib/supabase";

// Is the data behind the reports actually up to date?
//
// The reports already refuse to show TODAY (getDailyPnl zeroes it - the day is
// still accruing). What they had no notion of is a day the sync has not REACHED
// yet, which fails in a far worse way: the day still holds whatever was written
// before the walk restarted, so a half-finished day renders as an ordinary,
// complete-looking row. Nothing about "36,786" says "this is 83% of the real
// figure" - so it gets read as fact.
//
// That is not hypothetical. Both syncs were reset on 2026-08-16 to re-walk the
// widened 2025-07-01 history window (scripts/reset-orders-sync.mjs nulls cursor
// AND last_synced_at). Until each walk finishes, nothing newer is ingested at
// all: Shopify pages orders by UPDATED_AT ascending, so the newest orders are
// last in line, and Meta steps forward one day at a time from its floor. Every
// day after the reset point sat frozen and understated - ad spend short by 17%,
// orders short by 13% - with nothing on screen to say so.
//
// So: read the sync cursors and let the UI disclose the state. Deliberately
// NOT part of the cached report (see ./cache.ts) - this is one tiny row read per
// source, and it is the one thing that must never itself be stale.

export type SyncSource = "shopify" | "meta";

const LABELS: Record<SyncSource, string> = {
  shopify: "Shopify orders",
  meta: "Meta ad spend",
};

// The cron runs once a day at 03:00 UTC (Hobby plan - one schedule, see
// vercel.json), so a healthy source completes a pass every ~24h. Past this a
// night has been missed outright, which is its own silent failure.
const STALE_AFTER_HOURS = 36;

export type SourceFreshness = {
  source: SyncSource;
  label: string;
  // No pass has EVER run to completion since the cursor was last reset. While
  // this holds, the source is walking history from its configured floor and the
  // newest days hold pre-reset data - partial, or absent entirely.
  backfilling: boolean;
  // Hours since the last pass that reached the end; null when there has never
  // been one (i.e. backfilling).
  hoursSinceComplete: number | null;
  // Past STALE_AFTER_HOURS with no completed pass - the nightly cron is failing.
  stale: boolean;
  // How far the in-progress walk has got, when the cursor exposes it. Shown so
  // "still going" can be told apart from "wedged" between page loads.
  position: string | null;
};

export type SyncFreshness = {
  sources: SourceFreshness[];
  // Any source mid-backfill or overdue - i.e. the most recent days on every
  // report are understated and must not be read as final.
  degraded: boolean;
};

// How far along a walk is, read out of the source's own cursor format.
//
// Meta stores the plain day it last pulled, so that is the answer directly.
// Shopify stores {since, after}, where `after` is Shopify's OPAQUE page token -
// undocumented, and not a contract to rely on. It currently base64-decodes to
// {"last_id":…,"last_value":"<updated_at>"}, which is genuinely useful to see,
// so decode it defensively and fall back to null the moment it doesn't fit.
function readPosition(source: SyncSource, cursor: string | null): string | null {
  if (!cursor) return null;
  if (source === "meta") return /^\d{4}-\d{2}-\d{2}$/.test(cursor) ? cursor : null;

  try {
    const after = JSON.parse(cursor)?.after;
    if (typeof after !== "string") return null;
    const decoded = JSON.parse(Buffer.from(after, "base64").toString("utf8"));
    const value = decoded?.last_value;
    if (typeof value !== "string") return null;
    return value.slice(0, 10);
  } catch {
    return null; // opaque token in a shape we don't recognise - say nothing
  }
}

export async function getSyncFreshness(): Promise<SyncFreshness> {
  const { data, error } = await supabase
    .from("sync_state")
    .select("source, cursor, last_synced_at")
    .in("source", ["shopify", "meta"]);

  // A banner is a disclosure, never a figure. If the check itself fails, stay
  // quiet rather than papering every report with a warning about the warning.
  if (error) return { sources: [], degraded: false };

  const bySource = new Map((data ?? []).map((r) => [r.source as SyncSource, r]));
  const now = Date.now();

  const sources = (Object.keys(LABELS) as SyncSource[]).map((source): SourceFreshness => {
    const row = bySource.get(source);
    const lastComplete = row?.last_synced_at ? Date.parse(row.last_synced_at) : null;
    const hoursSinceComplete =
      lastComplete !== null && Number.isFinite(lastComplete) ? (now - lastComplete) / 3_600_000 : null;

    return {
      source,
      label: LABELS[source],
      backfilling: hoursSinceComplete === null,
      hoursSinceComplete,
      stale: hoursSinceComplete !== null && hoursSinceComplete > STALE_AFTER_HOURS,
      position: readPosition(source, row?.cursor ?? null),
    };
  });

  return { sources, degraded: sources.some((s) => s.backfilling || s.stale) };
}
