-- A user can be given access to more than one business, so business_id
-- moves from a single column on users to a join table. No users exist
-- yet (table was just added in 0023), so this is a clean cutover.
alter table users drop column if exists business_id;

create table if not exists user_businesses (
  user_id bigint not null references users(id) on delete cascade,
  business_id bigint not null references businesses(id) on delete cascade,
  primary key (user_id, business_id)
);
