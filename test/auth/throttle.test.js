import { test, describe, beforeEach, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { login, authenticate, UserStore, THROTTLE_DEFAULTS, LOGIN_FAILED } from '../../src/auth/index.js';

const SECRET = 't'.repeat(32);
const PW = 'correct horse battery';
const BAD = 'wrong password!';
const MIN = 60_000;
let dir, usersPath, store, clock, o;

// One shared store with alice, cloned per test (scrypt for createUser is the slow part).
let template;
before(async () => {
  template = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-throttle-tpl-'));
  const s = new UserStore(path.join(template, 'users.json'));
  await s.createUser('alice', PW);
  await s.createUser('bob', PW);
});
after(() => fs.rmSync(template, { recursive: true, force: true }));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-throttle-'));
  usersPath = path.join(dir, 'users.json');
  fs.copyFileSync(path.join(template, 'users.json'), usersPath);
  clock = 1_900_000_000_000;
  store = new UserStore(usersPath, { throttle: { now: () => clock } });
  o = { secret: SECRET, usersPath, env: {}, store };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const failed = (e) => e.message === LOGIN_FAILED;
const entry = (name) => JSON.parse(fs.readFileSync(usersPath, 'utf8')).throttle[name];
const fail = async (name, n = 1) => { for (let i = 0; i < n; i++) assert.equal((await store.attemptLogin(name, BAD)).ok, false); };

test('THROTTLE_DEFAULTS', () => {
  const { now, ...rest } = THROTTLE_DEFAULTS;
  assert.deepEqual(rest, { maxFailures: 5, baseLockMs: 60000, maxLockMs: 86400000, forgetAfterMs: 86400000, maxEntries: 1000 });
  assert.equal(typeof now, 'function');
  assert.ok(Math.abs(now() - Date.now()) < 1000);
});

describe('lockout', () => {
  test('4 failures do not lock; 5th sets lockedUntil = now + 60s', async () => {
    await fail('alice', 4);
    assert.equal(entry('alice').failures, 4);
    assert.equal(entry('alice').lockedUntil, 0);
    assert.equal((await store.attemptLogin('alice', PW)).ok, true, 'still allowed after 4');
  });

  test('after 5 failures the right password is refused (locked) with the same LOGIN_FAILED', async () => {
    await fail('alice', 5);
    assert.equal(entry('alice').lockedUntil, clock + MIN);
    assert.deepEqual(await store.attemptLogin('alice', PW), { ok: false, locked: true });
    await assert.rejects(login('alice', PW, o), failed);
    await assert.rejects(login('alice', BAD, o), failed);
  });

  test('the attempt that reaches maxFailures is still checked: right password succeeds and clears', async () => {
    await fail('alice', 4);
    const r = await store.attemptLogin('alice', PW);
    assert.equal(r.ok, true);
    assert.equal(r.username, 'alice');
    assert.equal(r.tokenVersion, store.tokenVersion('alice'));
    assert.equal(entry('alice'), undefined);
  });

  test('locked attempts do not extend the lock or bump the count', async () => {
    await fail('alice', 5);
    const e = entry('alice');
    clock += 30_000;
    await fail('alice', 3);
    assert.deepEqual(entry('alice'), e);
  });

  test('lock expires after baseLockMs exactly', async () => {
    await fail('alice', 5);
    clock += MIN - 1;
    assert.equal((await store.attemptLogin('alice', PW)).locked, true);
    clock += 1;
    assert.equal((await store.attemptLogin('alice', PW)).ok, true);
    assert.equal(entry('alice'), undefined, 'success clears the entry');
  });

  test('backoff doubles per failure after each lock: 60s, 120s, 240s, 480s', async () => {
    await fail('alice', 5);
    let expected = MIN;
    for (let i = 0; i < 4; i++) {
      assert.equal(entry('alice').lockedUntil - clock, expected, `round ${i}`);
      clock = entry('alice').lockedUntil;
      await fail('alice');
      expected *= 2;
    }
  });

  test('backoff capped at maxLockMs', async () => {
    const s = new UserStore(usersPath, { throttle: { now: () => clock, maxLockMs: 5 * MIN } });
    for (let i = 0; i < 12; i++) {
      await s.attemptLogin('alice', BAD);
      const e = entry('alice');
      if (e.lockedUntil > clock) {
        assert.ok(e.lockedUntil - clock <= 5 * MIN);
        clock = e.lockedUntil;
      }
    }
    assert.equal(entry('alice').lockedUntil - clock + (clock - entry('alice').last), 5 * MIN);
  });

  test('success resets: 4 fail, success, 4 fail -> not locked', async () => {
    await fail('alice', 4);
    assert.equal((await store.attemptLogin('alice', PW)).ok, true);
    await fail('alice', 4);
    assert.equal((await store.attemptLogin('alice', PW)).ok, true);
  });

  test('lockout is per user', async () => {
    await fail('alice', 5);
    assert.equal((await store.attemptLogin('bob', PW)).ok, true);
  });

  test('username variants share one counter (normalised)', async () => {
    for (const v of ['alice', 'ALICE', ' Alice ', 'Ａｌｉｃｅ', 'alicE']) await store.attemptLogin(v, BAD);
    assert.equal((await store.attemptLogin('alice', PW)).locked, true);
  });

  test('lock state persists across store instances / processes (file-backed)', async () => {
    await fail('alice', 5);
    const other = new UserStore(usersPath, { throttle: { now: () => clock } });
    assert.equal((await other.attemptLogin('alice', PW)).locked, true);
  });

  test('concurrent burst of 20 wrong guesses: count is exact, lock engaged', async () => {
    const rs = await Promise.all(Array.from({ length: 20 }, () => store.attemptLogin('alice', BAD)));
    assert.ok(rs.every((r) => r.ok === false));
    assert.equal(entry('alice').failures, 5, 'attempts after the lock are not counted');
    assert.equal(rs.filter((r) => r.locked).length, 15);
  });

  test('concurrent burst containing the right password cannot bypass the lock', async () => {
    await fail('alice', 5);
    const rs = await Promise.all([...Array(5).fill(BAD), PW].map((p) => store.attemptLogin('alice', p)));
    assert.ok(rs.every((r) => r.ok === false && r.locked));
  });

  test('checkPassword is NOT throttled (raw primitive)', async () => {
    await fail('alice', 5);
    assert.equal(await store.checkPassword('alice', PW), true);
  });

  test('token from a successful login after lock expiry authenticates', async () => {
    await fail('alice', 5);
    clock += MIN;
    const tok = await login('alice', PW, o);
    assert.equal(authenticate(tok, o).sub, 'alice');
  });
});

describe('unknown users', () => {
  test('throttled exactly like real ones: same counts, lock timing and results', async () => {
    const seq = async (name) => {
      const out = [];
      for (let i = 0; i < 6; i++) out.push(await store.attemptLogin(name, BAD));
      return { out, e: entry(name) };
    };
    const real = await seq('alice');
    const ghost = await seq('ghost');
    assert.deepEqual(ghost.out, real.out);
    assert.deepEqual(ghost.e, real.e);
  });

  test('login error identical for unknown, wrong password, and locked', async () => {
    const msgs = new Set();
    for (const [u, p] of [['ghost', PW], ['alice', BAD]]) await login(u, p, o).catch((e) => msgs.add(`${e.constructor.name}:${e.message}`));
    await fail('alice', 5);
    await login('alice', PW, o).catch((e) => msgs.add(`${e.constructor.name}:${e.message}`));
    assert.deepEqual([...msgs], [`TbError:${LOGIN_FAILED}`]);
  });

  test('records bounded by maxEntries; oldest unlocked evicted first, real and unknown treated alike', async () => {
    const s = new UserStore(usersPath, { throttle: { now: () => clock, maxEntries: 3 } });
    await s.attemptLogin('alice', BAD);
    for (let i = 0; i < 10; i++) { clock += 1; await s.attemptLogin(`ghost${i}`, BAD); }
    const t = JSON.parse(fs.readFileSync(usersPath, 'utf8')).throttle;
    assert.deepEqual(Object.keys(t).sort(), ['ghost7', 'ghost8', 'ghost9']);
  });

  test('eviction does not reveal which users exist (real vs unknown evicted identically)', async () => {
    const run = async (name) => {
      fs.copyFileSync(path.join(template, 'users.json'), usersPath);
      const s = new UserStore(usersPath, { throttle: { now: () => clock, maxEntries: 2 } });
      await s.attemptLogin(name, BAD);
      clock += 1; await s.attemptLogin('g1', BAD);
      clock += 1; await s.attemptLogin('g2', BAD);
      return name in JSON.parse(fs.readFileSync(usersPath, 'utf8')).throttle;
    };
    assert.equal(await run('alice'), await run('nobody'));
  });

  test('locked entries outlive unlocked ones under eviction', async () => {
    const s = new UserStore(usersPath, { throttle: { now: () => clock, maxEntries: 2 } });
    for (let i = 0; i < 5; i++) await s.attemptLogin('ghost', BAD);
    for (let i = 0; i < 5; i++) { clock += 1; await s.attemptLogin(`g${i}`, BAD); }
    assert.equal((await s.attemptLogin('ghost', BAD)).locked, true);
  });

  test('a flood of unknown names cannot evict a locked real user', async () => {
    const s = new UserStore(usersPath, { throttle: { now: () => clock, maxEntries: 2 } });
    for (let i = 0; i < 5; i++) await s.attemptLogin('alice', BAD);
    for (let i = 0; i < 50; i++) await s.attemptLogin(`g${i}`, BAD);
    assert.equal((await s.attemptLogin('alice', PW)).locked, true);
  });

  test('default cap keeps the file bounded (1000 entries)', async () => {
    const s = new UserStore(usersPath, { throttle: { now: () => clock, maxEntries: 1000 } });
    // Seed 1005 entries directly to avoid 1005 scrypt runs.
    const d = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    d.throttle = {};
    for (let i = 0; i < 1005; i++) d.throttle[`g${i}`] = { failures: 1, lockedUntil: 0, last: clock - i };
    fs.writeFileSync(usersPath, JSON.stringify(d));
    await s.attemptLogin('alice', BAD);
    assert.equal(Object.keys(entry('alice') ? JSON.parse(fs.readFileSync(usersPath, 'utf8')).throttle : {}).length, 1000);
  });
});

describe('forgetting and hygiene', () => {
  test('quiet unlocked entries pruned after forgetAfterMs', async () => {
    await fail('alice', 3);
    clock += THROTTLE_DEFAULTS.forgetAfterMs + 1;
    await fail('bob');
    assert.equal(entry('alice'), undefined);
    await fail('alice', 4);
    assert.equal((await store.attemptLogin('alice', PW)).ok, true, 'count restarted');
  });

  test('locked entries are not pruned while locked', async () => {
    const s = new UserStore(usersPath, { throttle: { now: () => clock, forgetAfterMs: 1000 } });
    for (let i = 0; i < 5; i++) await s.attemptLogin('alice', BAD);
    clock += 30_000;
    await s.attemptLogin('bob', BAD);
    assert.ok(entry('alice'));
    assert.equal((await s.attemptLogin('alice', PW)).locked, true);
  });

  test('malformed input: { ok: false }, no throttle entry written', async () => {
    for (const [u, p] of [['bad name', PW], [null, PW], ['alice', null], ['alice', 'x'.repeat(2000)], [{}, PW]]) {
      assert.deepEqual(await store.attemptLogin(u, p), { ok: false });
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(usersPath, 'utf8')).throttle ?? {}, {});
  });

  test('malformed throttle entries in the file are dropped, not fatal', async () => {
    const d = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    d.throttle = { alice: { failures: 'many', lockedUntil: 9e15, last: 0 }, bob: null, x: 5 };
    fs.writeFileSync(usersPath, JSON.stringify(d));
    assert.equal((await store.attemptLogin('alice', PW)).ok, true, 'garbage lock does not lock alice out');
    const t = JSON.parse(fs.readFileSync(usersPath, 'utf8')).throttle;
    assert.deepEqual(Object.keys(t), []);
  });

  test('throttle that is not an object/null -> TbError on read; null is fine', async () => {
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf8')).users;
    for (const bad of ['[]', '"x"', '5', 'true']) {
      fs.writeFileSync(usersPath, `{"users":${JSON.stringify(users)},"throttle":${bad}}`);
      assert.throws(() => store.readData(), /expected \{"users"/, bad);
      await assert.rejects(store.attemptLogin('alice', PW), /expected \{"users"/, bad);
    }
    fs.writeFileSync(usersPath, `{"users":${JSON.stringify(users)},"throttle":null}`);
    assert.equal((await store.attemptLogin('alice', PW)).ok, true);
    fs.writeFileSync(usersPath, `{"users":${JSON.stringify(users)}}`);
    assert.equal((await store.attemptLogin('alice', PW)).ok, true, 'old format without throttle still works');
  });

  test('re-created user after delete starts unlocked', async () => {
    await fail('alice', 5);
    await store.deleteUser('alice');
    await store.createUser('alice', PW);
    assert.equal((await store.attemptLogin('alice', PW)).ok, true);
  });

  test('password changed (record replaced) during hashing -> not ok', async () => {
    // Simulate: start attempt, replace the record before it finishes.
    const p = store.attemptLogin('alice', PW);
    await new Promise((r) => setImmediate(r));
    const d = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    d.users.alice.hash = Buffer.alloc(64, 7).toString('base64');
    fs.writeFileSync(usersPath, JSON.stringify(d));
    const r = await p;
    assert.equal(r.ok, false);
  });
});

describe('policy overrides', () => {
  test('per-call override via login opts.throttle', async () => {
    const pol = { now: () => clock, maxFailures: 2 };
    await assert.rejects(login('alice', BAD, { ...o, throttle: pol }), failed);
    await assert.rejects(login('alice', BAD, { ...o, throttle: pol }), failed);
    await assert.rejects(login('alice', PW, { ...o, throttle: pol }), failed);
    assert.equal(entry('alice').lockedUntil, clock + MIN);
  });

  test('per-store override', async () => {
    const s = new UserStore(usersPath, { throttle: { now: () => clock, maxFailures: 1, baseLockMs: 1000 } });
    await s.attemptLogin('alice', BAD);
    assert.equal((await s.attemptLogin('alice', PW)).locked, true);
    clock += 1000;
    assert.equal((await s.attemptLogin('alice', PW)).ok, true);
  });

  test('default store uses real time and maxFailures 5', async () => {
    const s = new UserStore(usersPath);
    for (let i = 0; i < 5; i++) await s.attemptLogin('alice', BAD);
    const e = entry('alice');
    assert.ok(Math.abs(e.lockedUntil - (Date.now() + MIN)) < 5000);
    assert.equal((await s.attemptLogin('alice', PW)).locked, true);
  });
});

describe('eviction probe (reviewer): real vs unknown indistinguishable', () => {
  const probe = async (x) => {
    fs.copyFileSync(path.join(template, 'users.json'), usersPath);
    const s = new UserStore(usersPath, { throttle: { now: () => clock, maxEntries: 5 } });
    for (let i = 0; i < 4; i++) { clock += 1; await s.attemptLogin(x, BAD); }
    for (let i = 0; i < 6; i++) { clock += 1; await s.attemptLogin(`spray${i}`, BAD); }
    let last;
    for (let i = 0; i < 2; i++) { clock += 1; last = await s.attemptLogin(x, BAD); }
    const after = await s.attemptLogin(x, BAD);
    return { last, after, entry: entry(x) && { ...entry(x), last: undefined, lockedUntil: entry(x).lockedUntil ? 'set' : 0 } };
  };
  test('same observable result for an existing user and an unknown name', async () => {
    assert.deepEqual(await probe('alice'), await probe('nonexistent'));
  });
  test('a still-locked entry survives a spray of maxEntries+1 unlocked names', async () => {
    const s = new UserStore(usersPath, { throttle: { now: () => clock, maxEntries: 5 } });
    for (let i = 0; i < 5; i++) await s.attemptLogin('alice', BAD);
    for (let i = 0; i < 6; i++) { clock += 1; await s.attemptLogin(`spray${i}`, BAD); }
    assert.equal((await s.attemptLogin('alice', PW)).locked, true);
  });
});

describe('unlockUser', () => {
  test('clears a lockout; right password works immediately', async () => {
    await fail('alice', 5);
    assert.equal((await store.attemptLogin('alice', PW)).locked, true);
    assert.equal(await store.unlockUser(' ALICE '), 'alice');
    assert.equal(entry('alice'), undefined);
    assert.equal((await store.attemptLogin('alice', PW)).ok, true);
  });
  test('clears partial failure count', async () => {
    await fail('alice', 4);
    await store.unlockUser('alice');
    await fail('alice', 4);
    assert.equal((await store.attemptLogin('alice', PW)).ok, true);
  });
  test('no-op on a user with no entry; leaves other entries alone', async () => {
    await fail('bob', 2);
    assert.equal(await store.unlockUser('alice'), 'alice');
    assert.equal(entry('bob').failures, 2);
  });
  test('unknown user -> TbError no user (even if it has a throttle entry); invalid name -> TbError', async () => {
    await fail('ghost', 5);
    await assert.rejects(store.unlockUser('ghost'), /no user "ghost"/);
    assert.equal((await store.attemptLogin('ghost', PW)).locked, true, 'unknown-name lock untouched');
    await assert.rejects(store.unlockUser('bad name'), /username/);
  });
  test('wrapper with usersPath / store', async () => {
    const { unlockUser } = await import('../../src/auth/index.js');
    await fail('alice', 5);
    assert.equal(await unlockUser('alice', { usersPath }), 'alice');
    await fail('alice', 5);
    assert.equal(await unlockUser('alice', { store }), 'alice');
    assert.equal(entry('alice'), undefined);
    let p;
    assert.doesNotThrow(() => { p = unlockUser('alice'); });
    await assert.rejects(p, /path/);
  });
  test('does not change the token version', async () => {
    const tv = store.tokenVersion('alice');
    await store.unlockUser('alice');
    assert.equal(store.tokenVersion('alice'), tv);
  });
});

describe('throttle policy validation (fails closed)', () => {
  const bad = {
    maxFailures: [0, -1, 1.5, NaN, Infinity, '5', null, 2 ** 53],
    maxEntries: [0, -1, 1.5, '1000', null],
    baseLockMs: [0, -1, NaN, Infinity, '60000', null],
    maxLockMs: [0, -5, NaN, Infinity, null],
    forgetAfterMs: [0, -1, NaN, Infinity, null],
    now: [null, 123, 'now', {}],
  };
  for (const [k, vals] of Object.entries(bad)) {
    for (const v of vals) {
      test(`${k} = ${String(v)} -> TbError, no scrypt, no write`, async () => {
        const before = fs.readFileSync(usersPath, 'utf8');
        await assert.rejects(store.attemptLogin('alice', PW, { [k]: v }), (e) => e.constructor.name === 'TbError' && new RegExp(`throttle ${k}`).test(e.message));
        assert.equal(fs.readFileSync(usersPath, 'utf8'), before);
      });
    }
  }
  test('maxLockMs < baseLockMs -> TbError', async () => {
    await assert.rejects(store.attemptLogin('alice', PW, { baseLockMs: 1000, maxLockMs: 999 }), /maxLockMs must be at least baseLockMs/);
  });
  test('invalid per-store policy -> TbError at attempt time', async () => {
    const s = new UserStore(usersPath, { throttle: { maxFailures: 0 } });
    await assert.rejects(s.attemptLogin('alice', PW), /throttle maxFailures/);
  });
  test('login surfaces the policy error (not LOGIN_FAILED)', async () => {
    await assert.rejects(login('alice', PW, { ...o, throttle: { maxFailures: 0 } }), (e) => e.message !== LOGIN_FAILED && /throttle maxFailures/.test(e.message));
  });
  test('valid edge: maxFailures 1, maxLockMs == baseLockMs', async () => {
    const r = await store.attemptLogin('alice', BAD, { maxFailures: 1, baseLockMs: 10, maxLockMs: 10 });
    assert.equal(r.ok, false);
    assert.equal(entry('alice').lockedUntil, clock + 10);
  });
});
