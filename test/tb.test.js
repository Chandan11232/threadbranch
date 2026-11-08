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

test('log --oneline --stat tells the whole thread story in chat-sized lines', () => {
  ok(repo, 'open', '--thread', 'evt_LOG001', '--title', 'Fix submit button + 3D burst', '--by', 'priya');
  const wt = ok(repo, 'where', 'evt_LOG001');
  fs.writeFileSync(path.join(wt, 'burst.js'), 'export const burst = () => "boom";\n');
  ok(repo, 'commit', 'evt_LOG001', '-m', 'Fix submit handler\nand add 3D burst', '--by', 'priya');
  ok(repo, 'test', 'evt_LOG001');
  ok(repo, 'approve', 'evt_LOG001', '--by', 'sam');
  assert.equal(run(repo, 'merge', 'evt_LOG001', '--by', 'sam').code, 2);
  ok(repo, 'approve', 'evt_LOG001', '--by', 'lee');
  ok(repo, 'merge', 'evt_LOG001', '--by', 'lee');

  const out = ok(repo, 'log', 'evt_LOG001', '--oneline', '--stat');
  const lines = out.split('\n');
  assert.match(lines[0], /^thread\/fix-submit-button-3d-burst-log001 · merged into main as [0-9a-f]{7} · opened by priya/);
  assert.match(out, /opened by priya · "Fix submit button \+ 3D burst"/);
  assert.match(out, /commit {2}[0-9a-f]{7} by priya · Fix submit handler and add 3D burst\n/, 'multi-line messages stay on one line');
  assert.match(out, /test {4}[0-9a-f]{7} PASS/);
  assert.match(out, /approve [0-9a-f]{7} by sam/);
  assert.match(out, /ship refused by sam · needs 2 approvals/);
  assert.match(out, /MERGED {2}[0-9a-f]{7} by lee into main as [0-9a-f]{7} · approved by (sam, lee|lee, sam)/);
  assert.match(out, /files changed:\n burst\.js \| 1 \+\n 1 file changed/);
  assert.doesNotMatch(out, /evt_LOG001|=/, 'no raw ids or key=value noise');

  // Flag before the thread, and --n, both work; --oneline alone has no file list.
  const short = ok(repo, 'log', '--oneline', 'evt_LOG001', '--n', '2');
  assert.equal(short.split('\n').length, 3);
  assert.doesNotMatch(short, /files changed/);
  // Top level: every thread, tagged by key.
  assert.match(ok(repo, 'log', '--oneline'), /\[fix-submit-button-3d-burst-log001\] MERGED/);
  assert.match(run(repo, 'log', '--stat').out, /--stat needs a thread/);
});

test('log --stat on an open thread lists the branch changes so far', () => {
  ok(repo, 'open', '--thread', 'evt_LOG002', '--title', 'Open one', '--by', 'sam');
  const wt = ok(repo, 'where', 'evt_LOG002');
  assert.match(ok(repo, 'log', 'evt_LOG002', '--stat'), /· open · opened by sam[\s\S]*files changed:\nno file changes/);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'a\n');
  ok(repo, 'commit', 'evt_LOG002', '-m', 'add a', '--by', 'sam');
  assert.match(ok(repo, 'log', 'evt_LOG002', '--stat'), /a\.txt \| 1 \+/);
  ok(repo, 'close', 'evt_LOG002', '--by', 'sam');
});
