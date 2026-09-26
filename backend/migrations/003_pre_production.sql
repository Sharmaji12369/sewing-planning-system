-- Pre-production tracking.
--
-- planned_completion: the date the planner wants the order finished. NULL
--   means "use the required delivery date". The start date is worked back from
--   it (backend/src/planning.ts).
-- The three *_at columns are stamped with the date and time someone ticks the
--   milestone on the Pre-production page. NULL = not done yet.

ALTER TABLE orders
    ADD COLUMN planned_completion      date,
    ADD COLUMN fabric_received_at      timestamptz,
    ADD COLUMN cutting_done_at         timestamptz,
    ADD COLUMN accessories_received_at timestamptz;
