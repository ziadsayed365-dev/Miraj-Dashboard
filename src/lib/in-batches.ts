// The other half of the 1000-row cap that `fetchAllRows` handles: a query
// filtered by a long `.in(...)` list. Two ceilings bite there, and both bite
// silently for a bulk upload.
//
//   1. PostgREST still returns at most 1000 rows, so asking about 1,200 order
//      numbers answers for 1000 of them. The uploader can't tell a truncated
//      response from a genuinely missing order, so the overflow was reported
//      as "Not found" - and never updated. Measured against production: 1000
//      numbers -> 1000 rows, 1001 -> 1000 rows, 1250 -> 1000 rows.
//   2. The list goes in the URL, and past roughly 1,270 order numbers the
//      request fails outright before reaching Postgres.
//
// Splitting the keys into batches stays clear of both. 200 keeps each URL
// short and a whole month of returns still resolves in a few seconds.
export const IN_BATCH_SIZE = 200;

export function inBatches<T>(keys: T[], size: number = IN_BATCH_SIZE): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < keys.length; i += size) batches.push(keys.slice(i, i + size));
  return batches;
}
