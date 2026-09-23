-- "Chat Orders": orders taken over chat and fulfilled directly, recorded by hand
-- in the Bosta → Chat Orders tab. Nothing syncs them and no courier is ever
-- involved, so they are always 100% delivered - which is why they carry no
-- outcome/return columns.
--
-- Ported from Laurel (its 0052_chat_orders.sql), with one Miraj-specific
-- addition: variant_id. Laurel has no variant concept, but in Miraj a product
-- with MORE THAN ONE variant is costed BY VARIANT ONLY (see 0041/0043) and is
-- deliberately absent from getBuiltCosts().byProduct - so recording such a sale
-- against the bare product would price it at 0. Multi-variant products are
-- therefore offered (and stored) as variants, exactly like the bundle picker.
--
-- Revenue is ONE owner-typed figure for the whole order (the price agreed in the
-- chat), NOT a sum over the line items - which is why it lives on the order and
-- not the items. The items exist only to price COGS.
create table if not exists public.chat_orders (
  id bigint generated always as identity primary key,
  sale_date date not null,
  revenue numeric(12, 2) not null check (revenue >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists chat_orders_date_idx on public.chat_orders (sale_date);

-- cost_of_goods is snapshotted at write time from the product's (or variant's)
-- built cost, so a later BOM change can't silently rewrite an already-recorded
-- order. Editing an order re-prices every item, since quantities may have moved.
--
-- NOTE vs Laurel: Laurel prices each line at the cost effective ON sale_date via
-- getBuiltCostResolver(), which reads a `purchases` cost timeline. Miraj has no
-- such table (final-products.ts deliberately omits that resolver), so lines are
-- priced at the CURRENT built cost instead. Backdating an order therefore prices
-- it at today's cost, not that day's.
create table if not exists public.chat_order_items (
  id bigint generated always as identity primary key,
  order_id bigint not null references public.chat_orders(id) on delete cascade,
  product_id bigint not null references public.products(id),
  -- Null for a single-variant product or a bundle; set for one variant of a
  -- multi-variant product.
  variant_id bigint references public.product_variants(id),
  quantity int not null check (quantity > 0),
  cost_of_goods numeric(12, 2) not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists chat_order_items_order_idx on public.chat_order_items (order_id);

notify pgrst, 'reload schema';
