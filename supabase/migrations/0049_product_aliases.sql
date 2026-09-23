-- Arabic names for finished goods, learned from pasted WhatsApp orders.
--
-- The catalog name is often English or differently phrased, but chat orders
-- arrive in Arabic, so nothing can be matched by plain string comparison. This
-- table is the bridge: the Chat Orders paste box matches each product line
-- against these aliases, and every line the owner resolves by hand in the review
-- step is written back here - so the same phrasing matches itself next time. It
-- starts empty and fills up over the first days of use.
--
-- alias_norm is the matching key: the alias put through normalizeArabic() in
-- src/lib/chat-orders/whatsapp.ts (Arabic-Indic digits folded to ASCII,
-- diacritics and tatweel stripped, أإآ→ا ى→ي ة→ه, punctuation collapsed). It is
-- UNIQUE, so a phrase can only ever point at one product - re-teaching it
-- repoints it rather than creating a rival row. alias_text keeps the original
-- spelling for display.
--
-- Ported from Laurel (its 0055_product_aliases.sql) plus variant_id: in Miraj a
-- multi-variant product is costed per variant, so an alias has to resolve to the
-- exact variant that was sold, not just the parent product.
create table if not exists public.product_aliases (
  id bigint generated always as identity primary key,
  product_id bigint not null references public.products(id) on delete cascade,
  variant_id bigint references public.product_variants(id) on delete cascade,
  alias_norm text not null unique,
  alias_text text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists product_aliases_product_idx on public.product_aliases (product_id);

notify pgrst, 'reload schema';
