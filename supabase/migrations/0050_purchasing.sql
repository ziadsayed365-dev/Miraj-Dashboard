-- Purchasing: record what was paid for a component or a finished product, on a
-- date, and let it drive that item's current cost.
--
-- A purchase targets EITHER a catalog component (raw material / package /
-- sticker / other - what is normally bought) OR a finished product. Exactly one
-- of component_id / product_id is set.
--
--   component -> product_components.cost is updated, and every product whose BOM
--                uses that component re-costs automatically through the rollup.
--   product   -> products.unit_cost_override is updated. Note this sits AHEAD of
--                the BOM in the engine (see margin.ts), so a product purchase
--                takes over from that product's bill of materials.
--
-- Costs are flat, not effective-dated: Miraj's built cost is a live rollup from
-- current component costs, so editing a cost already restates historical margins
-- once they recompute. Purchasing follows the same rule rather than pretending
-- to a precision the rollup doesn't have.
--
-- Both the total paid and the derived per-unit cost are stored, because neither
-- reproduces the other exactly: total_amount is what was actually paid and is
-- what posts to the ledger, while amount is total_amount / quantity rounded to
-- 2dp (the precision product_components.cost carries). Rebuilding the total as
-- quantity x amount would drift whenever the division isn't exact.

create table if not exists public.purchases (
  id bigint generated always as identity primary key,
  date date not null,
  component_id bigint references public.product_components(id) on delete cascade,
  product_id bigint references public.products(id) on delete cascade,
  -- Quantity in the target's PRICED unit (pcs / L / KG for a component, pieces
  -- for a product) - the same unit its cost is expressed per.
  quantity numeric(12,3) not null check (quantity > 0),
  amount numeric(12,2) not null check (amount >= 0),
  total_amount numeric(12,2) not null check (total_amount >= 0),
  expense_entry_id bigint references public.expense_entries(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint purchases_one_target check (
    (component_id is not null and product_id is null) or
    (component_id is null and product_id is not null)
  )
);
create index if not exists purchases_component_idx on public.purchases (component_id, date);
create index if not exists purchases_product_idx on public.purchases (product_id, date);
create index if not exists purchases_date_idx on public.purchases (date);

grant all on public.purchases to anon, authenticated, service_role;

-- The account purchases post to. in_income_statement = false keeps it out of the
-- P&L - inventory is already deducted per delivered order as COGS, so posting
-- purchases there too would double-count - while still showing in Expense
-- Analysis as its own row.
insert into public.expense_accounts (name, kind, sort_order, in_income_statement)
select 'Purchasing', 'expense', coalesce(max(sort_order), 0) + 1, false
from public.expense_accounts
on conflict (name) do nothing;

notify pgrst, 'reload schema';
