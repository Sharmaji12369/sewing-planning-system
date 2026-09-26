// All SQL lives here. Rows come back already in the camelCase shapes that
// planning.ts works with.

import type pg from 'pg';
import { pool } from './db';
import type { Entry, IdleDay, MilestoneKey, Order, Shift } from './planning';
import type { ISODate } from './dates';

type Q = Pick<pg.Pool, 'query'>;

// Timestamps are sent as ISO text so they arrive as strings, like every other field.
const ORDER_COLS = `id, order_no AS "orderNo", line_no AS "lineNo", style_no AS "styleNo",
  colour, order_qty AS "orderQty", unit, planning_date AS "planningDate",
  required_date AS "requiredDate", notes,
  to_json(fabric_received_at) #>> '{}' AS "fabricReceivedAt",
  to_json(cutting_done_at) #>> '{}' AS "cuttingDoneAt",
  to_json(accessories_received_at) #>> '{}' AS "accessoriesReceivedAt",
  to_json(packed_at) #>> '{}' AS "packedAt"`;

/** Order column behind each pre-production milestone. */
const MILESTONE_COLUMN: Record<MilestoneKey, string> = {
  fabric: 'fabric_received_at',
  cutting: 'cutting_done_at',
  accessories: 'accessories_received_at',
};

const ENTRY_COLS = `id, entry_no AS "entryNo", order_id AS "orderId", entry_date AS "entryDate",
  qty, shift, remarks`;


export async function listOrders(q: Q = pool): Promise<Order[]> {
  const { rows } = await q.query(`SELECT ${ORDER_COLS} FROM orders ORDER BY required_date, order_no`);
  return rows;
}

export async function getOrder(id: number, q: Q = pool): Promise<Order | null> {
  const { rows } = await q.query(`SELECT ${ORDER_COLS} FROM orders WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/** What the order form edits. The milestone stamps are set only by their tick buttons. */
export type OrderInput = Omit<Order, 'id' | 'fabricReceivedAt' | 'cuttingDoneAt' | 'accessoriesReceivedAt' | 'packedAt'>;

export async function createOrder(o: OrderInput, q: Q = pool): Promise<Order> {
  const { rows } = await q.query(
    `INSERT INTO orders (order_no, line_no, style_no, colour, order_qty, unit, planning_date, required_date, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${ORDER_COLS}`,
    [o.orderNo, o.lineNo, o.styleNo, o.colour, o.orderQty, o.unit, o.planningDate, o.requiredDate, o.notes]);
  return rows[0];
}

/** The order number is the key people know an order by - it never changes. */
export async function updateOrder(id: number, o: Omit<OrderInput, 'orderNo'>, q: Q = pool): Promise<Order | null> {
  const { rows } = await q.query(
    `UPDATE orders SET line_no=$2, style_no=$3, colour=$4, order_qty=$5, unit=$6,
       planning_date=$7, required_date=$8, notes=$9, updated_at=now()
     WHERE id=$1 RETURNING ${ORDER_COLS}`,
    [id, o.lineNo, o.styleNo, o.colour, o.orderQty, o.unit, o.planningDate, o.requiredDate, o.notes]);
  return rows[0] ?? null;
}

/**
 * Held for the rest of a transaction while an order is checked against its
 * line and saved, so two people cannot book the same days at the same moment.
 */
export async function lockLines(q: Q): Promise<void> {
  await q.query('SELECT pg_advisory_xact_lock(7001)');
}

/** Stamps a milestone with the database's current date and time, or clears it. */
export async function setMilestone(id: number, key: MilestoneKey, done: boolean, q: Q = pool): Promise<Order | null> {
  const col = MILESTONE_COLUMN[key]; // from a fixed list, never from the request
  const { rows } = await q.query(
    `UPDATE orders SET ${col} = ${done ? 'now()' : 'NULL'}, updated_at = now() WHERE id = $1 RETURNING ${ORDER_COLS}`,
    [id]);
  return rows[0] ?? null;
}

/** Post-production: stamps packing with the database's current date and time, or clears it. */
export async function setPacked(id: number, done: boolean, q: Q = pool): Promise<Order | null> {
  const { rows } = await q.query(
    `UPDATE orders SET packed_at = ${done ? 'now()' : 'NULL'}, updated_at = now() WHERE id = $1 RETURNING ${ORDER_COLS}`,
    [id]);
  return rows[0] ?? null;
}

/** Deletes the order and, through ON DELETE CASCADE, its production entries. */
export async function deleteOrder(id: number, q: Q = pool): Promise<{ deleted: boolean; entries: number }> {
  const n = await q.query('SELECT count(*)::int AS n FROM production_entries WHERE order_id = $1', [id]);
  const r = await q.query('DELETE FROM orders WHERE id = $1', [id]);
  return { deleted: (r.rowCount ?? 0) > 0, entries: n.rows[0].n };
}

/** ORD-<this year>-<highest number on file + 1>, as the workbook suggested it. */
export async function nextOrderNo(year: number, q: Q = pool): Promise<string> {
  const { rows } = await q.query(
    `SELECT coalesce(max((substring(order_no FROM '(\\d+)$'))::int), 0) AS n FROM orders`);
  return `ORD-${year}-${String(rows[0].n + 1).padStart(3, '0')}`;
}

export async function distinctValues(q: Q = pool): Promise<{ styles: string[] }> {
  const s = await q.query(`SELECT DISTINCT style_no AS v FROM orders WHERE style_no <> '' ORDER BY 1`);
  return { styles: s.rows.map((r) => r.v) };
}

export async function listEntries(q: Q = pool): Promise<Entry[]> {
  const { rows } = await q.query(`SELECT ${ENTRY_COLS} FROM production_entries ORDER BY entry_date, id`);
  return rows;
}

export async function getEntry(id: number, q: Q = pool): Promise<Entry | null> {
  const { rows } = await q.query(`SELECT ${ENTRY_COLS} FROM production_entries WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export interface EntryInput { orderId: number; entryDate: ISODate; qty: number; shift: Shift; remarks: string }

export async function createEntry(e: EntryInput, q: Q = pool): Promise<Entry> {
  const { rows } = await q.query(
    `INSERT INTO production_entries (order_id, entry_date, qty, shift, remarks)
     VALUES ($1,$2,$3,$4,$5) RETURNING ${ENTRY_COLS}`,
    [e.orderId, e.entryDate, e.qty, e.shift, e.remarks]);
  return rows[0];
}

export async function updateEntry(id: number, e: EntryInput, q: Q = pool): Promise<Entry | null> {
  const { rows } = await q.query(
    `UPDATE production_entries SET order_id=$2, entry_date=$3, qty=$4, shift=$5, remarks=$6, updated_at=now()
     WHERE id=$1 RETURNING ${ENTRY_COLS}`,
    [id, e.orderId, e.entryDate, e.qty, e.shift, e.remarks]);
  return rows[0] ?? null;
}

export async function deleteEntry(id: number, q: Q = pool): Promise<boolean> {
  const r = await q.query('DELETE FROM production_entries WHERE id = $1', [id]);
  return (r.rowCount ?? 0) > 0;
}

/** What is already logged against an order, leaving out one entry being edited. */
export async function orderLogged(orderId: number, excludeEntryId: number | null, q: Q = pool) {
  const { rows } = await q.query(
    `SELECT coalesce(sum(qty), 0)::int AS produced FROM production_entries
     WHERE order_id = $1 AND ($2::int IS NULL OR id <> $2)`, [orderId, excludeEntryId]);
  return rows[0].produced as number;
}

// --- idle days -----------------------------------------------------------------

const IDLE_COLS = `id, idle_date AS "idleDate", line_no AS "lineNo",
  portion::float8 AS portion, reason`;

export async function listIdle(q: Q = pool): Promise<IdleDay[]> {
  const { rows } = await q.query(`SELECT ${IDLE_COLS} FROM idle_days ORDER BY idle_date, line_no NULLS FIRST`);
  return rows;
}

/** Marks each date; a date already marked for the same line (or for all lines) is replaced. */
export async function saveIdle(
  dates: ISODate[], lineNo: number | null, portion: 0.5 | 1, reason: string, q: Q = pool,
): Promise<number> {
  let n = 0;
  for (const d of dates) {
    await q.query(
      `INSERT INTO idle_days (idle_date, line_no, portion, reason) VALUES ($1, $2, $3, $4)
       ON CONFLICT (idle_date, (coalesce(line_no, 0)))
       DO UPDATE SET portion = EXCLUDED.portion, reason = EXCLUDED.reason`,
      [d, lineNo, portion, reason]);
    n++;
  }
  return n;
}

export async function deleteIdle(id: number, q: Q = pool): Promise<boolean> {
  const r = await q.query('DELETE FROM idle_days WHERE id = $1', [id]);
  return (r.rowCount ?? 0) > 0;
}

export async function sameShiftEntries(
  orderId: number, date: ISODate, shift: Shift, excludeEntryId: number | null, q: Q = pool,
): Promise<Entry[]> {
  const { rows } = await q.query(
    `SELECT ${ENTRY_COLS} FROM production_entries
     WHERE order_id = $1 AND entry_date = $2 AND shift = $3 AND ($4::int IS NULL OR id <> $4)`,
    [orderId, date, shift, excludeEntryId]);
  return rows;
}
