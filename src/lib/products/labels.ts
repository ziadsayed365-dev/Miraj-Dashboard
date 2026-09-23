// Pure helpers for the Category / Sub Category labels. No "server-only" /
// supabase import here, so the Product List client component can pull the
// runtime function in - catalog.ts itself is server-only and cannot be.

// Labels are Arabic, so sort them with an Arabic collator rather than by code
// point. Unset sorts last, never first.
export function compareLabels(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b, "ar");
}
