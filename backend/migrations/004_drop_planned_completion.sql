-- The start date is worked back from the required delivery date only, so the
-- planner-entered completion date added in 003 is no longer used.

ALTER TABLE orders DROP COLUMN IF EXISTS planned_completion;
