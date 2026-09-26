// Makes a user an active Administrator with the given password - the way back
// in if every administrator password is lost, and how the very first user is
// created on a fresh database.
//
//   npm.cmd run set-login -- Admin "the password"
//
// Everyday users and roles are managed on the Users & roles screen instead.
// Also makes sure backend/.env has an AUTH_SECRET for signing session cookies.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [user, password] = process.argv.slice(2);
if (!user || !password) {
  console.error('Usage: npm.cmd run set-login -- <ID> "<password>"');
  process.exit(1);
}
if (password.length < 6) {
  console.error('Use a password of at least 6 characters.');
  process.exit(1);
}

// 1. A signing secret in .env, created once and then left alone.
const envFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
let env = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
if (!/^AUTH_SECRET=/m.test(env)) {
  env = `${env.replace(/\s*$/, '')}\nAUTH_SECRET="${randomBytes(32).toString('hex')}"\n`;
  writeFileSync(envFile, env);
  console.log('AUTH_SECRET added to .env');
}

// 2. The user, in the database. (Imported only now, so db.ts reads the .env above.)
const { pool, tx } = await import('../src/db');
const { migrate } = await import('../src/migrate');
const { hashPassword } = await import('../src/auth');
const { ensureAdmin } = await import('../src/repo-users');

try {
  await migrate(() => {});
  await tx((c) => ensureAdmin(user, user, hashPassword(password), c));
  console.log(`"${user}" is an active Administrator with the new password. Their old sessions have ended.`);
} catch (e) {
  console.error('Could not set the login:', (e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
