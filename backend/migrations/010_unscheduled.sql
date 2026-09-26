-- Orders can be saved before anyone knows their line or when they start (25 Sep 2026).
--
-- line_no has allowed NULL since migration 007. An order with no line or no
-- expected scheduling date is "not scheduled": it books no line, has no
-- pre-production due dates, and the API refuses pre-production ticks,
-- production entries and packing for it until both are filled in.
-- The required_after_planning check still holds whenever a date is given.

ALTER TABLE orders ALTER COLUMN planning_date DROP NOT NULL;
