import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ quiet: true });

// DATE columns come back as the 'YYYY-MM-DD' text Postgres sent. The default
// turns them into a JS Date at local midnight, which shifts by a day as soon
// as it is serialised in UTC.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// A connection the database drops while it sits idle - PostgreSQL restarted,
// Windows updated it - is reported here. With no listener Node treats that as
// fatal and the whole API goes down with it; the pool simply opens a fresh
// connection for the next request.
pool.on('error', (e) => console.error(`database connection lost (${e.message}) - reconnecting on the next request`));

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  let broken: Error | undefined;
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    // A connection that died mid-way cannot roll back: keep the real error, and
    // throw that connection away rather than hand it to the next request.
    await c.query('ROLLBACK').catch((r: Error) => { broken = r; });
    throw e;
  } finally {
    c.release(broken);
  }
}
