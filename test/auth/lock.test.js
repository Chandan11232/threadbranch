import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withLock, LOCK_DEFAULTS } from '../../src/auth/lock.js';
import { UserStore } from '../../src/auth/users.js';
import { TbError } from '../../src/git.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'auth');
const url = (f) => pathToFileURL(path.join(SRC, f)).href;
const FAST = { timeoutMs: 300, minDelayMs: 1, maxDelayMs: 10 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let dir, file, lockPath;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-lock-'));
  file = path.join(dir, 'users.json');
  lockPath = `${file}.lock`;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const lockedOut = (e) => e instanceof TbError && /is locked by another tb process; try again/.test(e.message);
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid; // exited by the time spawnSync returns
const writeLock = (info) => fs.writeFileSync(lockPath, typeof info === 'string' ? info : JSON.stringify(info));
const leftovers = () => fs.readdirSync(dir).filter((f) => /\.(tmp|stale|lock)$/.test(f));

/** Run an ES module snippet in a child node process; resolves { code, out }. */
function child(code, args = []) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code, '--', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => p.kill('SIGKILL'), 30_000);
    p.on('close', (c, sig) => { clearTimeout(timer); resolve({ code: c, sig, out, pid: p.pid }); });
  });
}


/** Spawn a lock-holding child. `closed` resolves on exit (attached at spawn, so it is never missed);
 *  `held` resolves when the child prints HELD and rejects if it exits first. */
function holderChild(code, file) {
  const p = spawn(process.execPath, ['--input-type=module', '-e', code, '--', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  const closed = new Promise((r) => p.once('close', (c, sig) => r({ code: c, sig })));
  const held = new Promise((resolve, reject) => {
    p.stdout.once('data', resolve);
    closed.then(({ code }) => reject(new Error(`holder exited (${code}) before HELD: ${err}`)));
  });
  held.catch(() => {});
  return { p, closed, held };
}

describe('withLock basics', { timeout: 30_000 }, () => {
  test('defaults', () => assert.deepEqual(LOCK_DEFAULTS, { timeoutMs: 10000, staleMs: 30000, minDelayMs: 5, maxDelayMs: 200 }));

  test('returns fn result; lock file exists during fn with 0600 and holder info; removed after', async () => {
    const r = await withLock(file, () => {
      const st = fs.statSync(lockPath);
      if (process.platform !== 'win32') assert.equal(st.mode & 0o777, 0o600);
      const info = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      assert.equal(info.pid, process.pid);
      assert.equal(info.host, os.hostname());
      assert.equal(typeof info.at, 'number');
      assert.match(info.token, /^[0-9a-f]{32}$/);
      return 42;
    });
    assert.equal(r, 42);
    assert.equal(fs.existsSync(lockPath), false);
  });

  test('async fn result awaited', async () => {
    assert.equal(await withLock(file, async () => { await sleep(5); return 'x'; }), 'x');
    assert.equal(fs.existsSync(lockPath), false);
  });

  test('fn throwing: error propagates unchanged, lock released', async () => {
    const boom = new Error('boom');
    await assert.rejects(withLock(file, () => { throw boom; }), (e) => e === boom);
    assert.equal(fs.existsSync(lockPath), false);
    await assert.rejects(withLock(file, async () => { await sleep(1); throw boom; }), (e) => e === boom);
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(await withLock(file, () => 'again', FAST), 'again');
  });

  test('in-process callers are serialised (no overlap)', async () => {
    let inside = 0, maxInside = 0;
    const order = [];
    await Promise.all([1, 2, 3, 4, 5].map((i) => withLock(file, async () => {
      inside++; maxInside = Math.max(maxInside, inside);
      await sleep(10);
      order.push(i);
      inside--;
    }, { minDelayMs: 1, maxDelayMs: 5 })));
    assert.equal(maxInside, 1);
    assert.equal(order.length, 5);
  });

  test('missing parent dir is created (0700) before locking', async () => {
    const nested = path.join(dir, 'a', 'b', 'users.json');
    assert.equal(await withLock(nested, () => 'ok'), 'ok');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.dirname(nested)).mode & 0o777, 0o700);
    assert.equal(fs.existsSync(`${nested}.lock`), false);
  });

  test('parent path is a file -> error, not a hang', async () => {
    fs.writeFileSync(path.join(dir, 'f'), '');
    await assert.rejects(withLock(path.join(dir, 'f', 'users.json'), () => 1, FAST));
  });

  test('lock path occupied by a directory -> error, not a hang', async () => {
    fs.mkdirSync(lockPath);
    const t0 = Date.now();
    await assert.rejects(withLock(file, () => 1, { ...FAST, timeoutMs: 1000 }));
    assert.ok(Date.now() - t0 < 5000);
  });

  test('only removes its own lock: a lock replaced during fn is left alone', async () => {
    const foreign = JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now(), token: 'someone-else' });
    await withLock(file, () => { fs.writeFileSync(lockPath, foreign); });
    assert.equal(fs.readFileSync(lockPath, 'utf8'), foreign);
  });
});

describe('contention and stale locks', { timeout: 30_000 }, () => {
  test('live lock (this pid, fresh) -> times out with TbError', async () => {
    writeLock({ pid: process.pid, host: os.hostname(), at: Date.now(), token: 't' });
    const t0 = Date.now();
    await assert.rejects(withLock(file, () => 1, FAST), lockedOut);
    assert.ok(Date.now() - t0 >= FAST.timeoutMs - 20);
    assert.ok(fs.existsSync(lockPath), 'live lock not removed');
  });

  test('lock with a dead pid on this host is broken', async () => {
    writeLock({ pid: deadPid(), host: os.hostname(), at: Date.now(), token: 't' });
    assert.equal(await withLock(file, () => 'ok', FAST), 'ok');
    assert.deepEqual(leftovers(), []);
  });

  test('invalid pid values are treated as dead', async () => {
    for (const pid of [0, -1, 'abc', null, 1.5]) {
      writeLock({ pid, host: os.hostname(), at: Date.now(), token: 't' });
      assert.equal(await withLock(file, () => 'ok', FAST), 'ok', String(pid));
    }
  });

  test('old "at" is broken even when the pid is alive', async () => {
    writeLock({ pid: process.pid, host: os.hostname(), at: Date.now() - 31_000, token: 't' });
    assert.equal(await withLock(file, () => 'ok', FAST), 'ok');
  });

  test('custom staleMs honoured', async () => {
    writeLock({ pid: process.pid, host: os.hostname(), at: Date.now() - 500, token: 't' });
    await assert.rejects(withLock(file, () => 1, FAST), lockedOut);
    assert.equal(await withLock(file, () => 'ok', { ...FAST, staleMs: 100 }), 'ok');
  });

  test('dead pid on ANOTHER host is not broken while fresh', async () => {
    writeLock({ pid: deadPid(), host: `${os.hostname()}-other`, at: Date.now(), token: 't' });
    await assert.rejects(withLock(file, () => 1, FAST), lockedOut);
  });

  test('non-numeric "at" is treated as stale', async () => {
    writeLock({ pid: process.pid, host: os.hostname(), at: 'yesterday', token: 't' });
    assert.equal(await withLock(file, () => 'ok', FAST), 'ok');
  });

  test('unparsable / empty lock: waited on while fresh, broken once mtime is old', async () => {
    for (const body of ['', '{half', 'null', '42']) {
      writeLock(body);
      await assert.rejects(withLock(file, () => 1, FAST), lockedOut, JSON.stringify(body));
      const old = (Date.now() - 31_000) / 1000;
      fs.utimesSync(lockPath, old, old);
      assert.equal(await withLock(file, () => 'ok', FAST), 'ok', JSON.stringify(body));
    }
    assert.deepEqual(leftovers(), []);
  });

  test('waiter acquires once holder releases', async () => {
    let release;
    const holder = withLock(file, () => new Promise((r) => { release = r; }));
    await sleep(5);
    const waiter = withLock(file, () => 'got it', { minDelayMs: 1, maxDelayMs: 5, timeoutMs: 2000 });
    await sleep(30);
    release();
    await holder;
    assert.equal(await waiter, 'got it');
  });
});

describe('cross-process', { timeout: 60_000 }, () => {
  test('N processes x K increments of a counter under withLock: no lost updates', async () => {
    const counter = path.join(dir, 'counter');
    fs.writeFileSync(counter, '0');
    const code = `
      import fs from 'node:fs';
      import { withLock } from ${JSON.stringify(url('lock.js'))};
      const [file, k] = process.argv.slice(-2);
      for (let i = 0; i < Number(k); i++) {
        await withLock(file, async () => {
          const n = Number(fs.readFileSync(file, 'utf8'));
          await new Promise((r) => setTimeout(r, 1));
          fs.writeFileSync(file, String(n + 1));
        }, { minDelayMs: 1, maxDelayMs: 20 });
      }`;
    const N = 5, K = 20;
    const res = await Promise.all(Array.from({ length: N }, () => child(code, [counter, String(K)])));
    for (const r of res) assert.equal(r.code, 0, r.out);
    assert.equal(Number(fs.readFileSync(counter, 'utf8')), N * K);
    assert.equal(fs.existsSync(`${counter}.lock`), false);
  });

  test('N processes each creating M users concurrently: all persisted', async () => {
    const code = `
      import { UserStore } from ${JSON.stringify(url('users.js'))};
      const [file, id, m] = process.argv.slice(-3);
      const s = new UserStore(file, { lock: { minDelayMs: 1, maxDelayMs: 20 } });
      await Promise.all(Array.from({ length: Number(m) }, (_, j) => s.createUser('p' + id + 'u' + j, 'password-' + id + '-' + j)));`;
    const N = 4, M = 6;
    const res = await Promise.all(Array.from({ length: N }, (_, i) => child(code, [file, String(i), String(M)])));
    for (const r of res) assert.equal(r.code, 0, r.out);
    const store = new UserStore(file);
    const users = Object.keys(store.load());
    assert.equal(users.length, N * M);
    assert.equal(await store.checkPassword('p3u5', 'password-3-5'), true);
    assert.equal(await store.checkPassword('p0u0', 'password-0-0'), true);
    assert.deepEqual(leftovers(), []);
  });

  test('N processes racing to create the SAME user: exactly one succeeds', async () => {
    const code = `
      import { UserStore } from ${JSON.stringify(url('users.js'))};
      const [file, id] = process.argv.slice(-2);
      try { await new UserStore(file).createUser('shared', 'password-' + id); console.log('WON'); }
      catch (e) { console.log(/already exists/.test(e.message) ? 'DUP' : 'ERR ' + e.message); }`;
    const res = await Promise.all(Array.from({ length: 5 }, (_, i) => child(code, [file, String(i)])));
    const outs = res.map((r) => r.out.trim());
    assert.equal(outs.filter((o) => o === 'WON').length, 1, outs.join(','));
    assert.equal(outs.filter((o) => o === 'DUP').length, 4, outs.join(','));
    const winner = outs.indexOf('WON');
    assert.equal(await new UserStore(file).checkPassword('shared', `password-${winner}`), true);
  });

  test('holder SIGKILLed while holding the lock: next caller breaks it (dead pid)', { skip: process.platform === 'win32' }, async () => {
    const code = `
      import { withLock } from ${JSON.stringify(url('lock.js'))};
      const [file] = process.argv.slice(-1);
      setInterval(() => {}, 1000); // keep the process alive while holding
      await withLock(file, () => { console.log('HELD'); return new Promise(() => {}); });`;
    const { p, closed, held } = holderChild(code, file);
    await held;
    assert.ok(fs.existsSync(lockPath));
    await assert.rejects(withLock(file, () => 1, FAST), lockedOut, 'live holder blocks');
    p.kill('SIGKILL');
    await closed;
    assert.equal(await withLock(file, () => 'recovered', FAST), 'recovered');
    assert.deepEqual(leftovers(), []);
  });

  test('UserStore write while another process holds the lock times out with TbError', async () => {
    writeLock({ pid: process.pid, host: os.hostname(), at: Date.now(), token: 't' });
    const store = new UserStore(file, { lock: FAST });
    await assert.rejects(store.createUser('alice', 'password123'), lockedOut);
    assert.equal(fs.existsSync(file), false, 'nothing written');
  });
});

describe('review fixes', { timeout: 30_000 }, () => {
  test('regression: createUser in a non-existent nested dir works', async () => {
    const nested = path.join(dir, 'x', 'y', 'u.json');
    assert.equal(await new UserStore(nested).createUser('alice', 'password123'), 'alice');
    assert.equal(await new UserStore(nested).checkPassword('alice', 'password123'), true);
  });

  test('lock "at" is stamped at acquisition, not at first attempt (waited ~1.5s in another process)', async () => {
    const holder = `
      import { withLock } from ${JSON.stringify(url('lock.js'))};
      const [file] = process.argv.slice(-1);
      await withLock(file, async () => { console.log('HELD'); await new Promise((r) => setTimeout(r, 1500)); });`;
    const { closed, held } = holderChild(holder, file);
    await held;
    const started = Date.now();
    const { at, acquired } = await withLock(file, () => ({ at: JSON.parse(fs.readFileSync(lockPath, 'utf8')).at, acquired: Date.now() }),
      { timeoutMs: 5000, minDelayMs: 1, maxDelayMs: 20 });
    await closed;
    assert.ok(acquired - started >= 1000, `waited ${acquired - started}ms`);
    assert.ok(acquired - at < 100, `at is ${acquired - at}ms older than acquisition`);
  });

  test('unreadable lock (directory at lock path) -> TbError "cannot read lock"', async () => {
    fs.mkdirSync(lockPath);
    await assert.rejects(withLock(file, () => 1, { ...FAST, timeoutMs: 200 }), (e) => e instanceof TbError && /cannot read lock: EISDIR/.test(e.message));
  });

  test('UserStore.save is gone (no unlocked read-modify-write)', () => {
    assert.equal(typeof UserStore.prototype.save, 'undefined');
  });
});
