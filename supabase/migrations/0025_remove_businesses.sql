-- Multi-business is being handled as fully separate deployments per
-- business instead of inside this app, so the business foundation (and
-- the business picker login flow) is removed. User accounts themselves
-- (username/password/role) are kept as-is.
drop table if exists user_businesses;
drop table if exists businesses;
