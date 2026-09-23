import "server-only";

// What the Income Statement's "Actual" mode reports on.
//
// Both modes now date every order by its Shopify order day (egypt_day). The
// mode changes exactly one thing: WHICH orders contribute at all. Actual counts
// only orders that were physically handed over - to Bosta, or by us to the
// customer. Performance counts every order Shopify took.
//
// Actual used to date by the handover day (bosta_picked_up_day) instead. Two
// problems, one fatal:
//   * An order placed 30 July and collected 2 August sat in July under
//     Performance and August under Actual, so the two views' order counts could
//     never be reconciled against "how many orders came in this month".
//   * bosta_picked_up_day is null on every single order - Bosta's
//     collectedFromBusiness stamp has never come through (see the note in
//     src/lib/sync/bosta-deliveries.ts). Dating by it meant Actual matched no
//     order at all: daily_pnl('actual') returned zero rows and the whole tab
//     was blank.
//
// The `courier` column is no use either - it is owner-entered and has never
// been filled on this store. A Bosta tracking number is the real signal that a
// package left the building; self_delivered is the one case where there is no
// tracking number because we did the handover ourselves.
export type HandoverFields = { bosta_tracking_number: string | null; self_delivered?: boolean | null };

export function isHandedToCourier(o: HandoverFields): boolean {
  return Boolean(o.bosta_tracking_number) || o.self_delivered === true;
}

// The same test as a PostgREST `.or()` filter, for counting in the database
// instead of pulling the rows. Must stay in lockstep with isHandedToCourier
// above and with the `handed_to_courier` expression in
// supabase/daily-pnl-function.sql.
export const HANDED_TO_COURIER_FILTER = "bosta_tracking_number.not.is.null,self_delivered.is.true";
