-- Days a factory stood idle, or will: full day (1) or half day (0.5).
-- factory_line NULL means every factory. One mark per date per factory;
-- marking the same date again replaces it.

CREATE TABLE idle_days (
    id            serial PRIMARY KEY,
    idle_date     date         NOT NULL,
    factory_line  text,
    portion       numeric(2,1) NOT NULL CHECK (portion IN (0.5, 1)),
    reason        text         NOT NULL DEFAULT '',
    created_at    timestamptz  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idle_days_one_per_day ON idle_days (idle_date, (coalesce(factory_line, '')));
