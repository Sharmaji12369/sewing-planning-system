// Users and roles. All SQL for the Users & roles screen and for sign-in.

import type pg from 'pg';
import { pool } from './db';
import type { SessionUser } from './auth';
import { ADMIN_ROLE, ALL_PERMISSIONS, effective } from './permissions';

type Q = Pick<pg.Pool, 'query'>;

export interface UserRow {
  id: number;
  username: string;
  displayName: string;
  active: boolean;
  lastLoginAt: string | null;
  roles: { id: number; code: string; name: string }[];
}

export interface RoleRow {
  id: number;
  code: string;
  name: string;
  permissions: string[];
  builtIn: boolean;
  userCount: number;
}

/** The permissions a user holds through all their roles. The built-in Administrator role always holds all of them. */
const PERMS_SQL = `
  SELECT coalesce(array_agg(DISTINCT p), '{}') FROM user_roles ur
  JOIN roles r ON r.id = ur.role_id
  CROSS JOIN LATERAL unnest(CASE WHEN r.built_in THEN $2::text[] ELSE r.permissions END) AS p
  WHERE ur.user_id = u.id`;

export async function loadSessionUser(id: number, q: Q = pool): Promise<(SessionUser & { active: boolean }) | null> {
  const { rows } = await q.query(
    `SELECT u.id, u.username, u.display_name AS "displayName", u.active, u.token_version AS "tokenVersion",
       (${PERMS_SQL}) AS permissions
     FROM users u WHERE u.id = $1`, [id, ALL_PERMISSIONS]);
  const r = rows[0];
  return r ? { ...r, permissions: effective(r.permissions) } : null;
}

export async function findUserForLogin(username: string, q: Q = pool) {
  const { rows } = await q.query(
    `SELECT id, username, display_name AS "displayName", password_hash AS "passwordHash", active,
       token_version AS "tokenVersion"
     FROM users WHERE lower(username) = lower($1)`, [username]);
  return (rows[0] ?? null) as null | {
    id: number; username: string; displayName: string; passwordHash: string; active: boolean; tokenVersion: number;
  };
}

export async function noteLogin(id: number, q: Q = pool) {
  await q.query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]);
}

export async function userCount(q: Q = pool): Promise<number> {
  return (await q.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
}

export async function listUsers(q: Q = pool): Promise<UserRow[]> {
  const { rows } = await q.query(`
    SELECT u.id, u.username, u.display_name AS "displayName", u.active,
      to_json(u.last_login_at) #>> '{}' AS "lastLoginAt",
      coalesce(json_agg(json_build_object('id', r.id, 'code', r.code, 'name', r.name) ORDER BY r.name)
        FILTER (WHERE r.id IS NOT NULL), '[]') AS roles
    FROM users u
    LEFT JOIN user_roles ur ON ur.user_id = u.id
    LEFT JOIN roles r ON r.id = ur.role_id
    GROUP BY u.id
    ORDER BY u.active DESC, lower(u.display_name)`);
  return rows;
}

export async function listRoles(q: Q = pool): Promise<RoleRow[]> {
  const { rows } = await q.query(`
    SELECT r.id, r.code, r.name,
      CASE WHEN r.built_in THEN $1::text[] ELSE r.permissions END AS permissions,
      r.built_in AS "builtIn",
      (SELECT count(*)::int FROM user_roles ur WHERE ur.role_id = r.id) AS "userCount"
    FROM roles r
    ORDER BY r.built_in DESC, lower(r.name)`, [ALL_PERMISSIONS]);
  return rows;
}

async function setRoles(userId: number, roleIds: number[], q: Q) {
  await q.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
  if (roleIds.length) {
    await q.query(
      'INSERT INTO user_roles (user_id, role_id) SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING',
      [userId, roleIds]);
  }
}

export async function createUser(
  u: { username: string; displayName: string; passwordHash: string; active: boolean; roleIds: number[] }, q: Q,
): Promise<number> {
  const { rows } = await q.query(
    `INSERT INTO users (username, display_name, password_hash, active) VALUES ($1, $2, $3, $4) RETURNING id`,
    [u.username, u.displayName, u.passwordHash, u.active]);
  await setRoles(rows[0].id, u.roleIds, q);
  return rows[0].id;
}

/**
 * A new password or a deactivation bumps the token version, which signs the
 * user out everywhere at once.
 */
export async function updateUser(
  id: number,
  u: { displayName: string; passwordHash: string | null; active: boolean; roleIds: number[] }, q: Q,
): Promise<boolean> {
  const r = await q.query(
    `UPDATE users SET display_name = $2,
       password_hash = coalesce($3, password_hash),
       token_version = token_version + CASE WHEN $3::text IS NOT NULL OR (active AND NOT $4) THEN 1 ELSE 0 END,
       active = $4, updated_at = now()
     WHERE id = $1`, [id, u.displayName, u.passwordHash, u.active]);
  if (!r.rowCount) return false;
  await setRoles(id, u.roleIds, q);
  return true;
}

/** Changes a password and returns the new token version (the old sessions end). */
export async function setPassword(id: number, passwordHash: string, q: Q = pool): Promise<number> {
  const { rows } = await q.query(
    `UPDATE users SET password_hash = $2, token_version = token_version + 1, updated_at = now()
     WHERE id = $1 RETURNING token_version AS v`, [id, passwordHash]);
  return rows[0].v;
}

export async function passwordHashOf(id: number, q: Q = pool): Promise<string | null> {
  return (await q.query('SELECT password_hash AS h FROM users WHERE id = $1', [id])).rows[0]?.h ?? null;
}

export async function createRole(r: { code: string; name: string; permissions: string[] }, q: Q = pool): Promise<number> {
  const { rows } = await q.query(
    'INSERT INTO roles (code, name, permissions) VALUES ($1, $2, $3) RETURNING id', [r.code, r.name, r.permissions]);
  return rows[0].id;
}

export async function getRole(id: number, q: Q = pool) {
  const { rows } = await q.query('SELECT id, code, name, built_in AS "builtIn" FROM roles WHERE id = $1', [id]);
  return (rows[0] ?? null) as null | { id: number; code: string; name: string; builtIn: boolean };
}

/** The built-in Administrator role keeps every permission; only its name can change. */
export async function updateRole(id: number, r: { name: string; permissions: string[] }, q: Q): Promise<boolean> {
  const res = await q.query(
    `UPDATE roles SET name = $2, permissions = CASE WHEN built_in THEN permissions ELSE $3 END, updated_at = now()
     WHERE id = $1`, [id, r.name, r.permissions]);
  return (res.rowCount ?? 0) > 0;
}

export async function deleteRole(id: number, q: Q = pool): Promise<void> {
  await q.query('DELETE FROM roles WHERE id = $1 AND NOT built_in', [id]);
}

/** Active users who can still reach Users & roles. Must never become zero. */
export async function activeAdminCount(q: Q = pool): Promise<number> {
  const { rows } = await q.query(`
    SELECT count(DISTINCT u.id)::int AS n FROM users u
    JOIN user_roles ur ON ur.user_id = u.id
    JOIN roles r ON r.id = ur.role_id
    WHERE u.active AND (r.built_in OR 'admin.users' = ANY (r.permissions))`);
  return rows[0].n;
}

/**
 * Makes sure `username` exists, is active, has this password and holds the
 * Administrator role. Used for the very first start and by `npm run set-login`
 * (a way back in if every administrator password is lost).
 */
export async function ensureAdmin(username: string, displayName: string, passwordHash: string, q: Q): Promise<void> {
  const found = await q.query('SELECT id FROM users WHERE lower(username) = lower($1)', [username]);
  let id: number;
  if (found.rows[0]) {
    id = found.rows[0].id;
    await q.query(
      `UPDATE users SET password_hash = $2, active = true, token_version = token_version + 1, updated_at = now()
       WHERE id = $1`, [id, passwordHash]);
  } else {
    id = (await q.query(
      'INSERT INTO users (username, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [username, displayName, passwordHash])).rows[0].id;
  }
  await q.query(
    `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2 ON CONFLICT DO NOTHING`,
    [id, ADMIN_ROLE]);
}
