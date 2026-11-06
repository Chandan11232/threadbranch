// Doc drift: the README's Auth section must agree with the exported constants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as auth from '../../src/auth/index.js';

const README = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'README.md'), 'utf8');
const section = README.slice(README.indexOf('## Auth'), README.indexOf('\n## ', README.indexOf('## Auth') + 1));

test('README has an Auth section', () => assert.ok(section.length > 500));
test('secret minimum', () => { assert.equal(auth.MIN_SECRET_BYTES, 32); assert.match(section, /at least 32 bytes/); });
test('token lifetime', () => { assert.equal(auth.DEFAULT_EXPIRES_IN, '1h'); assert.match(section, /lasts 1 hour/); });
test('password limits', () => {
  assert.equal(auth.MIN_PASSWORD_LENGTH, 8); assert.equal(auth.MAX_PASSWORD_BYTES, 1024);
  assert.match(section, /at least 8 characters/); assert.match(section, /at most 1024 bytes/);
});
test('lockout numbers', () => {
  const t = auth.THROTTLE_DEFAULTS;
  assert.equal(t.maxFailures, 5); assert.match(section, /Five failed logins/);
  assert.equal(t.baseLockMs, 60_000); assert.match(section, /1 minute/);
  assert.equal(t.maxLockMs, 24 * 3600_000); assert.match(section, /up to 24 hours/);
  assert.equal(t.forgetAfterMs, 24 * 3600_000); assert.match(section, /forgotten after 24 hours/);
});
test('messages and paths', () => {
  assert.ok(section.includes(auth.AUTH_FAILED));
  assert.ok(section.includes(auth.LOGIN_FAILED));
  for (const s of ['.git/tb-auth/users.json', '.git/tb-auth/token', '0600', 'never accepted as arguments', 'TB_DEBUG', 'tb user unlock']) {
    assert.ok(section.includes(s), s);
  }
});
