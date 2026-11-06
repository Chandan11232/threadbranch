import crypto from 'node:crypto';
import { TbError } from '../git.js';

export const MIN_SECRET_BYTES = 32;
// Seconds of clock drift tolerated on exp/nbf/iat between issuer and verifier.
export const CLOCK_SKEW_SECONDS = 30;

// Bounds unauthenticated work: the header is decoded before the signature is checked.
export const MAX_TOKEN_LENGTH = 8192;
// Longest lifetime sign() will mint.
export const MAX_EXPIRES_IN_SECONDS = 365 * 86400;

const HEADER = { alg: 'HS256', typ: 'JWT' };
const B64URL = /^[A-Za-z0-9_-]*$/;

/** Validate a signing secret and return it as bytes; throws TbError if unusable. */
export function secretBytes(secret) {
  const buf = Buffer.isBuffer(secret) ? secret : typeof secret === 'string' ? Buffer.from(secret, 'utf8') : null;
  if (!buf) throw new TbError('JWT secret must be a string or Buffer');
  if (buf.length < MIN_SECRET_BYTES) throw new TbError(`JWT secret must be at least ${MIN_SECRET_BYTES} bytes`);
  return buf;
}

function encode(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

function decodeSegment(seg, what) {
  // Buffer.from(..., 'base64url') silently skips invalid characters, so validate first.
  if (!seg || !B64URL.test(seg) || seg.length % 4 === 1) throw new TbError(`malformed token: bad base64url in ${what}`);
  let value;
  try {
    value = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
  } catch {
    throw new TbError(`malformed token: bad JSON in ${what}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TbError(`malformed token: ${what} must be a JSON object`);
  }
  return value;
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

/** Parse "60", 60, "15m", "2h", "7d" into seconds. */
function parseDuration(v) {
  let secs;
  if (typeof v === 'number') secs = v;
  else {
    const m = typeof v === 'string' && /^(\d{1,10})\s*([smhd]?)$/.exec(v.trim());
    secs = m ? Number(m[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]] : NaN;
  }
  if (!Number.isSafeInteger(secs) || secs <= 0) {
    throw new TbError(`expiresIn must be a positive number of seconds or like "15m", "2h", "7d"`);
  }
  if (secs > MAX_EXPIRES_IN_SECONDS) throw new TbError(`expiresIn must be at most ${MAX_EXPIRES_IN_SECONDS} seconds (1 year)`);
  return secs;
}

const TIME_CLAIMS = ['exp', 'nbf', 'iat'];
const badTime = (claims, c) => Object.hasOwn(claims, c) && (typeof claims[c] !== 'number' || !Number.isFinite(claims[c]));

const now = () => Math.floor(Date.now() / 1000);

/**
 * Sign payload as an HS256 JWT. Sets iat; expiresIn sets exp (replacing any payload exp).
 * verify() requires exp by default, so pass expiresIn or an explicit numeric exp.
 */
export function sign(payload, secret, { expiresIn } = {}) {
  const key = secretBytes(secret);
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new TbError('JWT payload must be an object');
  for (const c of ['exp', 'nbf']) if (badTime(payload, c)) throw new TbError(`JWT ${c} must be a number of seconds`);
  const iat = now();
  const claims = { ...payload, iat };
  if (expiresIn !== undefined) claims.exp = iat + parseDuration(expiresIn);
  const input = `${encode(HEADER)}.${encode(claims)}`;
  return `${input}.${hmac(key, input).toString('base64url')}`;
}

/**
 * Verify an HS256 JWT and return its claims; throws TbError on any problem.
 * A token without exp is rejected unless requireExp is false.
 */
export function verify(token, secret, { requireExp = true } = {}) {
  const key = secretBytes(secret);
  if (typeof token !== 'string') throw new TbError('malformed token: not a string');
  if (token.length > MAX_TOKEN_LENGTH) throw new TbError('malformed token: too long');
  const parts = token.split('.');
  if (parts.length !== 3) throw new TbError('malformed token: expected 3 segments');
  const [h, p, s] = parts;

  const header = decodeSegment(h, 'header');
  // Pin the algorithm: never let the token choose (blocks "none" and alg-confusion).
  if (header.alg !== 'HS256') throw new TbError('unsupported token algorithm');
  if (header.typ !== undefined && header.typ !== 'JWT') throw new TbError('unsupported token type');
  if (header.crit !== undefined) throw new TbError('unsupported critical header');

  if (!s || !B64URL.test(s)) throw new TbError('malformed token: bad base64url in signature');
  const given = Buffer.from(s, 'base64url');
  const expected = hmac(key, `${h}.${p}`);
  // timingSafeEqual throws on length mismatch; check first (length is not secret).
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw new TbError('invalid token signature');
  }
  // Reject non-canonical signature encodings so each token has exactly one valid form.
  if (given.toString('base64url') !== s) throw new TbError('invalid token signature');

  const claims = decodeSegment(p, 'payload');
  const t = now();
  for (const c of TIME_CLAIMS) if (badTime(claims, c)) throw new TbError(`invalid token: ${c} must be a number`);
  const has = (c) => Object.hasOwn(claims, c);
  if (!has('exp') && requireExp) throw new TbError('invalid token: missing exp');
  if (has('exp') && t > claims.exp + CLOCK_SKEW_SECONDS) throw new TbError('token expired');
  if (has('nbf') && t + CLOCK_SKEW_SECONDS < claims.nbf) throw new TbError('token not yet valid');
  if (has('iat') && t + CLOCK_SKEW_SECONDS < claims.iat) throw new TbError('token issued in the future');
  return claims;
}
