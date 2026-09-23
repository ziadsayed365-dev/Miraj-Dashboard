// Flat monthly fixed-expense figure. Used by the daily Income Statement view
// (spread as amount/daysInMonth per day) and the by-product fixed-cost
// allocation. Kept in a plain module (no "use client" / "server-only") so both
// client and server components can read the actual value rather than a client
// reference across the RSC boundary.
export const MONTHLY_FIXED_EXPENSES = 900_000;
