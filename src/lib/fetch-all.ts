import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

const PAGE_SIZE = 1000;
// How many pages to fetch concurrently. Sequential pagination over ~90k rows
// meant ~90 serial round-trips; fetching in parallel waves collapses that to a
// handful. Kept modest so we don't exhaust the connection pool.
const CONCURRENCY = 8;

// Supabase/PostgREST caps results at 1000 rows per request. This paginates with
// a stable order and fetches pages in parallel waves. Meant for report reads
// where the data isn't changing mid-load; the stable order keeps each fixed
// offset consistent across the wave.
export async function fetchAllRows<T>(
  supabase: SupabaseClient,
  table: string,
  selectClause: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic query-builder callback, no narrower type available across all callers
  applyFilters?: (query: any) => any,
  orderBy: string[] = ["id"] // must be a key (or combination) that's unique across all rows, or pagination can skip/duplicate rows
): Promise<T[]> {
  const fetchPage = async (from: number): Promise<T[]> => {
    let query = supabase.from(table).select(selectClause);
    if (applyFilters) query = applyFilters(query);
    for (const col of orderBy) query = query.order(col, { ascending: true });
    const { data, error } = await query.range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Failed to fetch ${table}: ${error.message}`);
    return (data ?? []) as T[];
  };

  const rows: T[] = [];
  let base = 0;
  let done = false;
  while (!done) {
    const wave = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) => fetchPage(base + i * PAGE_SIZE))
    );
    for (const page of wave) {
      rows.push(...page);
      if (page.length < PAGE_SIZE) done = true; // a short/empty page means we've reached the end
    }
    base += CONCURRENCY * PAGE_SIZE;
  }
  return rows;
}
