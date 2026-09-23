// Shopify product status → does this product still belong in the default
// "Active only" views?
//
// UNLISTED matters here: it's what a listing becomes when it's retired and
// replaced by a new one, so an unlisted product sits in the list next to its
// replacement under the same name and reads as a duplicate. It is NOT active.
// Its rows are kept (they carry real historical sales), just hidden by default
// and visible under "All statuses".
const INACTIVE_STATUSES = new Set(["ARCHIVED", "DRAFT", "UNLISTED"]);

// Products seeded before the status sync existed have status = null; treat
// unknown as active so they don't vanish from the default view.
export function isActiveStatus(status: string | null): boolean {
  return status === null || !INACTIVE_STATUSES.has(status);
}
