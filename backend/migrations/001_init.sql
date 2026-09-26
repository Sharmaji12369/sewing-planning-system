-- Sewing Planning System - initial schema.
--
-- Only what people type is stored. Everything the Excel sheet calculated
-- (produced, balance, pace, target per day, projected finish, status) is
-- computed on every read by src/planning.ts, so it can never go stale.

CREATE TABLE orders (
    id             serial PRIMARY KEY,
    order_no       text        NOT NULL UNIQUE,          -- ORD-2026-007, never changes once saved
    factory_line   text        NOT NULL,
    style_no       text        NOT NULL DEFAULT '',
    colour         text        NOT NULL DEFAULT '',
    order_qty      integer     NOT NULL CHECK (order_qty > 0),
    unit           text        NOT NULL DEFAULT 'Pcs',
    planning_date  date        NOT NULL,
    required_date  date        NOT NULL,
    notes          text        NOT NULL DEFAULT '',
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT required_after_planning CHECK (required_date >= planning_date),
    CONSTRAINT order_no_not_blank CHECK (btrim(order_no) <> ''),
    CONSTRAINT factory_not_blank CHECK (btrim(factory_line) <> '')
);

CREATE SEQUENCE entry_no_seq START 1;

CREATE TABLE production_entries (
    id          serial PRIMARY KEY,
    entry_no    text        NOT NULL UNIQUE
                DEFAULT 'LOG-' || lpad(nextval('entry_no_seq')::text, 4, '0'),
    order_id    integer     NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    entry_date  date        NOT NULL,
    qty         integer     NOT NULL CHECK (qty > 0),
    shift       text        NOT NULL DEFAULT 'Day' CHECK (shift IN ('Day', 'Night', 'Overtime')),
    remarks     text        NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX production_entries_order_date ON production_entries (order_id, entry_date);
CREATE INDEX production_entries_date ON production_entries (entry_date);

-- One row. The Dashboard's "Planning controls" in the workbook.
CREATE TABLE settings (
    id                  smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    pace_days           integer NOT NULL DEFAULT 5 CHECK (pace_days BETWEEN 1 AND 60),
    work_days_per_week  integer NOT NULL DEFAULT 6 CHECK (work_days_per_week IN (5, 6, 7)),
    as_of_date          date,       -- NULL = today
    calendar_start      date        -- NULL = earliest production date
);

INSERT INTO settings DEFAULT VALUES;
