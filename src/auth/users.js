import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { TbError } from '../git.js';
import { withLock } from './lock.js';

const scrypt = promisify(crypto.scrypt);

export const MIN_PASSWORD_LENGTH = 8;
// Bytes, not characters: caps the work an attacker can force per attempt.
export const MAX_PASSWORD_BYTES = 1024;
const USERNAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// Stored with each record so parameters can be raised later without breaking old hashes.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SALT_BYTES = 16;

export const THROTTLE_DEFAULTS = {
  // Consecutive failures before the account locks.
  maxFailures: 5,
  // First lock lasts this long; each further failure after a lock doubles it, up to maxLockMs.
  baseLockMs: 60_000,
  maxLockMs: 24 * 3600_000,
  // Failure counts are forgotten this long after the last attempt (or the end of the lock).
  forgetAfterMs: 24 * 3600_000,
  // Hard cap on throttle records, so guessing at unknown usernames cannot grow the file without bound.
  maxEntries: 1000,
  // Clock in milliseconds; injectable for tests.
  now: () => Date.now(),
};

// Embedded in tokens as "tv"; replacing it (revoke) or removing the user invalidates every token.
// Random rather than a counter, so a user deleted and re-created never matches old tokens.
const newTokenVersion = () => crypto.randomBytes(16).toString('base64url');

/** Canonical form of a username: NFKC, trimmed, lower-case, from a small safe alphabet. */
export function normalizeUsername(username) {
  if (typeof username !== 'string') throw new TbError('username must be a string');
  const u = username.normalize('NFKC').trim().toLowerCase();
  if (!USERNAME.test(u)) {
    throw new TbError('username must be 1-64 characters of a-z, 0-9, ".", "_" or "-", starting with a letter or digit');
  }
  return u;
}

// Login-time check: only type and the size cap that bounds per-attempt work. The minimum
// length is a creation policy, so raising it later never locks out existing users.
function checkPasswordInput(password) {
  if (typeof password !== 'string') throw new TbError('password must be a string');
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) throw new TbError(`password must be at most ${MAX_PASSWORD_BYTES} bytes`);
}

function checkNewPassword(password) {
  checkPasswordInput(password);
  // Code points, so an emoji counts as one character.
  if ([...password].length < MIN_PASSWORD_LENGTH) throw new TbError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
}

// scrypt needs about 128*N*r bytes; anything a stored record asks for must fit under this.
const MAX_SCRYPT_MEM = 64 * 1024 * 1024;

async function derive(password, salt, { N, r, p, keylen }) {
  const maxmem = Math.min(128 * N * r + 1024 * 1024, MAX_SCRYPT_MEM + 1024 * 1024);
  return scrypt(password.normalize('NFKC'), salt, keylen, { N, r, p, maxmem });
}

// Hashed against when the user does not exist, so unknown users cost the same time as wrong passwords.
let dummy;
function dummyRecord() {
  dummy ??= { salt: crypto.randomBytes(SALT_BYTES).toString('base64'), hash: Buffer.alloc(SCRYPT.keylen).toString('base64'), params: SCRYPT };
  return dummy;
}

export class UserStore {
  /**
   * @param filePath  JSON file holding users and login-throttle state.
   * @param opts.lock     overrides for the cross-process lock (see LOCK_DEFAULTS in lock.js).
   * @param opts.throttle overrides for THROTTLE_DEFAULTS.
   */
  constructor(filePath, { lock = {}, throttle = {} } = {}) {
    if (typeof filePath !== 'string' || !filePath) throw new TbError('UserStore needs a file path');
    this.path = filePath;
    this.lockOpts = lock;
    this.throttleOpts = throttle;
  }

  /** The whole file as { users, throttle }, both null-prototype maps. */
  readData() {
    let text;
    try {
      text = fs.readFileSync(this.path, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return { users: Object.create(null), throttle: Object.create(null) };
      throw new TbError(`${this.path}: cannot read user store: ${e.message}`);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new TbError(`${this.path}: not valid JSON`);
    }
    const isMap = (v) => v == null || (typeof v === 'object' && !Array.isArray(v));
    if (data === null || typeof data !== 'object' || Array.isArray(data) || !isMap(data.users) || !isMap(data.throttle)) {
      throw new TbError(`${this.path}: expected {"users": {...}}`);
    }
    // Null prototype: usernames like "constructor" are plain keys, never inherited members.
    return {
      users: Object.assign(Object.create(null), data.users),
      throttle: Object.assign(Object.create(null), data.throttle),
    };
  }

  writeData({ users, throttle }) {
    // Owner-only: the directory holds credentials (applies only when newly created).
    fs.mkdirSync(path.dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ users, throttle }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.path);
  }

  /** Read-modify-write under the cross-process lock. fn gets { users, throttle } and may mutate it. */
  async update(fn) {
    return withLock(this.path, () => {
      const data = this.readData();
      const result = fn(data);
      this.writeData(data);
      return result;
    }, this.lockOpts);
  }

  /** Users only (null-prototype map). Writes are atomic renames, so reading needs no lock. */
  load() {
    return this.readData().users;
  }

  /** Create a user; throws TbError on an invalid username/password or a taken username. Returns the normalised username. */
  async createUser(username, password) {
    const name = normalizeUsername(username);
    checkNewPassword(password);
    if (name in this.load()) throw new TbError(`user "${name}" already exists`);
    // Hash outside the lock: scrypt is the slow part and needs no shared state.
    const salt = crypto.randomBytes(SALT_BYTES);
    const hash = await derive(password, salt, SCRYPT);
    await this.update(({ users }) => {
      if (name in users) throw new TbError(`user "${name}" already exists`);
      users[name] = {
        salt: salt.toString('base64'), hash: hash.toString('base64'), params: SCRYPT,
        tokenVersion: newTokenVersion(), createdAt: new Date().toISOString(),
      };
    });
    return name;
  }

  /** Delete a user and their throttle state; their existing tokens stop working. TbError if absent. */
  async deleteUser(username) {
    const name = normalizeUsername(username);
    await this.update(({ users, throttle }) => {
      if (!(name in users)) throw new TbError(`no user "${name}"`);
      delete users[name];
      delete throttle[name];
    });
    return name;
  }

  /** Invalidate every token issued to a user so far. TbError if absent. */
  async revokeTokens(username) {
    const name = normalizeUsername(username);
    await this.update(({ users }) => {
      if (!(name in users)) throw new TbError(`no user "${name}"`);
      users[name].tokenVersion = newTokenVersion();
    });
    return name;
  }

  /** Clear a user's failed-login count and any lockout (admin remedy for a lockout DoS). TbError if absent. */
  async unlockUser(username) {
    const name = normalizeUsername(username);
    await this.update(({ users, throttle }) => {
      if (!(name in users)) throw new TbError(`no user "${name}"`);
      delete throttle[name];
    });
    return name;
  }

  /** The user's current token version, or null if the user does not exist. Never throws on bad input. */
  tokenVersion(username) {
    let name;
    try {
      name = normalizeUsername(username);
    } catch {
      return null;
    }
    const rec = this.load()[name];
    return rec && typeof rec.tokenVersion === 'string' ? rec.tokenVersion : null;
  }

  /**
   * True only for an existing user with the right password; false for an unknown user, a wrong
   * password or malformed input. Throws TbError only when the store itself is unreadable or corrupt.
   * NOT FOR LOGIN: it is unthrottled. Use attemptLogin() / login(), which enforce the lockout.
   */
  async checkPassword(username, password) {
    let name;
    try {
      name = normalizeUsername(username);
      checkPasswordInput(password);
    } catch {
      return false;
    }
    return matches(this.load()[name], password);
  }

  /**
   * A throttled password check for login. Resolves { ok: true, username, tokenVersion } on success,
   * otherwise { ok: false } (plus locked: true when refused by the lockout, for callers that log;
   * never show it to the user). Every attempt is counted as a failure before the hash is checked, so
   * concurrent guesses cannot slip past the limit; success clears the count. While locked, scrypt is
   * not run at all. Unknown usernames are throttled exactly like real ones.
   */
  async attemptLogin(username, password, policy = {}) {
    const pol = checkPolicy({ ...THROTTLE_DEFAULTS, ...this.throttleOpts, ...policy });
    let name;
    try {
      name = normalizeUsername(username);
      checkPasswordInput(password);
    } catch {
      return { ok: false };
    }
    const pre = await this.update(({ users, throttle }) => {
      const t = pol.now();
      prune(throttle, t, pol);
      const e = throttle[name] ?? { failures: 0, lockedUntil: 0, last: 0 };
      if (t < e.lockedUntil) return { locked: true };
      e.failures += 1;
      e.last = t;
      if (e.failures >= pol.maxFailures) {
        e.lockedUntil = t + Math.min(pol.baseLockMs * 2 ** (e.failures - pol.maxFailures), pol.maxLockMs);
      }
      throttle[name] = e;
      cap(throttle, t, pol.maxEntries);
      return { record: users[name] };
    });
    if (pre.locked) return { ok: false, locked: true };
    if (!(await matches(pre.record, password))) return { ok: false };
    return this.update(({ users, throttle }) => {
      const rec = users[name];
      // Deleted, or password changed, while we were hashing.
      if (!rec || rec.hash !== pre.record.hash) return { ok: false };
      delete throttle[name];
      if (typeof rec.tokenVersion !== 'string') rec.tokenVersion = newTokenVersion();
      return { ok: true, username: name, tokenVersion: rec.tokenVersion };
    });
  }
}

async function matches(record, password) {
  const rec = record && validRecord(record) ? record : dummyRecord();
  const expected = Buffer.from(rec.hash, 'base64');
  const actual = await derive(password, Buffer.from(rec.salt, 'base64'), rec.params);
  const match = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  return match && rec !== dummy;
}

/** Fail closed: a bad threshold must not silently weaken or disable the lockout. */
function checkPolicy(pol) {
  const posInt = (k) => {
    if (!Number.isSafeInteger(pol[k]) || pol[k] < 1) throw new TbError(`throttle ${k} must be a whole number of at least 1`);
  };
  posInt('maxFailures');
  posInt('maxEntries');
  for (const k of ['baseLockMs', 'maxLockMs', 'forgetAfterMs']) {
    if (!Number.isFinite(pol[k]) || pol[k] <= 0) throw new TbError(`throttle ${k} must be a positive number of milliseconds`);
  }
  if (pol.maxLockMs < pol.baseLockMs) throw new TbError('throttle maxLockMs must be at least baseLockMs');
  if (typeof pol.now !== 'function') throw new TbError('throttle now must be a function');
  return pol;
}

function validEntry(e) {
  return e && typeof e === 'object' && [e.failures, e.lockedUntil, e.last].every(Number.isFinite);
}

/** Drop malformed entries and ones that are unlocked and quiet for forgetAfterMs. */
function prune(throttle, t, { forgetAfterMs }) {
  for (const [k, e] of Object.entries(throttle)) {
    if (!validEntry(e) || (t >= e.lockedUntil && t - Math.max(e.last, e.lockedUntil) > forgetAfterMs)) delete throttle[k];
  }
}

/**
 * Keep at most max entries: evict unlocked before locked (so a lock cannot be cheaply flushed), oldest
 * first. Deliberately blind to whether the name is a real user: ranking on that would let an attacker
 * learn which names exist by watching whose count survives an eviction spray.
 */
function cap(throttle, t, max) {
  const keys = Object.keys(throttle);
  if (keys.length <= max) return;
  const rank = (k) => [t < throttle[k].lockedUntil ? 1 : 0, throttle[k].last];
  keys.sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    return ra[0] - rb[0] || ra[1] - rb[1];
  });
  for (const k of keys.slice(0, keys.length - max)) delete throttle[k];
}

function validRecord(r) {
  const p = r.params;
  return typeof r.salt === 'string' && typeof r.hash === 'string' && p &&
    // Bound the memory product (128*N*r), not each field alone.
    Number.isInteger(p.N) && p.N >= 2 && (p.N & (p.N - 1)) === 0 &&
    Number.isInteger(p.r) && p.r >= 1 && 128 * p.N * p.r <= MAX_SCRYPT_MEM &&
    Number.isInteger(p.p) && p.p >= 1 && p.p <= 4 &&
    Number.isInteger(p.keylen) && p.keylen >= 16 && p.keylen <= 128;
}

// Async so a missing usersPath is a rejected promise, never a synchronous throw.
export async function createUser(username, password, { usersPath } = {}) {
  return new UserStore(usersPath).createUser(username, password);
}
export async function checkPassword(username, password, { usersPath } = {}) {
  return new UserStore(usersPath).checkPassword(username, password);
}
export async function deleteUser(username, { usersPath, store } = {}) {
  return (store ?? new UserStore(usersPath)).deleteUser(username);
}
export async function unlockUser(username, { usersPath, store } = {}) {
  return (store ?? new UserStore(usersPath)).unlockUser(username);
}
export async function revokeTokens(username, { usersPath, store } = {}) {
  return (store ?? new UserStore(usersPath)).revokeTokens(username);
}
