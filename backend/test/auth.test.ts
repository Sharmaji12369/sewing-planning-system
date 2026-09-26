import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearFailures, hashPassword, lockedMinutes, makeToken, noteFailure, readToken, verifyPassword,
} from '../src/auth';
import { effective } from '../src/permissions';

test('the password is stored only as a hash, and only the right password matches it', () => {
  const h = hashPassword('Correct#Horse1');
  assert.equal(h.includes('Correct#Horse1'), false);
  assert.equal(verifyPassword('Correct#Horse1', h), true);
  assert.equal(verifyPassword('correct#horse1', h), false); // case matters
  assert.equal(verifyPassword('', h), false);
  assert.notEqual(hashPassword('Correct#Horse1'), h);       // salted: never the same twice
  assert.equal(verifyPassword('x', 'garbage'), false);
});

test('a session token is readable only with the right secret, untampered and unexpired', () => {
  const now = Date.UTC(2026, 8, 21, 9, 0);
  const t = makeToken({ uid: 7, v: 3 }, 'secret-1', 24, now);
  assert.deepEqual(readToken(t, 'secret-1', now), { uid: 7, v: 3 });
  assert.equal(readToken(t, 'secret-2', now), null);                      // wrong secret
  assert.equal(readToken(t, 'secret-1', now + 25 * 3600 * 1000), null);   // expired
  const [body, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ uid: 1, v: 3, exp: 9e9 })).toString('base64url');
  assert.equal(readToken(`${forged}.${sig}`, 'secret-1', now), null);    // someone else's id swapped in
  assert.equal(readToken(`${body}.x${sig.slice(1)}`, 'secret-1', now), null);
  assert.equal(readToken(undefined, 'secret-1', now), null);
  assert.equal(readToken('nonsense', 'secret-1', now), null);
});

test('ten wrong passwords lock that address out for 15 minutes', () => {
  const ip = '203.0.113.9';
  const t0 = Date.UTC(2026, 8, 21, 9, 0);
  clearFailures(ip);
  for (let i = 0; i < 9; i++) noteFailure(ip, t0);
  assert.equal(lockedMinutes(ip, t0), 0);
  noteFailure(ip, t0);
  assert.equal(lockedMinutes(ip, t0), 15);
  assert.equal(lockedMinutes(ip, t0 + 16 * 60 * 1000), 0);
  assert.equal(lockedMinutes('198.51.100.1', t0), 0); // other addresses unaffected
  clearFailures(ip);
});

test('edit permission brings view with it; unknown permissions are ignored', () => {
  const p = effective(['orders.edit', 'calendar.view', 'nonsense', 'admin.users']);
  assert.equal(p.has('orders.edit'), true);
  assert.equal(p.has('orders.view'), true);   // from orders.edit
  assert.equal(p.has('calendar.view'), true);
  assert.equal(p.has('calendar.edit'), false);
  assert.equal(p.has('admin.users'), true);
  assert.equal(p.has('log.view'), false);
  assert.equal(p.size, 4);
});
