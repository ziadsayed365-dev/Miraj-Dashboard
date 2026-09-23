-- Foundation for database-backed user management and multi-business
-- scoping. For now only IZAR Footwear exists and no operational data
-- (orders/products/etc.) is filtered by business - this just lets the
-- owner manage user accounts (instead of editing .env.local) and tags
-- each user with a business for when a second one gets real data later.
create table if not exists businesses (
  id bigint generated always as identity primary key,
  name text not null unique,
  created_at timestamptz not null default now()
);

insert into businesses (name) values ('IZAR Footwear') on conflict (name) do nothing;

create table if not exists users (
  id bigint generated always as identity primary key,
  username text not null unique,
  password_hash text not null,
  role text not null check (role in ('owner', 'staff')),
  business_id bigint not null references businesses(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
