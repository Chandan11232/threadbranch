import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TB = path.join(HERE, '..', 'bin', 'tb.js');
const DEMO = path.join(HERE, '..', 'examples', 'demo-app');
let repo;

const run = (cwd, ...args) => {
  const r = spawnSync(process.execPath, [TB, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout + r.stderr).trim() };
};
const ok = (cwd, ...args) => {
  const r = run(cwd, ...args);
  assert.equal(r.code, 0, r.out);
  return r.out;
};
const g = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim();

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-'));
  fs.cpSync(DEMO, repo, { recursive: true });
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Test'], ['config', 'user.email', 't@t'], ['add', '-A'], ['commit', '-q', '-m', 'init']]) g(repo, ...a);
  ok(repo, 'init');
});
after(() => fs.rmSync(repo, { recursive: true, force: true }));

test('open creates a branch and worktree per thread, idempotently', () => {
  const out = ok(repo, 'open', '--thread', 'evt_ABC123', '--title', 'Validate email', '--by', '@priya');
  assert.match(out, /thread\/validate-email-abc123/);
  const wt = ok(repo, 'where', 'evt_ABC123');
  assert.ok(fs.existsSync(path.join(wt, 'validate.js')));
  assert.equal(g(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'thread/validate-email-abc123');
  assert.match(ok(repo, 'open', '--thread', 'evt_ABC123', '--title', 'x', '--by', 'priya'), /already open/);
  assert.equal(g(repo, 'status', '--porcelain'), '', '.tb must not dirty the main checkout');
});

test('merge is refused until quorum and tests pass on the current commit', () => {
  const wt = ok(repo, 'where', 'evt_ABC123');
  const v = path.join(wt, 'validate.js');
  fs.writeFileSync(v, fs.readFileSync(v, 'utf8').replace("errors.push('Email is required');", "errors.push('Email is required');\n  else if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email)) errors.push('Email looks invalid');"));
  ok(wt, 'commit', 'validate-email-abc123', '-m', 'Validate email format', '--by', 'priya');

  let r = run(repo, 'merge', 'evt_ABC123', '--by', 'priya');
  assert.equal(r.code, 2);
  assert.match(r.out, /needs 2 approvals/);
  assert.match(r.out, /tests have not passed/);

  // The requester's own approval does not count.
  assert.match(ok(repo, 'approve', 'evt_ABC123', '--by', 'priya'), /does not count/);
  ok(repo, 'approve', 'evt_ABC123', '--by', 'sam');
  ok(repo, 'approve', 'evt_ABC123', '--by', 'SAM'); // same person, different case
  assert.match(ok(repo, 'check', 'evt_ABC123'), /has 1 \(sam\)/);

  ok(repo, 'approve', 'evt_ABC123', '--by', 'lee');
  assert.match(ok(repo, 'test', 'evt_ABC123'), /^PASS/);
  assert.equal(ok(repo, 'check', 'evt_ABC123'), 'clear to merge');
});

test('a new commit makes earlier approvals stale', () => {
  const wt = ok(repo, 'where', 'evt_ABC123');
  fs.appendFileSync(path.join(wt, 'validate.js'), '\n// tweak\n');
  assert.match(ok(repo, 'commit', 'evt_ABC123', '-m', 'tweak', '--by', 'priya'), /no longer count/);
  assert.match(ok(repo, 'check', 'evt_ABC123'), /has 0/);
  ok(repo, 'approve', 'evt_ABC123', '--by', 'sam');
  ok(repo, 'approve', 'evt_ABC123', '--by', 'lee');
  ok(repo, 'test', 'evt_ABC123');
});

test('merge lands on main with an attributed merge commit, and revert undoes it', () => {
  const out = ok(repo, 'merge', 'evt_ABC123', '--by', 'lee');
  assert.match(out, /merged thread\/validate-email-abc123 into main/);
  const msg = g(repo, 'log', '-1', '--format=%B');
  assert.match(msg, /Approved-by: sam, lee|Approved-by: lee, sam/);
  assert.match(fs.readFileSync(path.join(repo, 'validate.js'), 'utf8'), /Email looks invalid/);
  assert.match(ok(repo, 'board'), /🟢 Validate email/);

  ok(repo, 'revert', 'evt_ABC123', '--by', 'sam');
  assert.doesNotMatch(fs.readFileSync(path.join(repo, 'validate.js'), 'utf8'), /Email looks invalid/);
  assert.match(ok(repo, 'log', 'evt_ABC123'), /merge .*\n.*revert/s);
});

test('failing tests block the merge', () => {
  ok(repo, 'open', '--thread', 'evt_BROKEN1', '--title', 'Break things', '--by', 'sam');
  const wt = ok(repo, 'where', 'evt_BROKEN1');
  fs.writeFileSync(path.join(wt, 'validate.js'), 'export function validateSignup() { return ["always"]; }\n');
  ok(repo, 'commit', 'evt_BROKEN1', '-m', 'oops', '--by', 'sam');
  ok(repo, 'approve', 'evt_BROKEN1', '--by', 'priya');
  ok(repo, 'approve', 'evt_BROKEN1', '--by', 'lee');
  assert.match(run(repo, 'test', 'evt_BROKEN1').out, /^FAIL/);
  const r = run(repo, 'merge', 'evt_BROKEN1', '--by', 'lee');
  assert.equal(r.code, 2);
  assert.match(r.out, /tests have not passed/);
  ok(repo, 'close', 'evt_BROKEN1', '--by', 'sam');
  assert.match(ok(repo, 'board'), /⚪ Break things/);
});

test('preview serves the thread worktree on its own port', () => {
  ok(repo, 'open', '--thread', 'evt_PREV01', '--title', 'Preview me', '--by', 'sam');
  const out = ok(repo, 'preview', 'evt_PREV01');
  const url = out.match(/http:\/\/localhost:\d+/)[0];
  const r = spawnSync('curl', ['-s', url], { encoding: 'utf8' });
  assert.match(r.stdout, /Join Acme/);
  ok(repo, 'close', 'evt_PREV01', '--by', 'sam');
  const after = spawnSync('curl', ['-s', '--max-time', '2', url], { encoding: 'utf8' });
  assert.notEqual(after.status, 0, 'preview should stop when the thread closes');
});
