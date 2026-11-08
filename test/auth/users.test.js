import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  UserStore, createUser, checkPassword, normalizeUsername, MIN_PASSWORD_LENGTH, MAX_PASSWORD_BYTES,
} from '../../src/auth/users.js';
import { TbError } from '../../src/git.js';

const PW = 'correct horse battery';
let dir, file, store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-users-'));
  file = path.join(dir, 'nested', 'users.json');
  store = new UserStore(file);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const isTb = (re) => (e) => e instanceof TbError && (!re || re.test(e.message));
const readFile = () => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('constants', () => {
  test('values', () => {
    assert.equal(MIN_PASSWORD_LENGTH, 8);
    assert.equal(MAX_PASSWORD_BYTES, 1024);
  });
});

describe('normalizeUsername', () => {
  for (const [input, out] of [[' Alice ', 'alice'], ['BOB', 'bob'], ['a', 'a'], ['0', '0'], ['a.b_c-d', 'a.b_c-d'],
    ['Ａｌｉｃｅ', 'alice'], ['x'.repeat(64), 'x'.repeat(64)], ['\tcarol\n', 'carol']]) {
    test(`${JSON.stringify(input)} -> ${out}`, () => assert.equal(normalizeUsername(input), out));
  }
  for (const bad of ['', '   ', 'bad name', '.x', '_x', '-x', 'x'.repeat(65), 'a/b', '../etc', 'a@b', 'ünï', 'a\u0000b', '__proto__']) {
    test(`rejects ${JSON.stringify(bad)}`, () => assert.throws(() => normalizeUsername(bad), isTb(/username/)));
  }
  for (const bad of [undefined, null, 1, {}, ['alice']]) {
    test(`rejects non-string ${JSON.stringify(bad)}`, () => assert.throws(() => normalizeUsername(bad), isTb(/string/)));
  }
});

describe('UserStore constructor', () => {
  for (const bad of [undefined, '', null, 42]) {
    test(`rejects path ${JSON.stringify(bad)}`, () => assert.throws(() => new UserStore(bad), isTb(/path/)));
  }
});

describe('createUser + checkPassword', () => {
  test('happy path; returns normalised name; parent dir created', async () => {
    assert.equal(await store.createUser(' Alice ', PW), 'alice');
    assert.ok(fs.existsSync(file));
    assert.equal(await store.checkPassword('alice', PW), true);
    assert.equal(await store.checkPassword('ALICE', PW), true, 'login is case-insensitive on username');
  });

  test('wrong password vs unknown user both resolve false', async () => {
    await store.createUser('alice', PW);
    assert.equal(await store.checkPassword('alice', PW + 'x'), false);
    assert.equal(await store.checkPassword('mallory', PW), false);
    assert.equal(await store.checkPassword('alice', PW.toUpperCase()), false, 'password is case-sensitive');
  });

  test('a fresh store instance on the same file sees the user', async () => {
    await store.createUser('alice', PW);
    assert.equal(await new UserStore(file).checkPassword('alice', PW), true);
  });

  test('missing file means no users', async () => {
    assert.equal(Object.keys(store.load()).length, 0);
    assert.equal(await store.checkPassword('alice', PW), false);
    assert.equal(fs.existsSync(file), false, 'checkPassword must not create the file');
  });

  test('password NFKC-normalised consistently (ligature ﬁ == fi)', async () => {
    await store.createUser('alice', 'ﬁxedpassword');
    assert.equal(await store.checkPassword('alice', 'fixedpassword'), true);
  });

  test('unicode password round-trips', async () => {
    await store.createUser('alice', 'пароль🚀секрет');
    assert.equal(await store.checkPassword('alice', 'пароль🚀секрет'), true);
  });
});

describe('createUser validation', () => {
  test('duplicate user rejected, case- and width-insensitive', async () => {
    await store.createUser('Alice', PW);
    for (const dup of ['alice', 'ALICE', ' alice ', 'Ａｌｉｃｅ']) {
      await assert.rejects(store.createUser(dup, 'another password'), isTb(/already exists/), dup);
    }
    assert.equal(await store.checkPassword('alice', PW), true, 'original password unchanged');
  });

  test('concurrent creates of the same name: exactly one wins', async () => {
    const results = await Promise.allSettled([store.createUser('alice', 'password-one'), store.createUser('alice', 'password-two')]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.ok(isTb(/already exists/)(results.find((r) => r.status === 'rejected').reason));
  });

  test('concurrent creates of different names: both persisted', async () => {
    await Promise.all([store.createUser('alice', PW), store.createUser('bob', PW), store.createUser('carol', PW)]);
    assert.deepEqual(Object.keys(readFile().users).sort(), ['alice', 'bob', 'carol']);
  });

  for (const bad of ['', 'bad name', '.x', 'x'.repeat(65), null, 5]) {
    test(`invalid username ${JSON.stringify(bad)} rejects (as a promise)`, async () => {
      await assert.rejects(store.createUser(bad, PW), isTb(/username/));
    });
  }

  test(`password of ${MIN_PASSWORD_LENGTH - 1} chars rejected, ${MIN_PASSWORD_LENGTH} accepted`, async () => {
    await assert.rejects(store.createUser('alice', '1234567'), isTb(/at least 8/));
    assert.equal(await store.createUser('alice', '12345678'), 'alice');
  });

  test('password byte limit: 1024 bytes ok, 1025 rejected, multibyte counted as bytes', async () => {
    await assert.rejects(store.createUser('a1', 'x'.repeat(1025)), isTb(/at most 1024 bytes/));
    await assert.rejects(store.createUser('a2', '日'.repeat(342)), isTb(/at most 1024 bytes/)); // 1026 bytes, 342 chars
    assert.equal(await store.createUser('a3', 'x'.repeat(1024)), 'a3');
  });

  for (const bad of [undefined, null, 12345678, ['password'], { toString: () => 'password123' }]) {
    test(`non-string password ${Object.prototype.toString.call(bad)} rejected`, async () => {
      await assert.rejects(store.createUser('alice', bad), isTb(/password must be a string/));
    });
  }

  test('failed create writes nothing', async () => {
    await assert.rejects(store.createUser('alice', 'short'));
    assert.equal(fs.existsSync(file), false);
  });
});

describe('storage on disk', () => {
  test('plaintext password never on disk; record shape', async () => {
    const pw = 'S3cret-Plaintext-Marker!';
    await store.createUser('alice', pw);
    const raw = fs.readFileSync(file, 'utf8');
    assert.equal(raw.includes(pw), false);
    assert.equal(raw.includes(Buffer.from(pw).toString('base64')), false);
    assert.equal(raw.includes(Buffer.from(pw).toString('hex')), false);
    const rec = readFile().users.alice;
    assert.deepEqual(Object.keys(rec).sort(), ['createdAt', 'hash', 'params', 'salt', 'tokenVersion']);
    assert.match(rec.tokenVersion, /^[A-Za-z0-9_-]{16,}$/);
    assert.deepEqual(Object.keys(readFile()).sort(), ['throttle', 'users']);
    assert.equal(Buffer.from(rec.salt, 'base64').length, 16);
    assert.equal(Buffer.from(rec.hash, 'base64').length, 64);
    assert.deepEqual(rec.params, { N: 16384, r: 8, p: 1, keylen: 64 });
    assert.ok(!Number.isNaN(Date.parse(rec.createdAt)));
  });

  test('same password -> different salts and hashes', async () => {
    await store.createUser('alice', PW);
    await store.createUser('bob', PW);
    const { alice, bob } = readFile().users;
    assert.notEqual(alice.salt, bob.salt);
    assert.notEqual(alice.hash, bob.hash);
  });

  test('file mode is 0600', { skip: process.platform === 'win32' }, async () => {
    await store.createUser('alice', PW);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  test('no temp files left behind', async () => {
    await store.createUser('alice', PW);
    await store.createUser('bob', PW);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['users.json']);
  });

  test('load() throws TbError on invalid JSON', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    assert.throws(() => store.load(), isTb(/not valid JSON/));
  });

  test('load() returns a null-prototype map', async () => {
    await store.createUser('alice', PW);
    const users = store.load();
    assert.equal(Object.getPrototypeOf(users), null);
    assert.ok('alice' in users);
  });

  for (const content of ['null', '[]', '"str"', '42', '{"users":[]}', '{"users":"x"}', '{"users":5}']) {
    test(`wrong-shape JSON file ${content} -> TbError from load/check/create`, async () => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      assert.throws(() => store.load(), isTb(/expected \{"users"/));
      await assert.rejects(store.checkPassword('alice', PW), isTb());
      await assert.rejects(store.createUser('alice', PW), isTb());
      assert.equal(fs.readFileSync(file, 'utf8'), content, 'file not overwritten');
    });
  }

  test('corrupt JSON: checkPassword rejects with TbError (store unreadable is not "false")', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{bad');
    await assert.rejects(store.checkPassword('alice', PW), isTb(/not valid JSON/));
  });

  for (const content of ['{}', '{"users":null}', '{"users":{}}']) {
    test(`odd but valid JSON file ${content} -> no users, create works`, async () => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      assert.equal(await store.checkPassword('alice', PW), false);
      assert.equal(await store.createUser('alice', PW), 'alice');
      assert.equal(await store.checkPassword('alice', PW), true);
    });
  }
});

describe('checkPassword never throws', () => {
  test('prototype names are not inherited', async () => {
    for (const name of ['constructor', 'tostring', 'hasownproperty', 'valueof', '__proto__', 'prototype']) {
      assert.equal(await store.checkPassword(name, PW), false, name);
    }
    await store.createUser('alice', PW);
    assert.equal(await store.checkPassword('constructor', PW), false);
  });

  test('"constructor" can be created as a normal user', async () => {
    assert.equal(await store.createUser('constructor', PW), 'constructor');
    assert.equal(await store.checkPassword('constructor', PW), true);
    assert.equal(await store.checkPassword('constructor', 'wrong password'), false);
  });

  for (const [u, p] of [[undefined, PW], [null, PW], [{}, PW], ['alice', undefined], ['alice', null], ['alice', 123456789],
    ['alice', 'short'], ['alice', 'x'.repeat(5000)], ['bad name', PW], ['', '']]) {
    test(`bad shape (${JSON.stringify(u)}, ${typeof p === 'string' ? `${p.length}ch` : JSON.stringify(p)}) -> false`, async () => {
      await store.createUser('alice', PW);
      assert.equal(await store.checkPassword(u, p), false);
    });
  }

  const tamper = async (mutate) => {
    await store.createUser('alice', PW);
    const data = readFile();
    mutate(data.users);
    fs.writeFileSync(file, JSON.stringify(data));
    return store.checkPassword('alice', PW);
  };
  const cases = {
    'record is null': (u) => { u.alice = null; },
    'record is a string': (u) => { u.alice = 'x'; },
    'record is empty object': (u) => { u.alice = {}; },
    'hash missing': (u) => { delete u.alice.hash; },
    'salt missing': (u) => { delete u.alice.salt; },
    'params missing': (u) => { delete u.alice.params; },
    'hash is a number': (u) => { u.alice.hash = 5; },
    'hash replaced with zeros': (u) => { u.alice.hash = Buffer.alloc(64).toString('base64'); },
    'hash truncated': (u) => { u.alice.hash = u.alice.hash.slice(0, 20); },
    'salt changed': (u) => { u.alice.salt = Buffer.alloc(16, 1).toString('base64'); },
    'N not power of 2': (u) => { u.alice.params.N = 1000; },
    'N huge (DoS)': (u) => { u.alice.params.N = 2 ** 30; },
    'N negative': (u) => { u.alice.params.N = -16384; },
    'N as string': (u) => { u.alice.params.N = '16384'; },
    'r = 0': (u) => { u.alice.params.r = 0; },
    'r huge': (u) => { u.alice.params.r = 1000; },
    'p huge': (u) => { u.alice.params.p = 1000; },
    'p = 16 (over cap of 4)': (u) => { u.alice.params.p = 16; },
    'N=2^20 r=32 (4 GiB)': (u) => { u.alice.params.N = 2 ** 20; u.alice.params.r = 32; },
    'N=2^17 r=8 (128 MiB, just over 64 MiB cap)': (u) => { u.alice.params.N = 2 ** 17; },
    'keylen tiny': (u) => { u.alice.params.keylen = 1; },
    'keylen huge': (u) => { u.alice.params.keylen = 1e9; },
    'params is null': (u) => { u.alice.params = null; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    test(`tampered record (${name}) -> false, no throw`, async () => assert.equal(await tamper(mutate), false));
  }

  test('weaker but valid params stored by an attacker with a matching hash still verify (documents behaviour)', async () => {
    // An attacker with write access can always plant a hash; this just checks params are honoured per record.
    const crypto = await import('node:crypto');
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(PW, salt, 32, { N: 1024, r: 8, p: 1 });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ users: { alice: { salt: salt.toString('base64'), hash: hash.toString('base64'), params: { N: 1024, r: 8, p: 1, keylen: 32 } } } }));
    assert.equal(await store.checkPassword('alice', PW), true);
    assert.equal(await store.checkPassword('alice', 'wrong password'), false);
  });

});

describe('convenience functions', () => {
  test('createUser/checkPassword with { usersPath }', async () => {
    assert.equal(await createUser('Dave', PW, { usersPath: file }), 'dave');
    assert.equal(await checkPassword('dave', PW, { usersPath: file }), true);
    assert.equal(await checkPassword('dave', 'nope nope', { usersPath: file }), false);
  });

  test('missing usersPath: createUser returns a rejected promise (does not throw synchronously)', async () => {
    let p;
    assert.doesNotThrow(() => { p = createUser('dave', PW); });
    await assert.rejects(p, isTb(/path/));
  });

  test('missing usersPath: checkPassword does not throw synchronously', async () => {
    let p;
    assert.doesNotThrow(() => { p = checkPassword('dave', PW); });
    await p.catch(() => {});
  });
});

describe('password rules split between create and check', () => {
  test('minimum counts code points: 7 emoji rejected, 8 accepted', async () => {
    await assert.rejects(store.createUser('e7', '🚀'.repeat(7)), isTb(/at least 8/));
    assert.equal(await store.createUser('e8', '🚀'.repeat(8)), 'e8');
    assert.equal(await store.checkPassword('e8', '🚀'.repeat(8)), true);
  });

  test('legacy user with a short stored password can still log in (min not applied at check)', async () => {
    const crypto = await import('node:crypto');
    const salt = crypto.randomBytes(16);
    const params = { N: 16384, r: 8, p: 1, keylen: 64 };
    const hash = crypto.scryptSync('abc', salt, 64, { N: 16384, r: 8, p: 1 });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ users: { old: { salt: salt.toString('base64'), hash: hash.toString('base64'), params } } }));
    assert.equal(await store.checkPassword('old', 'abc'), true);
    assert.equal(await store.checkPassword('old', 'abd'), false);
  });

  test('check still caps password at 1024 bytes and requires a string', async () => {
    await store.createUser('alice', PW);
    assert.equal(await store.checkPassword('alice', 'x'.repeat(1025)), false);
    assert.equal(await store.checkPassword('alice', Buffer.from(PW)), false);
  });
});

describe('filesystem permissions', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  test('created parent dir is mode 0700', async () => {
    await store.createUser('alice', PW);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  });

  test('unreadable users file -> TbError (not raw EACCES, not "no users")', async () => {
    await store.createUser('alice', PW);
    fs.chmodSync(file, 0o000);
    try {
      assert.throws(() => store.load(), (e) => e instanceof TbError);
      await assert.rejects(store.checkPassword('alice', PW), (e) => e instanceof TbError);
    } finally {
      fs.chmodSync(file, 0o600);
    }
  });

  test('users path that is a directory -> TbError', () => {
    fs.mkdirSync(file, { recursive: true });
    assert.throws(() => store.load(), (e) => e instanceof TbError);
  });
});
