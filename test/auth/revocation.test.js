import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  login, authenticate, UserStore, deleteUser, revokeTokens, AUTH_FAILED, ISSUER, LOGIN_FAILED,
} from '../../src/auth/index.js';
import { TbError } from '../../src/git.js';

const SECRET = 'r'.repeat(32);
const PW = 'correct horse battery';
let dir, usersPath, store, o;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-revoke-'));
  usersPath = path.join(dir, 'users.json');
  store = new UserStore(usersPath);
  o = { secret: SECRET, usersPath, env: {} };
  await store.createUser('alice', PW);
  await store.createUser('bob', PW);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const authFail = (re) => (e) => e instanceof TbError && e.message === AUTH_FAILED && (!re || re.test(e.cause?.message ?? ''));
const isTb = (re) => (e) => e instanceof TbError && (!re || re.test(e.message));
const b64 = (x) => Buffer.from(JSON.stringify(x)).toString('base64url');
const craft = (payload, secret = SECRET) => {
  const input = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`;
  return `${input}.${crypto.createHmac('sha256', secret).update(input).digest('base64url')}`;
};
const raw = () => JSON.parse(fs.readFileSync(usersPath, 'utf8'));

describe('token version', () => {
  test('login token carries tv equal to the stored tokenVersion', async () => {
    const claims = authenticate(await login('alice', PW, o), o);
    assert.deepEqual(Object.keys(claims).sort(), ['exp', 'iat', 'iss', 'sub', 'tv']);
    assert.equal(claims.iss, ISSUER);
    assert.equal(claims.tv, store.tokenVersion('alice'));
    assert.equal(claims.tv, raw().users.alice.tokenVersion);
  });

  test('each user gets a distinct random tokenVersion', () => {
    assert.notEqual(store.tokenVersion('alice'), store.tokenVersion('bob'));
    assert.match(store.tokenVersion('alice'), /^[A-Za-z0-9_-]{20,}$/);
  });

  test('tokenVersion(name) normalises and returns null for unknown/invalid', () => {
    assert.equal(store.tokenVersion(' ALICE '), store.tokenVersion('alice'));
    for (const bad of ['nobody', 'bad name', '', null, 42, undefined, 'constructor', '__proto__']) {
      assert.equal(store.tokenVersion(bad), null, String(bad));
    }
  });

  test('tokenVersion is null for a record without a string tokenVersion', () => {
    const d = raw();
    d.users.alice.tokenVersion = 7;
    fs.writeFileSync(usersPath, JSON.stringify(d));
    assert.equal(store.tokenVersion('alice'), null);
  });
});

describe('revokeTokens', () => {
  test('old token rejected as revoked; new login works', async () => {
    const old = await login('alice', PW, o);
    assert.equal(authenticate(old, o).sub, 'alice');
    assert.equal(await store.revokeTokens(' Alice '), 'alice');
    assert.throws(() => authenticate(old, o), authFail(/^token revoked$/));
    const fresh = await login('alice', PW, o);
    assert.equal(authenticate(fresh, o).sub, 'alice');
  });

  test('revokes every outstanding token at once', async () => {
    const toks = [await login('alice', PW, o), await login('alice', PW, o), await login('alice', PW, o)];
    await store.revokeTokens('alice');
    for (const t of toks) assert.throws(() => authenticate(t, o), authFail(/token revoked/));
  });

  test('does not affect other users', async () => {
    const bobTok = await login('bob', PW, o);
    await store.revokeTokens('alice');
    assert.equal(authenticate(bobTok, o).sub, 'bob');
  });

  test('password still works after revoke', async () => {
    await store.revokeTokens('alice');
    assert.equal(await store.checkPassword('alice', PW), true);
  });

  test('unknown user -> TbError no user; invalid name -> TbError', async () => {
    await assert.rejects(store.revokeTokens('nobody'), isTb(/no user "nobody"/));
    await assert.rejects(store.revokeTokens('bad name'), isTb(/username/));
    await assert.rejects(store.revokeTokens('constructor'), isTb(/no user/));
  });

  test('wrapper with usersPath and with store', async () => {
    const t1 = await login('alice', PW, o);
    assert.equal(await revokeTokens('ALICE', { usersPath }), 'alice');
    assert.throws(() => authenticate(t1, o), authFail(/revoked/));
    const t2 = await login('alice', PW, o);
    assert.equal(await revokeTokens('alice', { store }), 'alice');
    assert.throws(() => authenticate(t2, o), authFail(/revoked/));
  });

  test('wrapper without usersPath/store rejects (not a sync throw)', async () => {
    let p;
    assert.doesNotThrow(() => { p = revokeTokens('alice'); });
    await assert.rejects(p, isTb(/path/));
  });

  test('a validly signed token with a guessed/absent tv is rejected', () => {
    const base = { sub: 'alice', iss: ISSUER, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 };
    assert.throws(() => authenticate(craft(base), o), authFail(/revoked/));
    assert.throws(() => authenticate(craft({ ...base, tv: 'guess' }), o), authFail(/revoked/));
    assert.throws(() => authenticate(craft({ ...base, tv: null }), o), authFail(/revoked/));
    assert.equal(authenticate(craft({ ...base, tv: store.tokenVersion('alice') }), o).sub, 'alice');
  });

  test('right tv but wrong secret still rejected', () => {
    const now = Math.floor(Date.now() / 1000);
    const forged = craft({ sub: 'alice', iss: ISSUER, tv: store.tokenVersion('alice'), iat: now, exp: now + 60 }, 'x'.repeat(32));
    assert.throws(() => authenticate(forged, o), authFail(/invalid token signature/));
  });
});

describe('deleteUser', () => {
  test('token of deleted user rejected; login fails; others unaffected', async () => {
    const aliceTok = await login('alice', PW, o);
    const bobTok = await login('bob', PW, o);
    assert.equal(await store.deleteUser('ALICE'), 'alice');
    assert.throws(() => authenticate(aliceTok, o), authFail(/^user no longer exists$/));
    await assert.rejects(login('alice', PW, o), (e) => e.message === LOGIN_FAILED);
    assert.equal(authenticate(bobTok, o).sub, 'bob');
    assert.equal('alice' in raw().users, false);
  });

  test('re-created user with the same name does not revive old tokens', async () => {
    const old = await login('alice', PW, o);
    await store.deleteUser('alice');
    await store.createUser('alice', PW);
    assert.throws(() => authenticate(old, o), authFail(/token revoked/));
    assert.equal(authenticate(await login('alice', PW, o), o).sub, 'alice');
  });

  test('removes the throttle entry too', async () => {
    await assert.rejects(login('alice', 'wrong password', o));
    assert.ok('alice' in raw().throttle);
    await store.deleteUser('alice');
    assert.equal('alice' in raw().throttle, false);
  });

  test('unknown user -> TbError; invalid name -> TbError; file untouched', async () => {
    const before = fs.readFileSync(usersPath, 'utf8');
    await assert.rejects(store.deleteUser('nobody'), isTb(/no user "nobody"/));
    await assert.rejects(store.deleteUser('../etc'), isTb(/username/));
    await assert.rejects(store.deleteUser('constructor'), isTb(/no user/));
    assert.equal(fs.readFileSync(usersPath, 'utf8'), before);
  });

  test('deleting twice: second rejects', async () => {
    await store.deleteUser('bob');
    await assert.rejects(store.deleteUser('bob'), isTb(/no user/));
  });

  test('wrapper with usersPath and with store', async () => {
    assert.equal(await deleteUser('alice', { usersPath }), 'alice');
    assert.equal(await deleteUser('bob', { store }), 'bob');
    assert.deepEqual(Object.keys(store.load()), []);
  });

  test('concurrent revoke + delete + create on the store all apply', async () => {
    await Promise.all([store.revokeTokens('alice'), store.deleteUser('bob'), store.createUser('carol', PW)]);
    assert.deepEqual(Object.keys(store.load()).sort(), ['alice', 'carol']);
  });
});

describe('authenticate config errors are not AUTH_FAILED', () => {
  let tok;
  beforeEach(async () => { tok = await login('alice', PW, o); });

  test('missing usersPath/store -> TbError about path', () => {
    assert.throws(() => authenticate(tok, { secret: SECRET, env: {} }), (e) => e instanceof TbError && e.message !== AUTH_FAILED && /path/.test(e.message));
  });
  test('missing secret -> no JWT secret', () => {
    assert.throws(() => authenticate(tok, { usersPath, env: {} }), isTb(/no JWT secret/));
  });
  test('corrupt store -> its own TbError', () => {
    fs.writeFileSync(usersPath, '{bad');
    assert.throws(() => authenticate(tok, o), (e) => e instanceof TbError && e.message !== AUTH_FAILED && /not valid JSON/.test(e.message));
  });
  test('missing store file -> AUTH_FAILED user no longer exists', () => {
    fs.rmSync(usersPath);
    assert.throws(() => authenticate(tok, o), authFail(/user no longer exists/));
  });
  test('AUTH_FAILED message never contains the reason or the username', () => {
    try { authenticate(tok, { ...o, secret: 'z'.repeat(32) }); assert.fail('should throw'); } catch (e) {
      assert.equal(e.message, AUTH_FAILED);
      assert.equal(e.message.includes('alice'), false);
      assert.ok(e.cause instanceof Error);
    }
  });
});

describe('legacy records without tokenVersion', () => {
  test('login assigns a tokenVersion and the token authenticates', async () => {
    const d = raw();
    delete d.users.alice.tokenVersion;
    fs.writeFileSync(usersPath, JSON.stringify(d));
    assert.equal(store.tokenVersion('alice'), null);
    const tok = await login('alice', PW, o);
    assert.equal(typeof store.tokenVersion('alice'), 'string');
    assert.equal(authenticate(tok, o).sub, 'alice');
  });

  test('revokeTokens works on a legacy record', async () => {
    const d = raw();
    delete d.users.alice.tokenVersion;
    fs.writeFileSync(usersPath, JSON.stringify(d));
    await store.revokeTokens('alice');
    assert.equal(typeof store.tokenVersion('alice'), 'string');
  });
});
