import { getSyncFreshness, type SourceFreshness } from "@/lib/reports/sync-freshness";

// Shown on every report page (rendered from the layout) whenever a sync has not
// caught up. Renders NOTHING in the healthy case - the point is to break the
// silence when the most recent days are understated, not to add a permanent
// ornament. See src/lib/reports/sync-freshness.ts for why this exists.

function describe(s: SourceFreshness): string {
  if (s.backfilling) {
    return s.position
      ? `re-reading history, currently at ${s.position}`
      : "re-reading history — the newest records are reached last";
  }
  const hours = Math.round(s.hoursSinceComplete ?? 0);
  return `last completed ${hours} hours ago`;
}

export async function SyncFreshnessBanner() {
  const { sources, degraded } = await getSyncFreshness();
  if (!degraded) return null;

  const affected = sources.filter((s) => s.backfilling || s.stale);

  return (
    <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <p className="font-semibold">The most recent days are incomplete</p>
      <ul className="mt-1.5 space-y-0.5 text-amber-800">
        {affected.map((s) => (
          <li key={s.source}>
            <span className="font-medium">{s.label}</span> — {describe(s)}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-amber-700">
        Until this finishes, ad spend, orders and items sold for the latest days are understated — treat them as partial,
        not final. Earlier days are unaffected. The figures correct themselves once the sync catches up.
      </p>
    </div>
  );
}
