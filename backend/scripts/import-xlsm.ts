// Loads orders and production entries from the Excel workbook into the database.
//
//   npm run import -- "C:\path\to\Factory_Sewing_Planning_System.xlsm"
//
// Reads Orders Master (A-I, V) and Daily Production Log (A, B, C, F, G, L) -
// the typed columns only; everything else is recalculated. Safe to run again:
// orders match on Order ID and entries on Entry ID, and both are updated in
// place. The workbook's "Target / Day" is not imported, because the target is
// now calculated from the balance and the required date.

import ExcelJS from 'exceljs';
import { pool, tx } from '../src/db';
import { migrate } from '../src/migrate';
import { isISODate } from '../src/dates';

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run import -- "<path to .xlsm or .xlsx>"');
  process.exit(1);
}

const str = (v: ExcelJS.CellValue): string => {
  if (v == null) return '';
  if (typeof v === 'object' && 'result' in v) return str(v.result as ExcelJS.CellValue);
  if (typeof v === 'object' && 'richText' in v) return v.richText.map((t) => t.text).join('');
  return String(v).trim();
};

const num = (v: ExcelJS.CellValue): number => {
  const n = Number(str(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
};

/** Excel dates arrive as JS Dates at UTC midnight, or as text. */
const day = (v: ExcelJS.CellValue): string | null => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  const s = str(v);
  return isISODate(s) ? s : null;
};

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const wsO = wb.getWorksheet('Orders Master');
  const wsL = wb.getWorksheet('Daily Production Log');
  if (!wsO || !wsL) throw new Error('Expected sheets "Orders Master" and "Daily Production Log"');

  await migrate();
  const problems: string[] = [];
  let orders = 0, entries = 0;

  await tx(async (c) => {
    for (let r = 4; r <= wsO.rowCount; r++) {
      const row = wsO.getRow(r);
      const orderNo = str(row.getCell(1).value);
      if (!orderNo) continue;
      const qty = num(row.getCell(5).value);
      const planning = day(row.getCell(8).value);
      const required = day(row.getCell(9).value);
      if (!(qty > 0) || !planning || !required) {
        problems.push(`Orders Master row ${r} (${orderNo}): needs a quantity and both dates - skipped`);
        continue;
      }
      await c.query(
        `INSERT INTO orders (order_no, factory_line, style_no, colour, order_qty, unit, planning_date, required_date, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (order_no) DO UPDATE SET factory_line=EXCLUDED.factory_line, style_no=EXCLUDED.style_no,
           colour=EXCLUDED.colour, order_qty=EXCLUDED.order_qty, unit=EXCLUDED.unit,
           planning_date=EXCLUDED.planning_date, required_date=EXCLUDED.required_date,
           notes=EXCLUDED.notes, updated_at=now()`,
        [orderNo, str(row.getCell(2).value) || '-', str(row.getCell(3).value), str(row.getCell(4).value),
          Math.round(qty), str(row.getCell(6).value) || 'Pcs', planning, required, str(row.getCell(22).value)]);
      orders++;
    }

    const ids = new Map<string, number>(
      (await c.query('SELECT id, order_no FROM orders')).rows.map((x) => [x.order_no, x.id]));

    for (let r = 4; r <= wsL.rowCount; r++) {
      const row = wsL.getRow(r);
      const orderNo = str(row.getCell(3).value);
      if (!orderNo) continue;
      const entryNo = str(row.getCell(1).value);
      const date = day(row.getCell(2).value);
      const qty = num(row.getCell(6).value);
      const orderId = ids.get(orderNo);
      const shift = ['Day', 'Night', 'Overtime'].includes(str(row.getCell(7).value)) ? str(row.getCell(7).value) : 'Day';
      if (!orderId || !date || !(qty > 0) || !entryNo) {
        problems.push(`Daily Production Log row ${r} (${entryNo || 'no Entry ID'}): `
          + `${!orderId ? `unknown order ${orderNo}` : 'needs an Entry ID, a date and a quantity'} - skipped`);
        continue;
      }
      await c.query(
        `INSERT INTO production_entries (entry_no, order_id, entry_date, qty, shift, remarks)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (entry_no) DO UPDATE SET order_id=EXCLUDED.order_id, entry_date=EXCLUDED.entry_date,
           qty=EXCLUDED.qty, shift=EXCLUDED.shift, remarks=EXCLUDED.remarks, updated_at=now()`,
        [entryNo, orderId, date, Math.round(qty), shift, str(row.getCell(12).value)]);
      entries++;
    }

    // New entries continue numbering after the highest imported LOG number.
    await c.query(`SELECT setval('entry_no_seq', greatest(1, coalesce(
      (SELECT max((substring(entry_no FROM '(\\d+)$'))::int) FROM production_entries), 0)),
      (SELECT count(*) > 0 FROM production_entries))`);
  });

  console.log(`Imported ${orders} orders and ${entries} production entries.`);
  for (const p of problems) console.log('  ' + p);
}

main()
  .then(() => pool.end())
  .catch((e) => { console.error('Import failed:', e.message); process.exit(1); });
