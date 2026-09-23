-- Allocating a campaign has been failing outright since 0063.
--
-- ad_model_assignments carried a check from the model-group era:
--
--     CHECK ((model_group_id IS NOT NULL) <> is_general)
--
-- "exactly one of: pinned to a model group, or general". 0063 moved allocation
-- off model_group_id onto sub_categories and left model_group_id unread - but
-- did not touch this constraint. So the shape 0063 actually writes
-- (model_group_id null, is_general false, sub_categories set) evaluates
-- false <> false = FALSE and is rejected by the database:
--
--     new row for relation "ad_model_assignments" violates check constraint
--     "ad_model_assignments_target_check"
--
-- ad_model_assignments is empty, which is the proof: not one allocation has
-- ever been saved since that migration. The Settings tab reads "No allocations
-- yet" and every campaign keeps coming back to the popup, because the write
-- behind both is rejected every time.
--
-- Restated in terms of what a target means now - a campaign is either general,
-- or it names at least one thing to spend against. model_group_id is still
-- accepted as a target so the historical column keeps working if it is ever
-- read again.
alter table public.ad_model_assignments drop constraint if exists ad_model_assignments_target_check;

alter table public.ad_model_assignments
  add constraint ad_model_assignments_target_check
  check (
    is_general <> (
      model_group_id is not null
      or coalesce(array_length(sub_categories, 1), 0) > 0
      or coalesce(array_length(categories, 1), 0) > 0
    )
  );

notify pgrst, 'reload schema';
