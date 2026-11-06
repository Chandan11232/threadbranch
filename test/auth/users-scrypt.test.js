// Deterministic replacement for a wall-clock timing check: count scrypt calls per code path.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PW = 'correct horse battery';
const calls = [];
let realScrypt, UserStore, dir, store;

before(async () => {
  realScrypt = crypto.scrypt;
  crypto.scrypt = function spy(password, salt, keylen, opts, cb) {
    calls.push({ keylen, N: opts?.N });
    return realScrypt.call(crypto, password, salt, keylen, opts, cb);
  };
  // Fresh module instance so its promisify(crypto.scrypt) captures the spy.
  ({ UserStore } = await import(`../../src/auth/users.js?scrypt-spy=${Date.now()}`));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-scrypt-'));
  store = new UserStore(path.join(dir, 'users.json'));
  await store.createUser('alice', PW);
});
after(() => {
  crypto.scrypt = realScrypt;
  fs.rmSync(dir, { recursive: true, force: true });
});

const count = async (fn) => { calls.length = 0; const r = await fn(); return { r, n: calls.length, c: [...calls] }; };

test('spy is wired (createUser hashes once)', async () => {
  const { n } = await count(() => store.createUser('bob', PW));
  assert.equal(n, 1);
});

test('correct password: one scrypt call, true', async () => {
  assert.deepEqual(await count(() => store.checkPassword('alice', PW)).then(({ r, n }) => [r, n]), [true, 1]);
});

test('wrong password: one scrypt call, false', async () => {
  assert.deepEqual(await count(() => store.checkPassword('alice', 'wrong password')).then(({ r, n }) => [r, n]), [false, 1]);
});

test('unknown user: still exactly one scrypt call with the real-user cost params', async () => {
  const known = await count(() => store.checkPassword('alice', 'wrong password'));
  const unknown = await count(() => store.checkPassword('nobody', PW));
  assert.equal(unknown.r, false);
  assert.equal(unknown.n, 1);
  assert.deepEqual(unknown.c, known.c, 'same keylen and N as a real record');
});

test('unknown user that looks like a prototype key: one scrypt call', async () => {
  for (const name of ['constructor', 'tostring', 'hasownproperty']) {
    const { r, n } = await count(() => store.checkPassword(name, PW));
    assert.deepEqual([r, n], [false, 1], name);
  }
});

test('tampered (invalid) record: falls back to dummy, still one scrypt call', async () => {
  const file = store.path;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.users.carol = { ...data.users.alice, params: { N: 3, r: 8, p: 1, keylen: 64 } };
  fs.writeFileSync(file, JSON.stringify(data));
  const { r, n } = await count(() => store.checkPassword('carol', PW));
  assert.deepEqual([r, n], [false, 1]);
});

test('malformed input short-circuits without scrypt (no user-dependent info leaked)', async () => {
  for (const [u, p] of [['bad name', PW], [null, PW], ['alice', null], ['alice', 'x'.repeat(2000)]]) {
    const { r, n } = await count(() => store.checkPassword(u, p));
    assert.deepEqual([r, n], [false, 0], JSON.stringify([u, typeof p]));
  }
});

test('lockout: no scrypt while locked (attemptLogin)', async () => {
  let clock = 2e12;
  const s = new UserStore(store.path, { throttle: { now: () => clock } });
  for (let i = 0; i < 5; i++) await s.attemptLogin('alice', 'wrong password');
  const locked = await count(() => s.attemptLogin('alice', PW));
  assert.deepEqual([locked.r, locked.n], [{ ok: false, locked: true }, 0]);
  const lockedUnknown = await count(async () => {
    for (let i = 0; i < 5; i++) await s.attemptLogin('ghost', 'wrong password');
    calls.length = 0;
    return s.attemptLogin('ghost', PW);
  });
  assert.deepEqual([lockedUnknown.r.locked, lockedUnknown.n], [true, 0]);
  clock += 60_000;
  const after = await count(() => s.attemptLogin('alice', PW));
  assert.deepEqual([after.r.ok, after.n], [true, 1]);
});

test('lockout: concurrent burst of 20 guesses runs scrypt at most maxFailures times', async () => {
  const s = new UserStore(store.path, { throttle: { now: () => 3e12 } });
  const { n } = await count(() => Promise.all(Array.from({ length: 20 }, () => s.attemptLogin('bob', 'wrong password'))));
  assert.ok(n <= 5, `scrypt ran ${n} times`);
});

test('attemptLogin: unknown user still costs one scrypt (before lock)', async () => {
  const s = new UserStore(store.path, { throttle: { now: () => 4e12 } });
  const { r, n } = await count(() => s.attemptLogin('nobody-here', PW));
  assert.deepEqual([r.ok, n], [false, 1]);
});

test('attemptLogin: malformed input runs no scrypt', async () => {
  const s = new UserStore(store.path, { throttle: { now: () => 5e12 } });
  const { n } = await count(() => s.attemptLogin('bad name', PW));
  assert.equal(n, 0);
});
