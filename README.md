# Miraj Dashboard

COD e-commerce finance dashboard: Shopify orders in, Bosta/Movers delivery
outcomes and Meta/TikTok ad spend layered on, out the other end an Income
Statement, per-product margin analysis and an expense ledger.

Cloned from the Tawbah dashboard. Same engine, Miraj's own store, courier
account, ad account and database.

## Stack

Next.js 16 (App Router) · React 19 · Tailwind 4 · Supabase (Postgres) ·
deployed on Vercel.

> **Next.js 16 note:** see `AGENTS.md`. This version has breaking changes from
> older App Router conventions — check `node_modules/next/dist/docs/` before
> assuming an API still exists. Auth middleware lives in `src/proxy.ts`, not
> `middleware.ts`.

## Bring-up checklist

1. **Install dependencies** — `npm install` (needs Node 20.11+).

2. **Create Miraj's Supabase project.** Miraj gets a dedicated project, so its
   tables live in `public` and `SUPABASE_SCHEMA` stays unset.

3. **Fill in `.env.local`.** Every key is listed there with a TODO. `CRON_SECRET`
   and `SESSION_SECRET` are already generated. Nothing syncs until the Shopify,
   Bosta and Meta credentials are real.

4. **Build the schema:**

   ```bash
   DATABASE_URL='postgresql://...' npm run db:setup
   ```

   Runs `supabase/miraj-setup.sql` (base 18 tables + 4 RPCs), then migrations
   `0034`–`0058` in order. **This drops and recreates `public`** — only point it
   at Miraj's own project. Migrations `0001`–`0033` are skipped on purpose: the
   base file is already their end state.

5. **Verify the Meta credentials** before trusting any sync:

   ```
   powershell -ExecutionPolicy Bypass -File scripts\verify-meta.ps1
   ```

   Read-only. Checks the token can see every configured ad account and read its
   insights, and warns if an account's currency isn't EGP.

6. **Confirm the tuning defaults** in the `settings` row — see below.

7. **Seed the Bosta rate card** — `node scripts/seed-bosta-fees.mjs`, after
   checking the prices match Miraj's actual Bosta contract.

8. **First sync** — log in as `OWNER_USERNAME`, hit Sync, then create the real
   staff/owner accounts at `/settings`.

9. **Deploy** — see below. Already done.

## Deployment

| | |
| --- | --- |
| URL | **https://miraj-dashboard.vercel.app** |
| Project | `ziadsayed365-3403s-projects/miraj-dashboard` |
| Region | `fra1` (Frankfurt) — pinned in `vercel.json` |
| Plan | Hobby |
| Cron | `/api/cron/daily`, 03:00 UTC |

**Region matters.** Supabase is in `eu-central-1`, so functions are pinned to
`fra1`. Running the sync from a laptop instead measured a 101 ms round trip per
database call, and the order sync makes ~2 sequential calls per order — which
made a full backfill roughly 2.5x slower. Keep them co-located.

**Deployment Protection** is `all_except_custom_domains`, matching every sibling
dashboard. That protects preview and *generated* deployment URLs
(`miraj-dashboard-<hash>-...vercel.app`) behind Vercel SSO, while leaving the
production alias above publicly reachable — where the app's own login takes over
(`src/proxy.ts` fails closed and redirects to `/login`).

So automation must target the **production alias**, never a generated URL.

**Pushing env vars:** feed values from a file, not a PowerShell pipe. The pipe
terminates with CRLF; Vercel strips the `\n` and keeps the `\r`, which fails the
deploy on `CRON_SECRET` ("whitespace not allowed in HTTP header values") and
silently corrupts every other secret. See `scripts/` history if this recurs.

**Hobby plan limits:** one cron job, once per day. The nightly `0 3 * * *` fits
exactly, with no room for a second schedule without upgrading.

## Meta ad accounts and the wholesale segment

Miraj runs **four** Meta ad accounts: three retail, one wholesale. They are
configured as two lists in `.env.local`, under a single System User token that
must have a role on all four:

```
META_RETAIL_AD_ACCOUNT_IDS=111...,222...,333...
META_WHOLESALE_AD_ACCOUNT_IDS=444...
```

Bare numeric ids, no `act_` prefix — `src/lib/meta.ts` adds it. Which list an
account sits in is the *only* thing that decides its segment, so moving an
account between segments needs no code change.

Every `ad_spend` row is stamped with `segment` (`retail` | `wholesale`) and
`ad_account_id` at sync time. The three retail accounts **pool** into one retail
figure; `ad_account_id` is kept for traceability, not as a reporting dimension.

**Current state of the split:**

| | Status |
| --- | --- |
| Wholesale ad spend ingested and tagged | done |
| Wholesale spend kept out of the retail P&L | done — every report filters on `REPORTED_AD_SEGMENT` |
| Wholesale **sales** (hand-recorded, like Chat Orders) | not built |
| Global Retail / Wholesale / All toggle | not built |

Until the last two land, wholesale spend accumulates in the database but appears
in no report. That is deliberate: a wholesale ad-spend line with no wholesale
revenue beside it would read as pure loss. The single constant
`REPORTED_AD_SEGMENT` in `src/lib/ad-segment.ts` is what the reports stop
hardcoding and start taking as a parameter when the toggle is built.

Wholesale ads are also held back from the ad-allocation popup, so they can't be
mapped onto a retail model by mistake.

## Current state (2026-08-08)

Live and running unattended on the nightly cron. **Figures below are the
2026-01-01-onward snapshot taken before the window was widened to 2025-07-01 —
they undercount until that backfill has run.**

| | |
| --- | --- |
| Orders | 35,299 (2026-01-01 onward), 24,234 delivered |
| Line items | 67,755 — 10 unmapped (deleted Shopify products) |
| Products | 147, 196 variants |
| Revenue | 20,895,230 EGP |
| Retail ad spend | 6,867,376 EGP, 17 campaigns |
| Wholesale ad spend | 65,199 EGP, 3 campaigns, excluded from the P&L |

A full cron run takes ~38s, comfortably inside the 300s limit.

### Three things block a trustworthy P&L

1. **No product costs.** 0 of 147 products are costed, so COGS is ~0 and every
   margin is meaningless. Costs come from the BOM (Product List → components).
   After entering them, force a full recompute — the engine only looks back 60
   days by default:
   `GET /api/engine/compute-margins?since=all` with the `CRON_SECRET` bearer.
2. **No `BOSTA_API_KEY`.** Courier fees are ~0. Delivery *outcomes* still arrive
   via Shopify fulfillments, so orders do resolve — but what Bosta charges does
   not. The nightly cron logs `Missing BOSTA_API_KEY` and skips the step.
3. **No model groups.** All 17 retail campaigns sit unallocated, so ad spend
   cannot be attributed per product. Create models, then use the allocation
   popup.

Until 1 and 3 are done, calibration and the rate finalizers no-op
(`modelsCalibrated: 0`), which is expected rather than broken.

## Values to confirm before trusting the numbers

These carried over from Tawbah and are **Tawbah's**, not Miraj's:

| Where | What | Default |
| --- | --- | --- |
| `settings.packing_cost_per_unit` | Packing cost per item, hits every margin | `12` |
| `settings.vat_multiplier` | VAT on courier fees | `1.14` |
| `settings.refund_rate_default` / `damage_rate_default` | Pre-calibration assumptions | `0.03` |
| `settings.default_success_rate_estimate` | Used until calibration has a sample | `0.70` |
| `settings.default_box_size_tier` | Drives which Bosta fee column applies | `Small & Medium` |
| `settings.bosta_open_package_fee` | Open-package fee | `7.00` |
| `bosta_fee_matrix` | The whole zone × size price grid | Tawbah's contract |
| `account_types` | Chart of accounts for Record Data | Tawbah's accounts |
## History window — decided

Miraj's dashboard history starts **2025-07-01** (widened from 2026-01-01 on
2026-08-16). Seven settings encode that and must move together, or data gets
stranded:

| Setting | Value |
| --- | --- |
| `SHOPIFY_ORDERS_SINCE` (`.env.local` **and Vercel**) | `2025-07-01` |
| `META_SPEND_SINCE` (`.env.local` **and Vercel**) | `2025-07-01` |
| `BACKLOG_CUTOFF` (`src/lib/reports/ad-allocation.ts`) | `2025-07-01` |
| `EXPENSE_CUTOVER_MONTH` (`src/lib/pnl-fixed-expenses.ts`) | `2025-07` |
| `MONTHLY_START` (`src/lib/bosta/delivery-rate.ts`) | `2025-07` |
| `MONTHLY_START` (`src/app/(app)/monthly-table.tsx`) | `2025-07` |
| `MONTHLY_START` (`src/app/(app)/expense-analysis-tab.tsx`) | `2025-07` |

The first four gate what gets *ingested and attributable*; the three
`MONTHLY_START` constants gate what the month-by-month views will *display*.
Moving only the first four ingests the data and then hides it.

**Still deliberately excluded**, and in the source systems if ever wanted:

- Shopify orders created before 2025-07-01, back to #1001 (2024-12-30)
- Meta spend on *Miraj - Rugs* between 2025-04-29 and 2025-06-30

Widening the window means moving all seven settings, **pushing the two env vars
to Vercel** (production reads Vercel's copy, not `.env.local`), **and** resetting
the sync cursors so the backfill re-runs — neither the Shopify nor the Meta sync
reaches back past its own cursor:

```bash
DATABASE_URL='postgresql://...' node scripts/reset-orders-sync.mjs
```

Then run the sync repeatedly until each source reports `reachedEnd` — one pass
is time-budgeted and will not finish a backfill this size. Finally force a full
margin recompute: `GET /api/engine/compute-margins?since=all`.

Tawbah's hardcoded monthly overhead workbook has been **emptied** — Miraj's
overheads all come from what the owner records in the app. Only repopulate
`FIXED_MONTHLY_EXPENSES` if the owner supplies overheads for months predating
their use of the dashboard.

## Known quirk inherited from the clone chain

The **manual Sync button** runs `shopify → shopify-products → meta → calibrate →
monthly-rate → sku-monthly-rate → margins`. It has **no `bosta` step**, because
the dashboard this lineage started from used a courier that reported through
Shopify fulfillments. The nightly cron *does* sync Bosta.

So a manual sync refreshes orders and ad spend but **not** delivery outcomes —
those land on the next nightly run. If Miraj wants the button to pull the
courier too, add `"bosta"` to `STEPS` in both `src/app/api/sync/run/route.ts`
and `src/app/(app)/sync-button.tsx`.

## Layout

```
src/app/(app)/      dashboard pages + tab components
src/app/api/        route handlers (sync, cron, CRUD, engine)
src/app/print/      print-only income statement
src/lib/engine/     margin, calibration, monthly-rate computation
src/lib/reports/    P&L, per-product, expense ledger aggregation
src/lib/sync/       Shopify / Bosta / Meta pulls
src/proxy.ts        auth gate (Next 16 middleware)
supabase/           miraj-setup.sql + numbered migrations
scripts/            one-off maintenance + db setup
```

## Scripts

```bash
npm run dev            # dev server
npm run build          # production build
npm run lint
npm run db:setup       # base schema + migrations (see above)
npm run verify-routes  # smoke-check every route responds
```

Single migration against a live database:

```bash
DATABASE_URL='postgresql://...' node scripts/apply-migration.mjs supabase/migrations/00XX_name.sql
```

## Auth

Two roles. `owner` sees everything; `staff` is limited to `STAFF_ALLOWED_PATHS`
in `src/lib/auth.ts`. Accounts live in the `users` table and are managed at
`/settings`; the `OWNER_USERNAME`/`OWNER_PASSWORD` env pair is a break-glass
login that works even if that table is empty or broken.
