-- One product needs a different cost than the rest of its model
-- (e.g. one color costs more than its siblings). Optional override,
-- falls back to the model_group's unit_cost when null.
alter table products
  add column if not exists unit_cost_override numeric(12,2);
