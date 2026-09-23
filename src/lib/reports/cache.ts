import { revalidateTag } from "next/cache";

// Shared cache settings for the expensive report reads (Income Statement and
// Analysis by Product).
//
// Why these are cached at all: every page is `force-dynamic` (they read the
// session cookie), and they ask for the full history on each load, so a plain
// refresh used to re-run the whole report against Supabase. The numbers only
// change when a sync writes new rows, so serving a slightly stale report for a
// short window is free in practice and removes the repeat cost entirely.
//
// Every route that writes a figure the reports read now drops this cache on
// save (revalidateTag below), so the window is a backstop rather than the way
// changes surface - a save shows up immediately, not when the timer expires.

export const REPORT_CACHE_SECONDS = 900;

/** Lets any write that moves a reported figure drop every report at once. */
export const REPORT_CACHE_TAG = "reports";

/**
 * Drop every cached report. Call after ANY write that changes a number the
 * Income Statement or Analysis by Product shows - not just row writes, but the
 * engine steps too: a margin recompute or a delivery-rate finalize changes what
 * every page displays without touching a single order row.
 *
 * `{ expire: 0 }` rather than the docs' recommended `"max"`: "max" is
 * stale-while-revalidate, which would still serve the PRE-change numbers on the
 * first load afterwards - exactly the "nothing happened" the owner sees.
 * Expiring outright makes the next load fetch fresh.
 */
export function dropReportCache(): void {
  revalidateTag(REPORT_CACHE_TAG, { expire: 0 });
}
