import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sign, verify, MIN_SECRET_BYTES, CLOCK_SKEW_SECONDS } from '../../src/auth/jwt.js';
import { TbError } from '../../src/git.js';

const SECRET = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const NOW = 1_800_000_000; // fixed clock, seconds

const b64 = (obj) => Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)).toString('base64url');
const mac = (input, secret = SECRET) => crypto.createHmac('sha256', secret).update(input).digest('base64url');
// Hand-sign arbitrary raw header/payload segments with a valid HS256 signature.
const handSign = (h, p, secret = SECRET) => `${h}.${p}.${mac(`${h}.${p}`, secret)}`;
const craft = (header, payload, secret) => handSign(b64(header), b64(payload), secret);
const HDR = { alg: 'HS256', typ: 'JWT' };
const LOOSE = { requireExp: false };
const EXP = NOW + 600;

const rejects = (fn, re) => assert.throws(fn, (e) => e instanceof TbError && re.test(e.message), `expected TbError matching ${re}`);

beforeEach((t) => t.mock.method(Date, 'now', () => NOW * 1000));

describe('constants', () => {
  test('exported values', () => {
    assert.equal(MIN_SECRET_BYTES, 32);
    assert.equal(CLOCK_SKEW_SECONDS, 30);
  });
});

describe('sign/verify round trip', () => {
  test('returns claims with iat', () => {
    const tok = sign({ sub: 'alice', role: 'admin' }, SECRET);
    assert.equal(tok.split('.').length, 3);
    assert.deepEqual(verify(tok, SECRET, LOOSE), { sub: 'alice', role: 'admin', iat: NOW });
  });

  test('header is HS256/JWT', () => {
    const tok = sign({}, SECRET);
    assert.deepEqual(JSON.parse(Buffer.from(tok.split('.')[0], 'base64url')), HDR);
  });

  test('Buffer secret works and matches equal string secret', () => {
    const tok = sign({ a: 1 }, Buffer.from(SECRET));
    assert.equal(verify(tok, SECRET, LOOSE).a, 1);
  });

  test('unicode payload round-trips', () => {
    const tok = sign({ name: 'Zoë 🚀 日本' }, SECRET);
    assert.equal(verify(tok, SECRET, LOOSE).name, 'Zoë 🚀 日本');
  });

  test('payload iat is overwritten by sign', () => {
    const tok = sign({ iat: 5 }, SECRET);
    assert.equal(verify(tok, SECRET, LOOSE).iat, NOW);
  });

  test('does not mutate input payload', () => {
    const p = { sub: 'x' };
    sign(p, SECRET, { expiresIn: 60 });
    assert.deepEqual(p, { sub: 'x' });
  });
});

describe('expiresIn', () => {
  for (const [v, secs] of [[90, 90], ['90', 90], ['30s', 30], ['15m', 900], ['2h', 7200], ['7d', 604800]]) {
    test(`${JSON.stringify(v)} -> exp = iat + ${secs}`, () => {
      const c = verify(sign({}, SECRET, { expiresIn: v }), SECRET);
      assert.equal(c.exp, NOW + secs);
    });
  }
  test('no expiresIn -> no exp', () => {
    assert.equal('exp' in verify(sign({}, SECRET), SECRET, LOOSE), false);
  });
  for (const bad of [0, -5, '0', 'abc', '-1', '1.5', 1.5, '15x', '', null, NaN, Infinity]) {
    test(`rejects expiresIn ${String(bad)}`, () => rejects(() => sign({}, SECRET, { expiresIn: bad }), /expiresIn/));
  }
});

describe('secret validation', () => {
  test('31-byte secret rejected by sign and verify', () => {
    const short = 'a'.repeat(31);
    rejects(() => sign({}, short), /at least 32 bytes/);
    const tok = sign({}, SECRET);
    rejects(() => verify(tok, short), /at least 32 bytes/);
  });
  test('exactly 32 bytes accepted', () => assert.ok(verify(sign({}, 'x'.repeat(32), { expiresIn: 60 }), 'x'.repeat(32))));
  test('length is measured in bytes, not chars (11 x 3-byte chars = 33 bytes ok)', () => {
    const s = '日'.repeat(11);
    assert.ok(verify(sign({}, s, { expiresIn: 60 }), s));
  });
  test('10 x 3-byte chars = 30 bytes rejected', () => rejects(() => sign({}, '日'.repeat(10)), /at least 32/));
  for (const bad of [undefined, null, 12345, {}, []]) {
    test(`non-string/Buffer secret ${JSON.stringify(bad)} rejected`, () => {
      rejects(() => sign({}, bad), /secret/);
      rejects(() => verify(sign({}, SECRET), bad), /secret/);
    });
  }
  test('empty string secret rejected', () => rejects(() => sign({}, ''), /at least 32/));
});

describe('payload validation in sign', () => {
  for (const bad of [null, [], 'str', 42, true, undefined]) {
    test(`rejects payload ${JSON.stringify(bad)}`, () => rejects(() => sign(bad, SECRET), /payload/));
  }
});

describe('signature checks', () => {
  test('wrong secret', () => rejects(() => verify(sign({ a: 1 }, SECRET), OTHER), /invalid token signature/));

  test('tampered payload (privilege escalation)', () => {
    const [h, , s] = sign({ sub: 'bob', role: 'user' }, SECRET).split('.');
    const forged = `${h}.${b64({ sub: 'bob', role: 'admin', iat: NOW })}.${s}`;
    rejects(() => verify(forged, SECRET), /invalid token signature/);
  });

  test('tampered header (same alg, extra field) breaks signature', () => {
    const [, p, s] = sign({}, SECRET).split('.');
    rejects(() => verify(`${b64({ ...HDR, kid: 'x' })}.${p}.${s}`, SECRET), /invalid token signature/);
  });

  test('flipped signature bit', () => {
    const [h, p, s] = sign({}, SECRET).split('.');
    const bytes = Buffer.from(s, 'base64url');
    bytes[0] ^= 1;
    rejects(() => verify(`${h}.${p}.${bytes.toString('base64url')}`, SECRET), /invalid token signature/);
  });

  test('empty signature', () => {
    const [h, p] = sign({}, SECRET).split('.');
    rejects(() => verify(`${h}.${p}.`, SECRET), /signature/);
  });

  test('truncated signature', () => {
    const tok = sign({}, SECRET);
    rejects(() => verify(tok.slice(0, -4), SECRET), /invalid token signature/);
  });

  test('extended signature (extra bytes)', () => {
    const [h, p, s] = sign({}, SECRET).split('.');
    const longer = Buffer.concat([Buffer.from(s, 'base64url'), Buffer.from([0])]).toString('base64url');
    rejects(() => verify(`${h}.${p}.${longer}`, SECRET), /invalid token signature/);
  });

  test('signature with invalid base64url chars', () => {
    const [h, p, s] = sign({}, SECRET).split('.');
    rejects(() => verify(`${h}.${p}.${s.slice(0, -1)}+`, SECRET), /signature/);
    rejects(() => verify(`${h}.${p}.${s}=`, SECRET), /signature/);
  });

  test('non-canonical signature encoding (same bytes, different trailing bits) rejected', () => {
    const [h, p, s] = sign({}, SECRET).split('.');
    // 32 bytes -> 43 chars; last char carries 2 unused low bits.
    const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const i = alpha.indexOf(s.at(-1));
    const alt = s.slice(0, -1) + alpha[i ^ 1];
    assert.deepEqual(Buffer.from(alt, 'base64url'), Buffer.from(s, 'base64url'), 'sanity: decodes to same bytes');
    rejects(() => verify(`${h}.${p}.${alt}`, SECRET), /invalid token signature/);
  });

  test('signature computed with the other secret on attacker-chosen claims', () => {
    rejects(() => verify(craft(HDR, { sub: 'admin' }, OTHER), SECRET), /invalid token signature/);
  });
});

describe('algorithm pinning', () => {
  test('alg "none" with empty signature rejected', () => {
    const tok = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'admin' })}.`;
    rejects(() => verify(tok, SECRET), /unsupported token algorithm/);
  });
  for (const alg of ['none', 'None', 'NONE', 'HS512', 'HS384', 'RS256', 'ES256', 'hs256', '', null, 256]) {
    test(`alg ${JSON.stringify(alg)} rejected even with valid HMAC`, () => {
      rejects(() => verify(craft({ alg, typ: 'JWT' }, { sub: 'x' }), SECRET), /unsupported token algorithm/);
    });
  }
  test('missing alg rejected', () => rejects(() => verify(craft({ typ: 'JWT' }, {}), SECRET), /unsupported token algorithm/));
  test('alg as array rejected', () => rejects(() => verify(craft({ alg: ['HS256'] }, {}), SECRET), /unsupported token algorithm/));
  test('typ omitted is accepted', () => assert.deepEqual(verify(craft({ alg: 'HS256' }, { a: 1, exp: EXP }), SECRET), { a: 1, exp: EXP }));
  test('typ other than JWT rejected', () => rejects(() => verify(craft({ alg: 'HS256', typ: 'at+jwt' }, {}), SECRET), /type/));
  test('crit header rejected', () => rejects(() => verify(craft({ ...HDR, crit: ['exp'] }, {}), SECRET), /critical/));
  test('crit: [] also rejected', () => rejects(() => verify(craft({ ...HDR, crit: [] }, {}), SECRET), /critical/));
});

describe('malformed tokens', () => {
  for (const bad of [undefined, null, 123, {}, ['a', 'b', 'c'], Buffer.from('a.b.c')]) {
    test(`non-string token ${Object.prototype.toString.call(bad)} rejected`, () => rejects(() => verify(bad, SECRET), /not a string/));
  }
  for (const tok of ['', 'abc', 'a.b', 'a.b.c.d', '....', 'a..b.c']) {
    test(`segment count: ${JSON.stringify(tok)}`, () => rejects(() => verify(tok, SECRET), /expected 3 segments/));
  }
  test('four segments from a valid token + extra', () => rejects(() => verify(`${sign({}, SECRET)}.x`, SECRET), /expected 3 segments/));
  test('empty header', () => rejects(() => verify(`.${b64({})}.sig`, SECRET), /bad base64url in header/));
  test('header with invalid base64url chars', () => rejects(() => verify(`${b64(HDR)}+.${b64({})}.x`, SECRET), /bad base64url in header/));
  test('header with padding', () => rejects(() => verify(`${b64(HDR)}=.${b64({})}.x`, SECRET), /bad base64url in header/));
  test('header with impossible length (len % 4 == 1)', () => rejects(() => verify(`AAAAA.${b64({})}.x`, SECRET), /bad base64url in header/));
  test('header not JSON', () => rejects(() => verify(`${b64('not json')}.${b64({})}.x`, SECRET), /bad JSON in header/));
  for (const v of ['null', '[]', '"HS256"', '42', 'true']) {
    test(`header JSON ${v} is not an object`, () => rejects(() => verify(`${b64(v)}.${b64({})}.x`, SECRET), /header must be a JSON object/));
  }
  // Payload problems must be detected even with a valid signature (hand-signed).
  test('payload bad base64url (validly signed)', () => rejects(() => verify(handSign(b64(HDR), 'ab*c'), SECRET), /bad base64url in payload/));
  test('payload impossible length (validly signed)', () => rejects(() => verify(handSign(b64(HDR), 'AAAAA'), SECRET), /bad base64url in payload/));
  test('empty payload (validly signed)', () => rejects(() => verify(handSign(b64(HDR), ''), SECRET), /bad base64url in payload/));
  test('payload not JSON (validly signed)', () => rejects(() => verify(handSign(b64(HDR), b64('{oops')), SECRET), /bad JSON in payload/));
  for (const v of ['null', '[1]', '"s"', '7']) {
    test(`payload JSON ${v} not an object (validly signed)`, () => rejects(() => verify(handSign(b64(HDR), b64(v)), SECRET), /payload must be a JSON object/));
  }
  test('whitespace around token rejected', () => {
    const tok = sign({}, SECRET);
    assert.throws(() => verify(` ${tok}`, SECRET), TbError);
    assert.throws(() => verify(`${tok}\n`, SECRET), TbError);
  });
  test('only throws TbError, never a raw TypeError/SyntaxError, on garbage', () => {
    for (const g of ['\u0000.\u0000.\u0000', '🚀.🚀.🚀', 'eyJ.eyJ.eyJ', '%%.%%.%%']) {
      assert.throws(() => verify(g, SECRET), TbError, g);
    }
  });
});

describe('time claims', () => {
  test(`exp exactly ${CLOCK_SKEW_SECONDS}s in the past passes (skew)`, () => {
    assert.ok(verify(craft(HDR, { exp: NOW - 30 }), SECRET));
  });
  test('exp 31s in the past fails', () => rejects(() => verify(craft(HDR, { exp: NOW - 31 }), SECRET), /token expired/));
  test('exp far in the past fails', () => rejects(() => verify(craft(HDR, { exp: 0 }), SECRET), /token expired/));
  test('exp equal to now passes', () => assert.ok(verify(craft(HDR, { exp: NOW }), SECRET)));

  test('sign with expiresIn then clock advances past exp+skew -> expired', (t) => {
    const tok = sign({}, SECRET, { expiresIn: '1m' });
    Date.now.mock.mockImplementation(() => (NOW + 60 + 30) * 1000);
    assert.ok(verify(tok, SECRET));
    Date.now.mock.mockImplementation(() => (NOW + 60 + 31) * 1000);
    rejects(() => verify(tok, SECRET), /token expired/);
  });

  test('fractional ms: exp+30 boundary uses floor of Date.now', () => {
    const tok = craft(HDR, { exp: NOW - 30 });
    Date.now.mock.mockImplementation(() => NOW * 1000 + 999);
    assert.ok(verify(tok, SECRET));
  });

  test('nbf 30s in the future passes', () => assert.ok(verify(craft(HDR, { nbf: NOW + 30, exp: EXP }), SECRET)));
  test('nbf 31s in the future fails', () => rejects(() => verify(craft(HDR, { nbf: NOW + 31, exp: EXP }), SECRET), /token not yet valid/));
  test('nbf in the past passes', () => assert.ok(verify(craft(HDR, { nbf: NOW - 1000, exp: EXP }), SECRET)));

  test('iat 30s in the future passes', () => assert.ok(verify(craft(HDR, { iat: NOW + 30, exp: EXP }), SECRET)));
  test('iat 31s in the future fails', () => rejects(() => verify(craft(HDR, { iat: NOW + 31, exp: EXP }), SECRET), /issued in the future/));

  for (const c of ['exp', 'nbf', 'iat']) {
    for (const v of ['1800000000', null, true, {}, [NOW]]) {
      test(`${c} = ${JSON.stringify(v)} rejected as non-number`, () => {
        rejects(() => verify(craft(HDR, { [c]: v }), SECRET), new RegExp(`${c} must be a number`));
      });
    }
    // JSON can encode 1e999 which parses to Infinity.
    test(`${c} = 1e999 (Infinity) rejected`, () => {
      rejects(() => verify(handSign(b64(HDR), b64(`{"${c}":1e999}`)), SECRET), new RegExp(`${c} must be a number`));
    });
  }

  test('expired check happens only after signature check (forged expired token reports signature error)', () => {
    rejects(() => verify(craft(HDR, { exp: 0 }, OTHER), SECRET), /invalid token signature/);
  });
});

describe('requireExp (default on)', () => {
  test('token without exp rejected by default', () => {
    assert.throws(() => verify(sign({ sub: 'x' }, SECRET), SECRET), (e) => e instanceof TbError && /missing exp/.test(e.message));
  });
  test('{ requireExp: false } accepts it', () => assert.equal(verify(sign({ sub: 'x' }, SECRET), SECRET, LOOSE).sub, 'x'));
  test('{ requireExp: false } still enforces exp when present', () => {
    assert.throws(() => verify(craft(HDR, { exp: NOW - 31 }), SECRET, LOOSE), /token expired/);
  });
  test('exp inherited via __proto__ in JSON does not count as present', () => {
    const tok = `${b64(HDR)}.${b64('{"__proto__":{"exp":9999999999}}')}`;
    assert.throws(() => verify(`${tok}.${mac(tok)}`, SECRET), /missing exp/);
  });
  test('explicit numeric exp in payload (no expiresIn) is honoured', () => {
    assert.equal(verify(sign({ exp: EXP }, SECRET), SECRET).exp, EXP);
  });
  test('expiresIn replaces a payload exp', () => {
    assert.equal(verify(sign({ exp: 1 }, SECRET, { expiresIn: 60 }), SECRET).exp, NOW + 60);
  });
  for (const c of ['exp', 'nbf']) {
    for (const v of ['123', null, NaN, Infinity, {}]) {
      test(`sign rejects payload ${c}=${String(v)}`, () => assert.throws(() => sign({ [c]: v }, SECRET), /must be a number/));
    }
  }
});

describe('MAX_TOKEN_LENGTH', () => {
  test('oversized token rejected before parsing', async () => {
    const { MAX_TOKEN_LENGTH } = await import('../../src/auth/jwt.js');
    assert.equal(typeof MAX_TOKEN_LENGTH, 'number');
    const big = sign({ pad: 'x'.repeat(MAX_TOKEN_LENGTH) }, SECRET, { expiresIn: 60 });
    assert.throws(() => verify(big, SECRET), /too long/);
    assert.throws(() => verify('a'.repeat(MAX_TOKEN_LENGTH + 1), SECRET), /too long/);
  });
  test('token just under the limit still verifies', async () => {
    const { MAX_TOKEN_LENGTH } = await import('../../src/auth/jwt.js');
    let pad = 'x'.repeat(Math.floor(MAX_TOKEN_LENGTH * 0.7));
    const tok = sign({ pad }, SECRET, { expiresIn: 60 });
    assert.ok(tok.length <= MAX_TOKEN_LENGTH);
    assert.equal(verify(tok, SECRET).pad, pad);
  });
});

describe('expiresIn caps', () => {
  test('MAX_EXPIRES_IN_SECONDS is 1 year; boundary accepted, +1 rejected', async () => {
    const { MAX_EXPIRES_IN_SECONDS } = await import('../../src/auth/jwt.js');
    assert.equal(MAX_EXPIRES_IN_SECONDS, 31536000);
    assert.equal(verify(sign({}, SECRET, { expiresIn: 31536000 }), SECRET).exp, NOW + 31536000);
    assert.equal(verify(sign({}, SECRET, { expiresIn: '365d' }), SECRET).exp, NOW + 31536000);
    assert.throws(() => sign({}, SECRET, { expiresIn: 31536001 }), (e) => e instanceof TbError && /expiresIn/.test(e.message));
  });
  for (const bad of [1e300, 2 ** 53, '366d', '99999999999', '8761h', '525601m']) {
    test(`rejects expiresIn ${String(bad)}`, () => assert.throws(() => sign({}, SECRET, { expiresIn: bad }), TbError));
  }
  test('alg error message does not echo the attacker-supplied value', () => {
    assert.throws(() => verify(craft({ alg: '<script>evil</script>' }, { exp: EXP }), SECRET),
      (e) => e instanceof TbError && e.message === 'unsupported token algorithm');
  });
});
