import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TB = path.join(HERE, '..', '..', 'bin', 'tb.js');
const SECRET = 'cli-test-secret-'.padEnd(40, 'x');
const PW = 'correct horse battery';
const AUTH_FAILED = 'tb: not authenticated: invalid, expired or revoked token';
const NO_PW_ARGS = 'tb: passwords are never taken as arguments; type it at the prompt or pipe it on stdin';
let root, repo, authDir, usersPath, tokenPath;

const g = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

/** Run tb; input is written to stdin then closed (null => /dev/null-like empty stdin). */
function tb(cwd, args, { input = null, env = {}, keepOpenMs = 0 } = {}) {
  return new Promise((resolve) => {
    const e = { ...process.env, TB_JWT_SECRET: SECRET, ...env };
    delete e.TB_DEBUG;
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete e[k];
    if (env.TB_DEBUG) e.TB_DEBUG = env.TB_DEBUG;
    const p = spawn(process.execPath, [TB, ...args], { cwd, env: e, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => p.kill('SIGKILL'), 20_000);
    p.on('close', (code, sig) => { clearTimeout(timer); resolve({ code, sig, out: out.trim(), err: err.trim() }); });
    p.stdin.on('error', () => {});
    if (input !== null) p.stdin.write(input);
    if (keepOpenMs) setTimeout(() => p.stdin.end(), keepOpenMs);
    else p.stdin.end();
  });
}
const ok = async (cwd, args, o) => {
  const r = await tb(cwd, args, o);
  assert.equal(r.code, 0, `tb ${args.join(' ')} -> ${r.code}\n${r.out}\n${r.err}`);
  return r.out;
};
const fails = async (cwd, args, o) => {
  const r = await tb(cwd, args, o);
  assert.equal(r.code, 2, `expected exit 2 for tb ${args.join(' ')}, got ${r.code}\n${r.out}\n${r.err}`);
  return r.err;
};
const mode = (p) => fs.statSync(p).mode & 0o777;
const readToken = () => fs.readFileSync(tokenPath, 'utf8').trim();
const isoRe = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cli-'));
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'T'], ['config', 'user.email', 't@t']]) g(repo, ...a);
  fs.writeFileSync(path.join(repo, 'README'), 'x\n');
  g(repo, 'add', '-A');
  g(repo, 'commit', '-q', '-m', 'init');
  authDir = path.join(repo, '.git', 'tb-auth');
  usersPath = path.join(authDir, 'users.json');
  tokenPath = path.join(authDir, 'token');
  await ok(repo, ['user', 'add', 'Alice'], { input: `${PW}\n` });
});
after(() => fs.rmSync(root, { recursive: true, force: true }));
beforeEach(() => fs.rmSync(tokenPath, { force: true }));

describe('tb user add', () => {
  test('created via stdin; normalised name; files 0600 in .git/tb-auth (0700); working tree clean', async () => {
    assert.deepEqual(JSON.parse(fs.readFileSync(usersPath, 'utf8')).users.alice !== undefined, true);
    if (process.platform !== 'win32') {
      assert.equal(mode(authDir), 0o700);
      assert.equal(mode(usersPath), 0o600);
    }
    assert.equal(g(repo, 'status', '--porcelain'), '');
    assert.equal(fs.readFileSync(usersPath, 'utf8').includes(PW), false);
  });

  test('stdout message', async () => {
    assert.equal(await ok(repo, ['user', 'add', ' BOB '], { input: `${PW}\n` }), 'created user "bob"');
  });

  test('only the first line of stdin is the password; CRLF stripped; spaces kept', async () => {
    await ok(repo, ['user', 'add', 'crlf'], { input: '  spaced pw  \r\nsecond line\n' });
    await ok(repo, ['login', 'crlf'], { input: '  spaced pw  \n' });
    await fails(repo, ['login', 'crlf'], { input: 'spaced pw\n' });
  });

  test('password without trailing newline works', async () => {
    await ok(repo, ['user', 'add', 'nonl'], { input: PW });
    await ok(repo, ['login', 'nonl'], { input: PW });
  });

  test('duplicate -> exit 2 "already exists"', async () => {
    assert.equal(await fails(repo, ['user', 'add', 'ALICE'], { input: `${PW}\n` }), 'tb: user "alice" already exists');
  });

  test('policy violations -> exit 2 with users.js message', async () => {
    assert.match(await fails(repo, ['user', 'add', 'shorty'], { input: 'short\n' }), /^tb: password must be at least 8 characters$/);
    assert.match(await fails(repo, ['user', 'add', 'bad name'], { input: `${PW}\n` }), /^tb: username must be/);
    assert.match(await fails(repo, ['user', 'add', 'big'], { input: `${'x'.repeat(1025)}\n` }), /at most 1024 bytes/);
  });

  test('empty stdin / empty line -> exit 2 "no password given"', async () => {
    const msg = 'tb: no password given (type it at the prompt or pipe it on stdin)';
    assert.equal(await fails(repo, ['user', 'add', 'empty1']), msg);
    assert.equal(await fails(repo, ['user', 'add', 'empty2'], { input: '\n' }), msg);
    assert.equal(JSON.parse(fs.readFileSync(usersPath, 'utf8')).users.empty1, undefined);
  });

  test('huge stdin stream is not buffered without bound', async () => {
    const r = await tb(repo, ['user', 'add', 'huge'], { input: 'y'.repeat(2 * 1024 * 1024) });
    assert.equal(r.code, 2);
    assert.match(r.err, /at most 1024 bytes/);
  });
});

describe('passwords never accepted as arguments', () => {
  for (const args of [['login', 'alice', PW], ['user', 'add', 'eve', PW], ['login', 'alice', '--password', PW],
    ['login', 'alice', '-p', PW], ['user', 'add', 'eve', '--password', PW], ['user', 'add', 'eve', '-p', PW],
    ['login', 'alice', `--password=${PW}`], ['login', 'alice', '--pass', PW], ['login', 'alice', '--pw', PW],
    ['login', 'alice', '--PASSWORD', PW]]) {
    test(`tb ${args.join(' ').replace(PW, '<pw>')} refused, nothing written`, async () => {
      const before = fs.readFileSync(usersPath, 'utf8');
      const err = await fails(repo, args, { input: `${PW}\n` });
      assert.equal(err, NO_PW_ARGS);
      assert.equal(err.includes(PW), false, 'password not echoed');
      assert.equal(fs.readFileSync(usersPath, 'utf8'), before);
      assert.equal(fs.existsSync(tokenPath), false);
    });
  }
  test('other unknown flags refused too', async () => {
    assert.match(await fails(repo, ['login', 'alice', '--verbose'], { input: `${PW}\n` }), /unknown flag --verbose/);
  });
});

describe('tb login / whoami', () => {
  test('login writes 0600 token in .git; whoami reports user and expiry ~1h', async () => {
    const out = await ok(repo, ['login', 'ALICE'], { input: `${PW}\n` });
    assert.match(out, new RegExp(`^logged in as alice until ${isoRe.source}$`));
    if (process.platform !== 'win32') assert.equal(mode(tokenPath), 0o600);
    assert.equal(g(repo, 'status', '--porcelain'), '');
    const who = await ok(repo, ['whoami']);
    assert.match(who, new RegExp(`^alice \\(token valid until ${isoRe.source}\\)$`));
    const exp = Date.parse(who.match(isoRe)[0]);
    assert.ok(Math.abs(exp - (Date.now() + 3600_000)) < 60_000);
    assert.equal(fs.readdirSync(authDir).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock')).length, 0);
  });

  test('wrong password and unknown user: identical error, no token', async () => {
    const a = await fails(repo, ['login', 'alice'], { input: 'wrong password\n' });
    const b = await fails(repo, ['login', 'nobody'], { input: `${PW}\n` });
    assert.equal(a, 'tb: invalid username or password');
    assert.equal(b, a);
    assert.equal(fs.existsSync(tokenPath), false);
    await ok(repo, ['user', 'unlock', 'alice']);
  });

  test('failed login does not clobber an existing session', async () => {
    await ok(repo, ['login', 'alice'], { input: `${PW}\n` });
    const tok = readToken();
    await fails(repo, ['login', 'alice'], { input: 'wrong password\n' });
    assert.equal(readToken(), tok);
    await ok(repo, ['user', 'unlock', 'alice']);
  });

  test('whoami without token -> exit 2 not logged in', async () => {
    assert.equal(await fails(repo, ['whoami']), 'tb: not logged in. Run: tb login <name>');
  });

  test('whoami with garbage / tampered token -> AUTH_FAILED; TB_DEBUG shows reason', async () => {
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(tokenPath, 'garbage\n');
    assert.equal(await fails(repo, ['whoami']), AUTH_FAILED);
    const dbg = await fails(repo, ['whoami'], { env: { TB_DEBUG: '1' } });
    assert.match(dbg, /tb: reason: malformed token/);
  });

  test('whoami with a different secret -> AUTH_FAILED', async () => {
    await ok(repo, ['login', 'alice'], { input: `${PW}\n` });
    assert.equal(await fails(repo, ['whoami'], { env: { TB_JWT_SECRET: 'z'.repeat(32) } }), AUTH_FAILED);
  });

  test('usage errors', async () => {
    assert.equal(await fails(repo, ['login']), 'tb: usage: tb login <name>');
    const usage = 'tb: usage: tb user add <name> | tb user rm <name> | tb user unlock <name>';
    for (const args of [['user'], ['user', 'foo'], ['user', 'add'], ['user', 'rm'], ['user', 'unlock'], ['user', 'rm', 'alice', 'extra']]) {
      assert.equal(await fails(repo, args), usage, args.join(' '));
    }
  });

  test('help lists the auth commands', async () => {
    const out = await ok(repo, ['help']);
    for (const s of ['tb user add', 'tb user rm', 'tb user unlock', 'tb login', 'tb logout', 'tb whoami', 'TB_JWT_SECRET']) assert.ok(out.includes(s), s);
  });
});

describe('secret handling', () => {
  for (const [name, env] of [['missing', { TB_JWT_SECRET: undefined }], ['empty', { TB_JWT_SECRET: '' }], ['short', { TB_JWT_SECRET: 'x'.repeat(31) }]]) {
    test(`login with ${name} TB_JWT_SECRET fails before reading stdin`, async () => {
      const t0 = Date.now();
      // stdin kept open for 10s: if tb waited for the password it would hang until then.
      const r = await tb(repo, ['login', 'alice'], { env, keepOpenMs: 10_000 });
      assert.equal(r.code, 2);
      assert.match(r.err, name === 'short' ? /at least 32 bytes/ : /no JWT secret/);
      assert.ok(Date.now() - t0 < 8000, 'did not wait for stdin');
      assert.equal(fs.existsSync(tokenPath), false);
    });
  }
  test('whoami without secret -> config error, not AUTH_FAILED', async () => {
    await ok(repo, ['login', 'alice'], { input: `${PW}\n` });
    assert.match(await fails(repo, ['whoami'], { env: { TB_JWT_SECRET: undefined } }), /no JWT secret/);
  });
  test('logout without secret removes the local token but says it could not revoke', async () => {
    await ok(repo, ['login', 'alice'], { input: `${PW}\n` });
    const tok = readToken();
    assert.match(await fails(repo, ['logout'], { env: { TB_JWT_SECRET: undefined } }), /removed the local token, but could not revoke it/);
    assert.equal(fs.existsSync(tokenPath), false);
    // Not revoked: the token still works if restored.
    fs.writeFileSync(tokenPath, tok);
    assert.match(await ok(repo, ['whoami']), /^alice /);
  });
  test('user add/rm/unlock do not need the secret', async () => {
    const env = { TB_JWT_SECRET: undefined };
    await ok(repo, ['user', 'add', 'nosecret'], { input: `${PW}\n`, env });
    await ok(repo, ['user', 'unlock', 'nosecret'], { env });
    await ok(repo, ['user', 'rm', 'nosecret'], { env });
  });
});

describe('tb logout', () => {
  test('valid token: revokes all tokens, deletes file; old token copied back is rejected', async () => {
    await ok(repo, ['login', 'alice'], { input: `${PW}\n` });
    const first = readToken();
    await ok(repo, ['login', 'alice'], { input: `${PW}\n` });
    const second = readToken();
    assert.equal(await ok(repo, ['logout']), 'logged out alice; every token issued to alice is revoked');
    assert.equal(fs.existsSync(tokenPath), false);
    for (const t of [first, second]) {
      fs.writeFileSync(tokenPath, t);
      assert.equal(await fails(repo, ['whoami']), AUTH_FAILED);
    }
    assert.match(await fails(repo, ['whoami'], { env: { TB_DEBUG: '1' } }), /reason: token revoked/);
    fs.rmSync(tokenPath);
    await ok(repo, ['login', 'alice'], { input: `${PW}\n` });
    assert.match(await ok(repo, ['whoami']), /^alice /);
  });

  test('invalid token: file removed, exit 0', async () => {
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(tokenPath, 'not.a.token');
    assert.equal(await ok(repo, ['logout']), 'removed a token that was already invalid, expired or revoked');
    assert.equal(fs.existsSync(tokenPath), false);
  });

  test('no token: exit 0 not logged in', async () => {
    assert.equal(await ok(repo, ['logout']), 'not logged in');
  });

  test('logout does not affect other users', async () => {
    await ok(repo, ['user', 'add', 'carol'], { input: `${PW}\n` });
    await ok(repo, ['login', 'carol'], { input: `${PW}\n` });
    const carolTok = readToken();
    await ok(repo, ['login', 'alice'], { input: `${PW}\n` });
    await ok(repo, ['logout']);
    fs.writeFileSync(tokenPath, carolTok);
    assert.match(await ok(repo, ['whoami']), /^carol /);
  });
});

describe('tb user rm / unlock', () => {
  test('rm: stdout, local token of that user deleted, old token rejected even after re-add', async () => {
    await ok(repo, ['user', 'add', 'dave'], { input: `${PW}\n` });
    await ok(repo, ['login', 'dave'], { input: `${PW}\n` });
    const tok = readToken();
    assert.equal(await ok(repo, ['user', 'rm', 'DAVE']), 'removed user "dave"; their tokens no longer work');
    assert.equal(fs.existsSync(tokenPath), false);
    fs.writeFileSync(tokenPath, tok);
    assert.match(await fails(repo, ['whoami'], { env: { TB_DEBUG: '1' } }), /reason: user no longer exists/);
    await ok(repo, ['user', 'add', 'dave'], { input: `${PW}\n` });
    assert.match(await fails(repo, ['whoami'], { env: { TB_DEBUG: '1' } }), /reason: token revoked/);
  });

  test('rm of another user keeps the local token', async () => {
    await ok(repo, ['user', 'add', 'erin'], { input: `${PW}\n` });
    await ok(repo, ['login', 'alice'], { input: `${PW}\n` });
    await ok(repo, ['user', 'rm', 'erin']);
    assert.match(await ok(repo, ['whoami']), /^alice /);
  });

  test('rm unknown -> exit 2 no user', async () => {
    assert.equal(await fails(repo, ['user', 'rm', 'ghost']), 'tb: no user "ghost"');
  });

  test('rm does not read stdin', async () => {
    await ok(repo, ['user', 'add', 'frank'], { input: `${PW}\n` });
    const t0 = Date.now();
    const r = await tb(repo, ['user', 'rm', 'frank'], { keepOpenMs: 10_000 });
    assert.equal(r.code, 0, r.err);
    assert.ok(Date.now() - t0 < 8000);
  });

  test('lockout persists across CLI processes; unlock clears it', async () => {
    await ok(repo, ['user', 'add', 'gina'], { input: `${PW}\n` });
    for (let i = 0; i < 5; i++) await fails(repo, ['login', 'gina'], { input: 'wrong password\n' });
    assert.equal(await fails(repo, ['login', 'gina'], { input: `${PW}\n` }), 'tb: invalid username or password');
    assert.equal(fs.existsSync(tokenPath), false);
    assert.equal(await ok(repo, ['user', 'unlock', 'Gina']), 'cleared failed logins and any lockout for "gina"');
    assert.match(await ok(repo, ['login', 'gina'], { input: `${PW}\n` }), /^logged in as gina /);
  });

  test('unlock unknown -> exit 2 no user', async () => {
    assert.equal(await fails(repo, ['user', 'unlock', 'ghost']), 'tb: no user "ghost"');
  });
});

describe('shared state across subdirectories and worktrees', () => {
  test('subdirectory sees the same login', async () => {
    await ok(repo, ['login', 'alice'], { input: `${PW}\n` });
    const sub = path.join(repo, 'sub', 'dir');
    fs.mkdirSync(sub, { recursive: true });
    assert.match(await ok(sub, ['whoami']), /^alice /);
  });

  test('linked worktree shares users and token via the common git dir', async () => {
    await ok(repo, ['login', 'alice'], { input: `${PW}\n` });
    const wt = path.join(root, 'wt');
    g(repo, 'worktree', 'add', '-q', wt, '-b', 'wt-branch');
    try {
      assert.match(await ok(wt, ['whoami']), /^alice /);
      await ok(wt, ['user', 'add', 'wtuser'], { input: `${PW}\n` });
      assert.ok('wtuser' in JSON.parse(fs.readFileSync(usersPath, 'utf8')).users);
      assert.equal(fs.existsSync(path.join(wt, '.git', 'tb-auth')), false);
      assert.equal(g(wt, 'status', '--porcelain'), '');
    } finally {
      g(repo, 'worktree', 'remove', '--force', wt);
    }
  });

  test('outside a git repo -> exit 2 TbError, no crash', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cli-nogit-'));
    try {
      const r = await tb(outside, ['whoami']);
      assert.equal(r.code, 2, r.err);
      assert.match(r.err, /^tb: /);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('concurrent CLI user adds', () => {
  test('6 parallel `tb user add` processes: all persisted', async () => {
    const names = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    const rs = await Promise.all(names.map((n) => tb(repo, ['user', 'add', n], { input: `${PW}\n` })));
    for (const r of rs) assert.equal(r.code, 0, r.err);
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf8')).users;
    for (const n of names) assert.ok(n in users, n);
  });
});

// Hidden TTY prompt, driven through a pseudo-terminal with script(1). BSD (macOS) and util-linux differ.
const scriptCmd = (args) => process.platform === 'darwin'
  ? ['script', ['-q', '/dev/null', process.execPath, TB, ...args]]
  : ['script', ['-qec', [process.execPath, TB, ...args].map((a) => `'${a}'`).join(' '), '/dev/null']];
const hasScript = spawnSync('sh', ['-c', 'command -v script']).status === 0 && process.platform !== 'win32';

function tty(args, keys) {
  return new Promise((resolve) => {
    const [cmd, argv] = scriptCmd(args);
    // Node's child stdin is a socket, which BSD script rejects; feed it through cat so script sees a pipe.
    const q = (a) => `'${String(a).replace(/'/g, `'\\''`)}'`;
    const p = spawn('sh', ['-c', `cat | ${[cmd, ...argv].map(q).join(' ')}`], { cwd: repo, env: { ...process.env, TB_JWT_SECRET: SECRET } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    (async () => {
      for (const k of keys) { await new Promise((r) => setTimeout(r, 700)); p.stdin.write(k); }
      await new Promise((r) => setTimeout(r, 1500));
      p.stdin.end();
    })();
    const timer = setTimeout(() => p.kill('SIGKILL'), 15_000);
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out: out.replace(/\r/g, '') }); });
  });
}

describe('TTY prompt (via script)', { skip: !hasScript && 'script(1) not available' }, () => {
  test('user add asks twice and never echoes the password', async () => {
    const r = await tty(['user', 'add', 'ttyuser'], [`${PW}\r`, `${PW}\r`]);
    assert.match(r.out, /Password for ttyuser: \nRepeat password: \ncreated user "ttyuser"/);
    assert.equal(r.out.includes('horse'), false, 'no echo');
  });
  test('mismatched confirmation -> passwords do not match, nothing created', async () => {
    const r = await tty(['user', 'add', 'ttymis'], [`${PW}\r`, 'different pw\r']);
    assert.match(r.out, /tb: passwords do not match/);
    assert.equal(JSON.parse(fs.readFileSync(usersPath, 'utf8')).users.ttymis, undefined);
  });
  test('backspace edits; arrow-key escape sequences are swallowed', async () => {
    await tty(['user', 'add', 'ttyedit'], [`${PW}\r`, `${PW}\r`]);
    const r1 = await tty(['login', 'ttyedit'], ['correct horse batterX\x7fy\r']);
    assert.match(r1.out, /logged in as ttyedit/);
    const r2 = await tty(['login', 'ttyedit'], ['correct \x1b[Dhorse\x1bOA battery\r']);
    assert.match(r2.out, /logged in as ttyedit/);
    assert.equal(r2.out.includes('horse'), false);
  });
  test('Ctrl-C cancels with exit 2', async () => {
    const r = await tty(['login', 'alice'], ['abc\x03']);
    assert.match(r.out, /tb: cancelled/);
  });
});

describe('D review fixes', () => {
  test('tb user add with any non-password flag -> unknown flag, nothing created', async () => {
    const before = fs.readFileSync(usersPath, 'utf8');
    assert.equal(await fails(repo, ['user', 'add', 'flaggy', '--foo'], { input: `${PW}\n` }), 'tb: unknown flag --foo (this command takes none)');
    assert.equal(await fails(repo, ['login', 'alice', '--foo', 'bar'], { input: `${PW}\n` }), 'tb: unknown flag --foo (this command takes none)');
    assert.equal(fs.readFileSync(usersPath, 'utf8'), before);
    assert.equal(fs.existsSync(tokenPath), false);
  });

  test('tb user rm/unlock with a flag -> usage, nothing changed', async () => {
    const usage = 'tb: usage: tb user add <name> | tb user rm <name> | tb user unlock <name>';
    const before = fs.readFileSync(usersPath, 'utf8');
    assert.equal(await fails(repo, ['user', 'rm', 'alice', '--x']), usage);
    assert.equal(await fails(repo, ['user', 'unlock', 'alice', '--x']), usage);
    assert.equal(await fails(repo, ['user', 'rm', 'alice', '-p', 'pw']), usage);
    assert.equal(fs.readFileSync(usersPath, 'utf8'), before);
  });

  test('logout with a SHORT secret: token removed, exit 2, explains it was not revoked', async () => {
    await ok(repo, ['login', 'alice'], { input: `${PW}\n` });
    const err = await fails(repo, ['logout'], { env: { TB_JWT_SECRET: 'short' } });
    assert.match(err, /^tb: removed the local token, but could not revoke it: JWT secret must be at least 32 bytes$/);
    assert.equal(fs.existsSync(tokenPath), false);
  });

  test('TB_DEBUG: exactly one extra reason line; none without it', async () => {
    await ok(repo, ['login', 'alice'], { input: `${PW}\n` });
    const tok = readToken();
    await ok(repo, ['logout']);
    fs.writeFileSync(tokenPath, tok);
    const plain = await fails(repo, ['whoami']);
    assert.equal(plain, AUTH_FAILED);
    assert.equal(plain.split('\n').length, 1);
    const dbg = (await fails(repo, ['whoami'], { env: { TB_DEBUG: '1' } })).split('\n');
    assert.deepEqual(dbg, [AUTH_FAILED, 'tb: reason: token revoked']);
  });

  test('TB_DEBUG adds nothing for errors without a cause', async () => {
    const err = await fails(repo, ['login', 'alice'], { input: 'wrong password\n', env: { TB_DEBUG: '1' } });
    assert.equal(err, 'tb: invalid username or password', 'login failure reason never revealed, even with TB_DEBUG');
    await ok(repo, ['user', 'unlock', 'alice']);
  });
});
