-- Sewing lines 1-10 replace the free-text Factory / Line (22 Sep 2026).
--
-- Every order runs on one line, and a line runs one order at a time: the
-- booking and the queue are worked out in planning.ts, not stored.

ALTER TABLE orders ADD COLUMN line_no smallint CHECK (line_no BETWEEN 1 AND 10);

-- The old name is kept for reference but is no longer entered.
ALTER TABLE orders ALTER COLUMN factory_line DROP NOT NULL;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS factory_not_blank;

-- An old name ending in a line number ("INA6", "Line 4") keeps that line.
-- Any other order is left without a line for someone to pick.
UPDATE orders SET line_no = substring(factory_line FROM '(?:^|\D)(\d{1,2})\s*$')::int
 WHERE substring(factory_line FROM '(?:^|\D)(\d{1,2})\s*$')::int BETWEEN 1 AND 10;

-- Idle days: NULL line = every line.
ALTER TABLE idle_days ADD COLUMN line_no smallint CHECK (line_no BETWEEN 1 AND 10);
UPDATE idle_days SET line_no = substring(factory_line FROM '(?:^|\D)(\d{1,2})\s*$')::int
 WHERE factory_line IS NOT NULL
   AND substring(factory_line FROM '(?:^|\D)(\d{1,2})\s*$')::int BETWEEN 1 AND 10;
-- One marked for a named factory with no line number has nothing left to apply to.
DELETE FROM idle_days WHERE factory_line IS NOT NULL AND line_no IS NULL;
DROP INDEX idle_days_one_per_day;
ALTER TABLE idle_days DROP COLUMN factory_line;
DELETE FROM idle_days a USING idle_days b
 WHERE a.idle_date = b.idle_date AND coalesce(a.line_no, 0) = coalesce(b.line_no, 0) AND a.id < b.id;
CREATE UNIQUE INDEX idle_days_one_per_day ON idle_days (idle_date, (coalesce(line_no, 0)));

-- The new Line calendar page: whoever could see the calendar can see it.
UPDATE roles SET permissions = array_append(permissions, 'lines.view')
 WHERE ('calendar.view' = ANY (permissions) OR 'calendar.edit' = ANY (permissions))
   AND NOT 'lines.view' = ANY (permissions);
