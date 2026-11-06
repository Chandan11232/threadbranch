import { TbError } from '../git.js';
import { sign, verify, secretBytes, MIN_SECRET_BYTES } from './jwt.js';
import { UserStore, normalizeUsername } from './users.js';

export const DEFAULT_EXPIRES_IN = '1h';
// One message for every failed login (unknown user, wrong password, locked out), so a caller
// cannot tell the cases apart.
export const LOGIN_FAILED = 'invalid username or password';
// One message for every rejected token (bad, expired, revoked, user deleted). The detail is on
// error.cause for debugging, never in the message.
export const AUTH_FAILED = 'not authenticated: invalid, expired or revoked token';
// Tokens are tagged so one minted by another tool sharing TB_JWT_SECRET is not accepted here.
export const ISSUER = 'threadbranch';

/**
 * The signing secret from opts.secret (when given at all, even null), else env TB_JWT_SECRET.
 * Fully validated here (type and length) so config errors never depend on credentials.
 * There is deliberately no default.
 */
export function resolveSecret({ secret, env = process.env } = {}) {
  const s = secret !== undefined ? secret : (env ?? {}).TB_JWT_SECRET;
  if (s === undefined || s === '') throw new TbError(`no JWT secret: pass opts.secret or set TB_JWT_SECRET (at least ${MIN_SECRET_BYTES} bytes)`);
  secretBytes(s);
  return s;
}

function storeFrom({ store, usersPath }) {
  return store ?? new UserStore(usersPath);
}

/**
 * Check credentials (throttled: see UserStore.attemptLogin) and return a signed token with
 * sub = normalised username and tv = the user's token version.
 * opts: { secret? | env?, usersPath? | store?, expiresIn? = "1h", throttle? (THROTTLE_DEFAULTS overrides) }
 */
export async function login(username, password, opts = {}) {
  // Configuration errors surface before any credential check, and never depend on the user.
  const secret = resolveSecret(opts);
  const store = storeFrom(opts);
  const r = await store.attemptLogin(username, password, opts.throttle);
  if (!r.ok) throw new TbError(LOGIN_FAILED);
  return sign({ sub: r.username, iss: ISSUER, tv: r.tokenVersion }, secret, { expiresIn: opts.expiresIn ?? DEFAULT_EXPIRES_IN });
}

/**
 * Verify a token from login() against the secret and the user store; returns its claims.
 * Every rejection is TbError(AUTH_FAILED) with the reason on .cause. A missing or bad secret,
 * or an unreadable store, is a configuration error and is reported as itself.
 * opts: { secret? | env?, usersPath? | store? }
 */
export function authenticate(token, opts = {}) {
  const secret = resolveSecret(opts);
  const store = storeFrom(opts);
  const fail = (cause) => new TbError(AUTH_FAILED, { cause });
  let claims;
  try {
    claims = verify(token, secret);
  } catch (e) {
    throw fail(e);
  }
  if (typeof claims.sub !== 'string' || !claims.sub) throw fail(new TbError('missing subject'));
  if (claims.iss !== ISSUER) throw fail(new TbError('wrong issuer'));
  let canonical;
  try {
    canonical = normalizeUsername(claims.sub);
  } catch {
    canonical = null;
  }
  if (canonical !== claims.sub) throw fail(new TbError('subject is not a valid username'));
  const current = store.tokenVersion(claims.sub);
  if (current === null) throw fail(new TbError('user no longer exists'));
  if (claims.tv !== current) throw fail(new TbError('token revoked'));
  return claims;
}
