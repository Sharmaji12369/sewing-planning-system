// Creates the database if it is missing, then applies every migrations/*.sql
// not yet recorded in schema_migrations, in file-name order, each in its own
// transaction. Safe to run repeatedly; the server also runs it on start.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pool, tx } from './db';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * If the database named in DATABASE_URL does not exist yet, create it,
 * connecting to the server's built-in "postgres" database to do so. Any other
 * connection error (wrong password, server down) is left to surface as it is.
 */
export async function ensureDatabase(log = console.log): Promise<void> {
  const url = new URL(process.env.DATABASE_URL!);
  const probe = new pg.Client({ connectionString: url.toString() });
  try {
    await probe.connect();
    await probe.end();
    return;
  } catch (e) {
    await probe.end().catch(() => {});
    if ((e as { code?: string }).code !== '3D000') throw e; // 3D000 = database does not exist
  }
  const name = decodeURIComponent(url.pathname.slice(1));
  url.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(name)}`);
    log(`database created: ${name}`);
  } finally {
    await admin.end();
  }
}

export async function migrate(log = console.log): Promise<void> {
  await ensureDatabase(log);
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(path.join(DIR, f), 'utf8');
    await tx(async (c) => {
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    });
    log(`migration applied: ${f}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate()
    .then(() => { console.log('database is up to date'); return pool.end(); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
