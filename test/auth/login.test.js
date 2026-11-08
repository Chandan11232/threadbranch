import { test, describe, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as auth from '../../src/auth/index.js';
import { login, authenticate, resolveSecret, DEFAULT_EXPIRES_IN, LOGIN_FAILED, UserStore, sign } from '../../src/auth/index.js';
import { TbError } from '../../src/git.js';

const SECRET = 's'.repeat(32);
const OTHER = 'o'.repeat(32);
const PW = 'correct horse battery';
const NOW = 1_800_000_000;
let dir, usersPath, store;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-login-'));
  usersPath = path.join(dir, 'users.json');
  store = new UserStore(usersPath);
  await store.createUser('Alice', PW);
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));
beforeEach((t) => t.mock.method(Date, 'now', () => NOW * 1000));

const isTb = (re) => (e) => e instanceof TbError && (!re || re.test(e.message));
const failed = (e) => e instanceof TbError && e.message === LOGIN_FAILED;
// Every token rejection is AUTH_FAILED; the specific reason is on err.cause.
const authFail = (re) => (e) => e instanceof TbError && e.message === auth.AUTH_FAILED && (!re || re.test(e.cause?.message ?? ''));
const NO_LOCKOUT = { maxFailures: 1e6 };
const opts = (extra = {}) => ({ secret: SECRET, usersPath, env: {}, throttle: NO_LOCKOUT, ...extra });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const craft = (payload, secret = SECRET, header = { alg: 'HS256', typ: 'JWT' }) => {
  const input = `${b64(header)}.${b64(payload)}`;
  return `${input}.${crypto.createHmac('sha256', secret).update(input).digest('base64url')}`;
};

describe('index.js exports', () => {
  test('re-exports everything announced', () => {
    for (const name of ['sign', 'verify', 'MIN_SECRET_BYTES', 'CLOCK_SKEW_SECONDS', 'UserStore', 'createUser', 'checkPassword',
      'normalizeUsername', 'MIN_PASSWORD_LENGTH', 'MAX_PASSWORD_BYTES', 'login', 'authenticate', 'resolveSecret',
      'DEFAULT_EXPIRES_IN', 'LOGIN_FAILED', 'secretBytes', 'ISSUER', 'MAX_TOKEN_LENGTH', 'MAX_EXPIRES_IN_SECONDS']) {
      assert.ok(name in auth, name);
    }
    assert.equal(DEFAULT_EXPIRES_IN, '1h');
    assert.equal(LOGIN_FAILED, 'invalid username or password');
  });
});

describe('resolveSecret', () => {
  test('opts.secret wins over env', () => assert.equal(resolveSecret({ secret: SECRET, env: { TB_JWT_SECRET: OTHER } }), SECRET));
  test('falls back to env.TB_JWT_SECRET', () => assert.equal(resolveSecret({ env: { TB_JWT_SECRET: OTHER } }), OTHER));
  test('missing everywhere -> TbError', () => assert.throws(() => resolveSecret({ env: {} }), isTb(/no JWT secret/)));
  test('empty env value -> TbError', () => assert.throws(() => resolveSecret({ env: { TB_JWT_SECRET: '' } }), isTb(/no JWT secret/)));
  test('empty opts.secret -> TbError (not silently env)', () => assert.throws(() => resolveSecret({ secret: '', env: { TB_JWT_SECRET: OTHER } }), isTb(/no JWT secret/)));
  test('defaults to process.env', (t) => {
    const prev = process.env.TB_JWT_SECRET;
    process.env.TB_JWT_SECRET = OTHER;
    t.after(() => { if (prev === undefined) delete process.env.TB_JWT_SECRET; else process.env.TB_JWT_SECRET = prev; });
    assert.equal(resolveSecret(), OTHER);
  });
  test('error message does not leak any secret value', () => {
    try { resolveSecret({ env: {} }); } catch (e) { assert.equal(e.message.includes(SECRET), false); }
  });
});

describe('login', () => {
  test('returns a token whose sub is the normalised username and exp = iat + 1h', async () => {
    const tok = await login(' ALICE ', PW, opts());
    const claims = authenticate(tok, opts());
    assert.equal(claims.sub, 'alice');
    assert.equal(claims.iat, NOW);
    assert.equal(claims.exp, NOW + 3600);
    assert.deepEqual(Object.keys(claims).sort(), ['exp', 'iat', 'iss', 'sub', 'tv']);
    assert.equal(claims.iss, auth.ISSUER);
    assert.equal(claims.tv, store.tokenVersion('alice'));
  });

  test('custom expiresIn honoured', async () => {
    const claims = authenticate(await login('alice', PW, opts({ expiresIn: '5m' })), opts());
    assert.equal(claims.exp, NOW + 300);
  });

  test('accepts a store instance instead of usersPath', async () => {
    const tok = await login('alice', PW, { secret: SECRET, store, env: {} });
    assert.equal(authenticate(tok, opts()).sub, 'alice');
  });

  test('secret from env.TB_JWT_SECRET', async () => {
    const env = { TB_JWT_SECRET: OTHER };
    const tok = await login('alice', PW, { usersPath, env });
    assert.equal(authenticate(tok, { env, usersPath }).sub, 'alice');
    assert.throws(() => authenticate(tok, opts()), authFail(/invalid token signature/));
  });

  test('wrong password and unknown user give the identical error', async () => {
    const errs = [];
    for (const [u, p] of [['alice', 'wrong password'], ['mallory', PW], ['nobody', 'wrong password']]) {
      await assert.rejects(login(u, p, opts()), (e) => { errs.push(e); return failed(e); });
    }
    assert.equal(new Set(errs.map((e) => e.message)).size, 1);
    assert.equal(new Set(errs.map((e) => e.constructor)).size, 1);
  });

  for (const [u, p] of [['bad name', PW], ['', PW], [null, PW], [{}, PW], ['alice', ''], ['alice', 'short'], ['alice', null],
    ['alice', 'x'.repeat(2000)], ['__proto__', PW], ['constructor', PW]]) {
    test(`bad shape (${JSON.stringify(u)}, ${typeof p === 'string' ? `${p.length}ch` : JSON.stringify(p)}) -> LOGIN_FAILED`, async () => {
      await assert.rejects(login(u, p, opts()), failed);
    });
  }

  test('LOGIN_FAILED message does not echo the username', async () => {
    await assert.rejects(login('mallory', PW, opts()), (e) => !e.message.includes('mallory'));
  });

  test('missing secret rejects before any credential work (even for valid creds)', async (t) => {
    const spy = t.mock.method(UserStore.prototype, 'checkPassword');
    const spy2 = t.mock.method(UserStore.prototype, 'attemptLogin');
    await assert.rejects(login('alice', PW, { usersPath, env: {} }), isTb(/no JWT secret/));
    await assert.rejects(login('mallory', 'nope nope', { usersPath, env: { TB_JWT_SECRET: '' } }), isTb(/no JWT secret/));
    assert.equal(spy.mock.callCount() + spy2.mock.callCount(), 0);
  });

  test('missing secret is a rejection, not a synchronous throw', () => {
    let p;
    assert.doesNotThrow(() => { p = login('alice', PW, { usersPath, env: {} }); });
    return assert.rejects(p, isTb(/no JWT secret/));
  });

  test('short secret rejected with valid creds', async () => {
    await assert.rejects(login('alice', PW, opts({ secret: 'x'.repeat(31) })), isTb(/at least 32 bytes/));
  });

  test('short secret is a config error reported the same regardless of credentials (before credential work)', async (t) => {
    const spy = t.mock.method(UserStore.prototype, 'checkPassword');
    const spy2 = t.mock.method(UserStore.prototype, 'attemptLogin');
    await assert.rejects(login('mallory', 'wrong password', opts({ secret: 'x'.repeat(31) })), isTb(/at least 32 bytes/));
    await assert.rejects(login('alice', 'wrong password', opts({ secret: 'x'.repeat(31) })), isTb(/at least 32 bytes/));
    assert.equal(spy.mock.callCount() + spy2.mock.callCount(), 0);
  });

  test('missing usersPath and store -> TbError rejection', async () => {
    await assert.rejects(login('alice', PW, { secret: SECRET, env: {} }), isTb(/path/));
  });

  test('two logins produce tokens that both authenticate', async () => {
    const a = await login('alice', PW, opts());
    Date.now.mock.mockImplementation(() => (NOW + 5) * 1000);
    const b = await login('alice', PW, opts());
    assert.notEqual(a, b);
    assert.equal(authenticate(a, opts()).sub, 'alice');
    assert.equal(authenticate(b, opts()).sub, 'alice');
  });
});

describe('authenticate', () => {
  let tok;
  before(async () => {
    const m = mock.method(Date, 'now', () => NOW * 1000);
    try { tok = await login('alice', PW, { secret: SECRET, usersPath, env: {} }); } finally { m.mock.restore(); }
  });

  test('is synchronous and returns claims', () => {
    const r = authenticate(tok, opts());
    assert.equal(typeof r?.then, 'undefined');
    assert.equal(r.sub, 'alice');
  });

  test('missing secret -> TbError', () => assert.throws(() => authenticate(tok, { env: {} }), isTb(/no JWT secret/)));
  test('wrong secret -> invalid signature', () => assert.throws(() => authenticate(tok, opts({ secret: OTHER })), authFail(/invalid token signature/)));
  test('short secret -> TbError', () => assert.throws(() => authenticate(tok, opts({ secret: 'x' })), isTb(/at least 32/)));

  test('token expires after 1h + skew', () => {
    const real = Math.floor(Date.now() / 1000);
    const claims = authenticate(tok, opts());
    Date.now.mock.mockImplementation(() => (claims.exp + 30) * 1000);
    assert.ok(authenticate(tok, opts()));
    Date.now.mock.mockImplementation(() => (claims.exp + 31) * 1000);
    assert.throws(() => authenticate(tok, opts()), authFail(/token expired/));
    assert.ok(real);
  });

  test('tampered sub (privilege swap) rejected', () => {
    const [h, , s] = tok.split('.');
    const forged = `${h}.${b64({ sub: 'admin', iat: NOW, exp: NOW + 3600 })}.${s}`;
    assert.throws(() => authenticate(forged, opts()), authFail(/invalid token signature/));
  });

  test('alg none forgery rejected', () => {
    const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'alice', iat: NOW, exp: NOW + 3600 })}.`;
    assert.throws(() => authenticate(forged, opts()), authFail(/unsupported token algorithm/));
  });

  for (const [name, payload, re] of [
    ['missing sub', { exp: NOW + 60 }, /missing subject/],
    ['empty sub', { sub: '', exp: NOW + 60 }, /missing subject/],
    ['numeric sub', { sub: 42, exp: NOW + 60 }, /missing subject/],
    ['null sub', { sub: null, exp: NOW + 60 }, /missing subject/],
    ['array sub', { sub: ['alice'], exp: NOW + 60 }, /missing subject/],
    ['object sub', { sub: { name: 'alice' }, exp: NOW + 60 }, /missing subject/],
    ['missing exp', { sub: 'alice' }, /missing exp/],
    ['string exp', { sub: 'alice', exp: String(NOW + 60) }, /exp must be a number/],
  ]) {
    test(`validly signed token with ${name} rejected`, () => assert.throws(() => authenticate(craft(payload), opts()), authFail(re)));
  }

  test('sign() without expiresIn is not accepted by authenticate (no immortal tokens)', () => {
    assert.throws(() => authenticate(sign({ sub: 'alice' }, SECRET), opts()), authFail(/missing exp/));
  });

  for (const bad of [undefined, null, '', 'garbage', 'a.b.c', 42, {}]) {
    test(`malformed token ${JSON.stringify(bad)} -> TbError`, () => assert.throws(() => authenticate(bad, opts()), authFail()));
  }

  test('Bearer prefix is not stripped (caller must strip)', () => {
    assert.throws(() => authenticate(`Bearer ${tok}`, opts()), authFail());
  });
});

describe('login -> authenticate end to end via process.env', () => {
  test('round trip using only TB_JWT_SECRET', async (t) => {
    const prev = process.env.TB_JWT_SECRET;
    process.env.TB_JWT_SECRET = crypto.randomBytes(32).toString('hex');
    t.after(() => { if (prev === undefined) delete process.env.TB_JWT_SECRET; else process.env.TB_JWT_SECRET = prev; });
    const tok = await login('alice', PW, { usersPath });
    assert.equal(authenticate(tok, { usersPath }).sub, 'alice');
  });

  test('new user created via convenience createUser can log in', async () => {
    await auth.createUser('Bob.Smith', 'bobs password', { usersPath });
    const claims = authenticate(await login('bob.smith', 'bobs password', opts()), opts());
    assert.equal(claims.sub, 'bob.smith');
  });
});

describe('issuer and subject hardening', () => {
  let ok;
  beforeEach(() => { ok = { sub: 'alice', iss: 'threadbranch', tv: store.tokenVersion('alice'), iat: NOW, exp: NOW + 60 }; });
  test('ISSUER exported as "threadbranch"', () => assert.equal(auth.ISSUER, 'threadbranch'));
  test('hand-crafted token with correct claims accepted', () => assert.equal(authenticate(craft(ok), opts()).sub, 'alice'));
  for (const [name, patch, re] of [
    ['missing iss', { iss: undefined }, /wrong issuer/],
    ['other iss', { iss: 'other-tool' }, /wrong issuer/],
    ['iss case variant', { iss: 'ThreadBranch' }, /wrong issuer/],
    ['iss as array', { iss: ['threadbranch'] }, /wrong issuer/],
    ['sub uppercase', { sub: 'Alice' }, /not a valid username/],
    ['sub with trailing space', { sub: 'admin ' }, /not a valid username/],
    ['sub fullwidth', { sub: 'ａｌｉｃｅ' }, /not a valid username/],
    ['sub path traversal', { sub: '../etc' }, /not a valid username/],
    ['sub __proto__', { sub: '__proto__' }, /not a valid username/],
  ]) {
    test(`${name} rejected`, () => {
      const payload = { ...ok, ...patch };
      for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
      assert.throws(() => authenticate(craft(payload), opts()), authFail(re));
    });
  }
  test('raw verify() still accepts a token without iss (issuer check lives in authenticate)', () => {
    assert.equal(auth.verify(craft({ sub: 'x', exp: NOW + 60 }), SECRET).sub, 'x');
  });
});

describe('resolveSecret edge cases', () => {
  test('secret: null does not silently fall back to env', () => {
    assert.throws(() => resolveSecret({ secret: null, env: { TB_JWT_SECRET: OTHER } }), isTb());
  });
  test('env: null -> TbError, not TypeError', () => assert.throws(() => resolveSecret({ env: null }), isTb(/no JWT secret/)));
  test('short env secret rejected at resolve time', () => {
    assert.throws(() => resolveSecret({ env: { TB_JWT_SECRET: 'short' } }), isTb(/at least 32/));
  });
  for (const bad of [12345, {}, [], true]) {
    test(`non-string/Buffer secret ${JSON.stringify(bad)} rejected`, () => assert.throws(() => resolveSecret({ secret: bad, env: {} }), isTb()));
  }
  test('Buffer secret accepted and usable end to end', async () => {
    const buf = crypto.randomBytes(32);
    const tok = await login('alice', PW, { secret: buf, usersPath, env: {} });
    assert.equal(authenticate(tok, { secret: buf, env: {}, usersPath }).sub, 'alice');
  });
  test('short secret via env also rejected before credential work', async (t) => {
    const spy = t.mock.method(UserStore.prototype, 'checkPassword');
    const spy2 = t.mock.method(UserStore.prototype, 'attemptLogin');
    await assert.rejects(login('alice', PW, { usersPath, env: { TB_JWT_SECRET: 'x'.repeat(31) } }), isTb(/at least 32/));
    assert.equal(spy.mock.callCount() + spy2.mock.callCount(), 0);
  });
});
