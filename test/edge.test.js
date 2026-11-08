// Edge cases for the merge gate, thread ids, revert, audit log and previews.
// Every test builds its own throwaway repo so failures stay independent.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TB = path.join(HERE, '..', 'bin', 'tb.js');
const DEMO = path.join(HERE, '..', 'examples', 'demo-app');
const repos = [];
const children = [];

const run = (cwd, ...args) => {
  const r = spawnSync(process.execPath, [TB, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout + r.stderr).trim() };
};
const ok = (cwd, ...args) => {
  const r = run(cwd, ...args);
  assert.equal(r.code, 0, r.out);
  return r.out;
};
/** A refusal is a clean TbError (exit 2), never a crash (exit 1 with a stack trace). */
const refused = (cwd, ...args) => {
  const r = run(cwd, ...args);
  assert.equal(r.code, 2, `expected a clean refusal (exit 2), got ${r.code}:\n${r.out}`);
  return r.out;
};
const g = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim();

/** New repo from the demo app with `tb init` run and config overrides applied. */
function fresh(config = {}, initArgs = []) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-edge-')));
  repos.push(repo);
  fs.cpSync(DEMO, repo, { recursive: true });
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Test'], ['config', 'user.email', 't@t'], ['add', '-A'], ['commit', '-q', '-m', 'init']]) g(repo, ...a);
  ok(repo, 'init', ...initArgs);
  const file = path.join(repo, '.tb', 'config.json');
  // Fast, deterministic test gate by default; tests that need the real suite override it.
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), testCommand: 'true', previewPortStart: 4600, ...config }, null, 2));
  return repo;
}

/** Open a thread and commit one change to it. Returns the worktree path. */
function openWithCommit(repo, thread, by = 'priya', title = 'Some change') {
  ok(repo, 'open', '--thread', thread, '--title', title, '--by', by);
  const wt = ok(repo, 'where', thread);
  fs.appendFileSync(path.join(wt, 'validate.js'), `\n// ${thread}\n`);
  ok(repo, 'commit', thread, '-m', 'change', '--by', by);
  return wt;
}

const audit = (repo) => fs.readFileSync(path.join(repo, '.tb', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const state = (repo) => JSON.parse(fs.readFileSync(path.join(repo, '.tb', 'state.json'), 'utf8'));

after(() => {
  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  for (const r of repos) {
    // Stop any preview servers left behind.
    try {
      for (const t of Object.values(state(r).threads)) if (t.preview?.pid) try { process.kill(-t.preview.pid); } catch { /* gone */ }
    } catch { /* no state */ }
    fs.rmSync(r, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ approvals

test('opener approval never counts, whatever case, @ or whitespace they use', () => {
  const repo = fresh({ approvalsRequired: 1 });
  openWithCommit(repo, 'evt_SELF01', '@Priya');
  for (const who of ['priya', 'PRIYA', ' @priya ', '@PrIyA']) {
    assert.match(ok(repo, 'approve', 'evt_SELF01', '--by', who), /does not count/, who);
  }
  assert.match(ok(repo, 'check', 'evt_SELF01'), /has 0/);
  refused(repo, 'merge', 'evt_SELF01', '--by', 'priya');
});

test('selfApproveCounts: true lets the opener count', () => {
  const repo = fresh({ approvalsRequired: 1, selfApproveCounts: true });
  openWithCommit(repo, 'evt_SELF02', 'priya');
  assert.doesNotMatch(ok(repo, 'approve', 'evt_SELF02', '--by', 'Priya'), /does not count/);
  ok(repo, 'test', 'evt_SELF02');
  assert.equal(ok(repo, 'check', 'evt_SELF02'), 'clear to merge');
});

test('one person approving many times under name variants counts once', () => {
  const repo = fresh();
  openWithCommit(repo, 'evt_DUP001');
  for (const who of ['sam', 'Sam', 'SAM', '@sam', '  sam  ', '@SAM ']) ok(repo, 'approve', 'evt_DUP001', '--by', who);
  ok(repo, 'test', 'evt_DUP001');
  assert.match(ok(repo, 'check', 'evt_DUP001'), /needs 2 approvals .* has 1 \(sam\)/);
  assert.equal(state(repo).threads.evt_DUP001.approvals.length, 1, 'repeat approvals should replace, not stack');
});

test('blank or @-only approver names are rejected, not counted as a person', () => {
  const repo = fresh({ approvalsRequired: 1 });
  openWithCommit(repo, 'evt_BLANK1');
  for (const who of ['   ', '@', ' @ ']) {
    const r = run(repo, 'approve', 'evt_BLANK1', '--by', who);
    assert.notEqual(r.code, 0, `approve --by ${JSON.stringify(who)} should be refused, got: ${r.out}`);
  }
  ok(repo, 'test', 'evt_BLANK1');
  assert.match(ok(repo, 'check', 'evt_BLANK1'), /has 0/);
});

test('approvals made before a new commit stop counting; approvals after it count', () => {
  const repo = fresh();
  const wt = openWithCommit(repo, 'evt_STALE1');
  ok(repo, 'approve', 'evt_STALE1', '--by', 'sam');
  ok(repo, 'approve', 'evt_STALE1', '--by', 'lee');
  ok(repo, 'test', 'evt_STALE1');
  assert.equal(ok(repo, 'check', 'evt_STALE1'), 'clear to merge');

  fs.appendFileSync(path.join(wt, 'validate.js'), '\n// more\n');
  ok(repo, 'commit', 'evt_STALE1', '-m', 'more', '--by', 'priya');
  const c = ok(repo, 'check', 'evt_STALE1');
  assert.match(c, /has 0/);
  assert.match(c, /tests have not passed/, 'test result was for the old commit');

  ok(repo, 'approve', 'evt_STALE1', '--by', 'sam');
  assert.match(ok(repo, 'check', 'evt_STALE1'), /has 1 \(sam\)/);
  ok(repo, 'approve', 'evt_STALE1', '--by', 'lee');
  ok(repo, 'test', 'evt_STALE1');
  assert.equal(ok(repo, 'check', 'evt_STALE1'), 'clear to merge');
});

test('a commit made with plain git (bypassing tb commit) also makes approvals stale', () => {
  const repo = fresh();
  const wt = openWithCommit(repo, 'evt_RAWGIT');
  ok(repo, 'approve', 'evt_RAWGIT', '--by', 'sam');
  ok(repo, 'approve', 'evt_RAWGIT', '--by', 'lee');
  ok(repo, 'test', 'evt_RAWGIT');
  fs.appendFileSync(path.join(wt, 'validate.js'), '\n// sneaky\n');
  g(wt, 'commit', '-qam', 'sneaky');
  const r = refused(repo, 'merge', 'evt_RAWGIT', '--by', 'lee');
  assert.match(r, /has 0/);
});

test('unapprove withdraws a vote', () => {
  const repo = fresh({ approvalsRequired: 1 });
  openWithCommit(repo, 'evt_UNAPP1');
  ok(repo, 'approve', 'evt_UNAPP1', '--by', 'sam');
  ok(repo, 'unapprove', 'evt_UNAPP1', '--by', '@SAM');
  ok(repo, 'test', 'evt_UNAPP1');
  assert.match(ok(repo, 'check', 'evt_UNAPP1'), /has 0/);
});

test('approving a closed thread is refused', () => {
  const repo = fresh();
  openWithCommit(repo, 'evt_CLOSE1');
  ok(repo, 'close', 'evt_CLOSE1', '--by', 'priya');
  assert.match(refused(repo, 'approve', 'evt_CLOSE1', '--by', 'sam'), /closed/);
});

// ------------------------------------------------------------------ tests gate

test('a failing testCommand blocks the merge', () => {
  const repo = fresh({ testCommand: 'exit 1' });
  openWithCommit(repo, 'evt_FAIL01');
  ok(repo, 'approve', 'evt_FAIL01', '--by', 'sam');
  ok(repo, 'approve', 'evt_FAIL01', '--by', 'lee');
  assert.match(run(repo, 'test', 'evt_FAIL01').out, /^FAIL/);
  assert.match(refused(repo, 'merge', 'evt_FAIL01', '--by', 'lee'), /tests have not passed/);
});

test('a testCommand that does not exist counts as failing', () => {
  const repo = fresh({ testCommand: 'definitely-not-a-real-command-xyz' });
  openWithCommit(repo, 'evt_FAIL02');
  ok(repo, 'approve', 'evt_FAIL02', '--by', 'sam');
  ok(repo, 'approve', 'evt_FAIL02', '--by', 'lee');
  assert.match(run(repo, 'test', 'evt_FAIL02').out, /^FAIL/);
  assert.match(refused(repo, 'merge', 'evt_FAIL02', '--by', 'lee'), /tests have not passed/);
});

test('merging without ever running tests is refused', () => {
  const repo = fresh();
  openWithCommit(repo, 'evt_NOTEST');
  ok(repo, 'approve', 'evt_NOTEST', '--by', 'sam');
  ok(repo, 'approve', 'evt_NOTEST', '--by', 'lee');
  assert.match(refused(repo, 'merge', 'evt_NOTEST', '--by', 'lee'), /tests have not passed/);
});

test('testCommand null turns the test gate off', () => {
  const repo = fresh({ testCommand: null });
  openWithCommit(repo, 'evt_NOGATE');
  assert.match(ok(repo, 'test', 'evt_NOGATE'), /test gate is off/);
  ok(repo, 'approve', 'evt_NOGATE', '--by', 'sam');
  ok(repo, 'approve', 'evt_NOGATE', '--by', 'lee');
  assert.match(ok(repo, 'merge', 'evt_NOGATE', '--by', 'lee'), /merged/);
});

test('a test pass recorded while the worktree had uncommitted fixes does not vouch for the commit', () => {
  // Commit broken code, fix it without committing, run tests (green), then drop the fix.
  // The green result described the dirty tree, not the commit that would merge.
  const repo = fresh({ testCommand: 'npm test' });
  ok(repo, 'open', '--thread', 'evt_DIRTYT', '--title', 'Dirty test', '--by', 'priya');
  const wt = ok(repo, 'where', 'evt_DIRTYT');
  const v = path.join(wt, 'validate.js');
  const good = fs.readFileSync(v, 'utf8');
  fs.writeFileSync(v, 'export function validateSignup() { return ["always"]; }\n');
  ok(repo, 'commit', 'evt_DIRTYT', '-m', 'broken', '--by', 'priya');
  fs.writeFileSync(v, good); // uncommitted fix
  run(repo, 'test', 'evt_DIRTYT');
  g(wt, 'checkout', '--', 'validate.js'); // back to the broken commit, tree clean
  ok(repo, 'approve', 'evt_DIRTYT', '--by', 'sam');
  ok(repo, 'approve', 'evt_DIRTYT', '--by', 'lee');
  assert.match(refused(repo, 'merge', 'evt_DIRTYT', '--by', 'lee'), /tests/);
});

// ------------------------------------------------------------------ clean tree

test('uncommitted changes in the worktree block the merge', () => {
  const repo = fresh();
  const wt = openWithCommit(repo, 'evt_DIRTY1');
  ok(repo, 'approve', 'evt_DIRTY1', '--by', 'sam');
  ok(repo, 'approve', 'evt_DIRTY1', '--by', 'lee');
  ok(repo, 'test', 'evt_DIRTY1');
  fs.writeFileSync(path.join(wt, 'new-file.txt'), 'untracked\n');
  assert.match(refused(repo, 'merge', 'evt_DIRTY1', '--by', 'lee'), /uncommitted changes/);
});

test('a dirty main checkout blocks the merge, shows up in check, and is audited', () => {
  const repo = fresh();
  openWithCommit(repo, 'evt_DIRTYM');
  ok(repo, 'approve', 'evt_DIRTYM', '--by', 'sam');
  ok(repo, 'approve', 'evt_DIRTYM', '--by', 'lee');
  ok(repo, 'test', 'evt_DIRTYM');
  fs.appendFileSync(path.join(repo, 'index.html'), '<!-- local edit -->\n');
  const before = g(repo, 'rev-parse', 'HEAD');
  assert.match(refused(repo, 'merge', 'evt_DIRTYM', '--by', 'lee'), /uncommitted changes/);
  assert.equal(g(repo, 'rev-parse', 'HEAD'), before, 'main must not move');
  assert.equal(state(repo).threads.evt_DIRTYM.status, 'open');
  assert.ok(audit(repo).some((e) => e.event === 'merge_refused' && e.thread === 'evt_DIRTYM'), 'refused merge should be in the audit log');
  assert.notEqual(ok(repo, 'check', 'evt_DIRTYM'), 'clear to merge', 'check should agree with merge');
});

test('merge is refused when the main checkout is on another branch', () => {
  const repo = fresh();
  openWithCommit(repo, 'evt_OTHERB');
  ok(repo, 'approve', 'evt_OTHERB', '--by', 'sam');
  ok(repo, 'approve', 'evt_OTHERB', '--by', 'lee');
  ok(repo, 'test', 'evt_OTHERB');
  g(repo, 'checkout', '-q', '-b', 'side');
  assert.match(refused(repo, 'merge', 'evt_OTHERB', '--by', 'lee'), /expected main/);
  assert.equal(g(repo, 'rev-parse', 'main'), g(repo, 'rev-parse', 'side'));
});

test('a thread with no commits cannot merge', () => {
  const repo = fresh({ approvalsRequired: 1 });
  ok(repo, 'open', '--thread', 'evt_EMPTY1', '--title', 'Nothing', '--by', 'priya');
  assert.equal(ok(repo, 'commit', 'evt_EMPTY1', '-m', 'x', '--by', 'priya'), 'nothing to commit');
  ok(repo, 'approve', 'evt_EMPTY1', '--by', 'sam');
  ok(repo, 'test', 'evt_EMPTY1');
  assert.match(refused(repo, 'merge', 'evt_EMPTY1', '--by', 'sam'), /no commits/);
});

// ------------------------------------------------------------------ lifecycle

test('merging twice is refused cleanly, and check on a merged thread does not crash', () => {
  const repo = fresh();
  openWithCommit(repo, 'evt_TWICE1');
  ok(repo, 'approve', 'evt_TWICE1', '--by', 'sam');
  ok(repo, 'approve', 'evt_TWICE1', '--by', 'lee');
  ok(repo, 'test', 'evt_TWICE1');
  ok(repo, 'merge', 'evt_TWICE1', '--by', 'lee');
  assert.match(refused(repo, 'merge', 'evt_TWICE1', '--by', 'lee'), /thread is merged/);
  assert.match(ok(repo, 'check', 'evt_TWICE1'), /thread is merged/);
});

test('commands on a closed thread refuse cleanly instead of crashing', () => {
  const repo = fresh();
  openWithCommit(repo, 'evt_CLOSE2');
  ok(repo, 'close', 'evt_CLOSE2', '--by', 'priya');
  assert.match(refused(repo, 'merge', 'evt_CLOSE2', '--by', 'sam'), /closed/);
  refused(repo, 'commit', 'evt_CLOSE2', '-m', 'x', '--by', 'priya');
  refused(repo, 'test', 'evt_CLOSE2');
  ok(repo, 'board');
});

test('re-opening an existing open thread is idempotent and keeps the opener', () => {
  const repo = fresh();
  ok(repo, 'open', '--thread', 'evt_REOPEN', '--title', 'First', '--by', 'priya');
  assert.match(ok(repo, 'open', '--thread', 'evt_REOPEN', '--title', 'Second', '--by', 'mallory'), /already open/);
  const t = state(repo).threads.evt_REOPEN;
  assert.equal(t.openedBy, 'priya');
  assert.equal(t.title, 'First');
  assert.equal(g(repo, 'branch', '--list', 'thread/*').split('\n').length, 1);
});

test('re-opening a closed thread does not report a missing worktree as open', () => {
  const repo = fresh();
  ok(repo, 'open', '--thread', 'evt_REOPN2', '--title', 'First', '--by', 'priya');
  ok(repo, 'close', 'evt_REOPN2', '--by', 'priya');
  const r = run(repo, 'open', '--thread', 'evt_REOPN2', '--title', 'First', '--by', 'priya');
  if (r.code === 0) {
    assert.doesNotMatch(r.out, /already open/, 'a closed thread is not open');
    assert.ok(fs.existsSync(ok(repo, 'where', 'evt_REOPN2')), 'if it reports success, the worktree must exist');
  } else {
    assert.equal(r.code, 2, r.out);
  }
});

// ------------------------------------------------------------------ odd ids

test('thread ids with slashes, spaces and dots get safe branch names', () => {
  const repo = fresh();
  for (const id of ['C01/1730000000.123456', 'evt with spaces', '../../escape', '..']) {
    ok(repo, 'open', '--thread', id, '--title', '../weird/ Title!', '--by', 'priya');
    const wt = ok(repo, 'where', id);
    assert.ok(wt.startsWith(path.join(repo, '.tb', 'worktrees') + path.sep), `${id}: worktree ${wt} escaped .tb/worktrees`);
    assert.ok(fs.existsSync(wt), id);
    const branch = g(wt, 'rev-parse', '--abbrev-ref', 'HEAD');
    assert.match(branch, /^thread\/[a-z0-9-]+$/, `${id}: ${branch}`);
  }
  assert.equal(g(repo, 'status', '--porcelain'), '');
});

test('very long thread ids and titles stay usable', () => {
  const repo = fresh();
  const id = 'evt_' + 'x'.repeat(500) + 'END999';
  ok(repo, 'open', '--thread', id, '--title', 'word '.repeat(200), '--by', 'priya');
  const wt = ok(repo, 'where', id);
  const branch = g(wt, 'rev-parse', '--abbrev-ref', 'HEAD');
  assert.ok(branch.length < 60, branch);
  assert.match(branch, /end999$/);
});

test('two threads whose ids share the last 6 characters and title get separate branches', () => {
  // Slack thread ids are timestamps like 1730000000.123456; the tail is what differs least reliably.
  const repo = fresh();
  ok(repo, 'open', '--thread', '1730000000.123456', '--title', 'Fix typo', '--by', 'priya');
  const r = run(repo, 'open', '--thread', '1730009999.123456', '--title', 'Fix typo', '--by', 'sam');
  assert.equal(r.code, 0, r.out);
  const a = ok(repo, 'where', '1730000000.123456');
  const b = ok(repo, 'where', '1730009999.123456');
  assert.notEqual(a, b);
});

test('thread ids that collide with Object.prototype keys work like any other id', () => {
  const repo = fresh();
  for (const id of ['constructor', 'toString', '__proto__']) {
    const out = ok(repo, 'open', '--thread', id, '--title', `Proto ${id}`, '--by', 'priya');
    assert.match(out, /^opened /, `${id}: ${out}`);
    assert.ok(fs.existsSync(ok(repo, 'where', id)), id);
  }
});

test('a branch key that matches another thread\'s short id resolves to the right thread', () => {
  const repo = fresh();
  ok(repo, 'open', '--thread', 'evt_AAA111', '--title', 'Alpha', '--by', 'priya');
  ok(repo, 'open', '--thread', 'evt_BBB222', '--title', 'Beta', '--by', 'priya');
  assert.match(ok(repo, 'where', 'beta-bbb222'), /beta-bbb222$/);
  assert.match(ok(repo, 'where', 'thread/alpha-aaa111'), /alpha-aaa111$/);
  assert.match(refused(repo, 'where', 'nope'), /no thread/);
});

// ------------------------------------------------------------------ revert

test('revert undoes the merge on main and can only happen once', () => {
  const repo = fresh();
  openWithCommit(repo, 'evt_REV001');
  ok(repo, 'approve', 'evt_REV001', '--by', 'sam');
  ok(repo, 'approve', 'evt_REV001', '--by', 'lee');
  ok(repo, 'test', 'evt_REV001');
  ok(repo, 'merge', 'evt_REV001', '--by', 'lee');
  assert.match(fs.readFileSync(path.join(repo, 'validate.js'), 'utf8'), /evt_REV001/);
  ok(repo, 'revert', 'evt_REV001', '--by', 'sam');
  assert.doesNotMatch(fs.readFileSync(path.join(repo, 'validate.js'), 'utf8'), /evt_REV001/);
  assert.equal(state(repo).threads.evt_REV001.status, 'reverted');
  assert.match(refused(repo, 'revert', 'evt_REV001', '--by', 'sam'), /only merged threads/);
});

test('revert of an open thread is refused', () => {
  const repo = fresh();
  openWithCommit(repo, 'evt_REV002');
  assert.match(refused(repo, 'revert', 'evt_REV002', '--by', 'sam'), /only merged threads/);
});

test('revert refuses when the main checkout is not on the base branch', () => {
  const repo = fresh();
  openWithCommit(repo, 'evt_REV003');
  ok(repo, 'approve', 'evt_REV003', '--by', 'sam');
  ok(repo, 'approve', 'evt_REV003', '--by', 'lee');
  ok(repo, 'test', 'evt_REV003');
  ok(repo, 'merge', 'evt_REV003', '--by', 'lee');
  g(repo, 'checkout', '-q', '-b', 'side');
  const sideBefore = g(repo, 'rev-parse', 'side');
  const r = run(repo, 'revert', 'evt_REV003', '--by', 'sam');
  assert.equal(r.code, 2, `revert should refuse off-base, got ${r.code}: ${r.out}`);
  assert.equal(g(repo, 'rev-parse', 'side'), sideBefore, 'revert must not commit onto a non-base branch');
});

test('revert refuses with a dirty main checkout', () => {
  const repo = fresh();
  openWithCommit(repo, 'evt_REV004');
  ok(repo, 'approve', 'evt_REV004', '--by', 'sam');
  ok(repo, 'approve', 'evt_REV004', '--by', 'lee');
  ok(repo, 'test', 'evt_REV004');
  ok(repo, 'merge', 'evt_REV004', '--by', 'lee');
  fs.appendFileSync(path.join(repo, 'index.html'), '<!-- edit -->\n');
  assert.match(refused(repo, 'revert', 'evt_REV004', '--by', 'sam'), /uncommitted/);
});

// ------------------------------------------------------------------ audit

test('audit log records every step with who, which commit and the approvers', () => {
  const repo = fresh();
  openWithCommit(repo, 'evt_AUD001', '@Priya');
  const sha = state(repo).threads.evt_AUD001.commits[0].sha;
  refused(repo, 'merge', 'evt_AUD001', '--by', 'priya');
  ok(repo, 'approve', 'evt_AUD001', '--by', 'Sam');
  ok(repo, 'approve', 'evt_AUD001', '--by', 'lee');
  ok(repo, 'test', 'evt_AUD001');
  ok(repo, 'merge', 'evt_AUD001', '--by', 'Lee');
  ok(repo, 'revert', 'evt_AUD001', '--by', 'sam');

  const rows = audit(repo).filter((r) => r.thread === 'evt_AUD001');
  assert.deepEqual(rows.map((r) => r.event), ['open', 'commit', 'merge_refused', 'approve', 'approve', 'test', 'merge', 'revert']);
  for (const r of rows) assert.ok(!Number.isNaN(Date.parse(r.at)), `bad timestamp ${r.at}`);
  assert.equal(rows[0].by, 'priya');
  assert.equal(rows[1].sha, sha);
  assert.ok(rows[2].blockers.length >= 1);
  assert.deepEqual(rows.filter((r) => r.event === 'approve').map((r) => [r.by, r.sha]), [['sam', sha], ['lee', sha]]);
  assert.equal(rows[5].ok, true);
  const m = rows[6];
  assert.equal(m.by, 'lee');
  assert.equal(m.sha, sha);
  assert.deepEqual([...m.approvers].sort(), ['lee', 'sam']);
  assert.match(m.mergeSha, /^[0-9a-f]{40}$/);

  const log = ok(repo, 'log', 'evt_AUD001');
  assert.equal(log.split('\n').length, 8);
  assert.match(ok(repo, 'log', '--n', '1'), /revert/);
});

test('audit log is append-only JSON lines and is not tracked by git', () => {
  const repo = fresh();
  ok(repo, 'open', '--thread', 'evt_AUD002', '--title', 'A', '--by', 'priya');
  const raw = fs.readFileSync(path.join(repo, '.tb', 'audit.jsonl'), 'utf8');
  assert.ok(raw.endsWith('\n'));
  for (const line of raw.trim().split('\n')) JSON.parse(line);
  assert.equal(g(repo, 'status', '--porcelain'), '');
});

// ------------------------------------------------------------------ config

test('init rejects a non-numeric or non-positive approval count', () => {
  for (const n of ['abc', '-1']) {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-edge-'));
    repos.push(repo);
    g(repo, 'init', '-q', '-b', 'main');
    g(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    const r = run(repo, 'init', '--approvals', n);
    if (r.code === 0) {
      const cfg = JSON.parse(fs.readFileSync(path.join(repo, '.tb', 'config.json'), 'utf8'));
      assert.ok(Number.isInteger(cfg.approvalsRequired) && cfg.approvalsRequired >= 1, `--approvals ${n} stored ${cfg.approvalsRequired}`);
    }
  }
});

// ------------------------------------------------------------------ previews

const curl = (url) => spawnSync('curl', ['-s', '--max-time', '3', url], { encoding: 'utf8' });
const portOf = (out) => Number(out.match(/localhost:(\d+)/)[1]);

test('concurrent previews get distinct ports and a restart keeps its port', () => {
  const repo = fresh({ previewPortStart: 4610 });
  ok(repo, 'open', '--thread', 'evt_PRV_A', '--title', 'Prev A', '--by', 'priya');
  ok(repo, 'open', '--thread', 'evt_PRV_B', '--title', 'Prev B', '--by', 'priya');
  const a = portOf(ok(repo, 'preview', 'evt_PRV_A'));
  const b = portOf(ok(repo, 'preview', 'evt_PRV_B'));
  assert.notEqual(a, b);
  assert.ok(a >= 4610 && b >= 4610);
  assert.match(curl(`http://localhost:${a}`).stdout, /Join Acme/);
  assert.match(curl(`http://localhost:${b}`).stdout, /Join Acme/);
  const a2 = portOf(ok(repo, 'preview', 'evt_PRV_A'));
  assert.equal(a2, a, 'restarting a preview should reuse its port');
  ok(repo, 'close', 'evt_PRV_A', '--by', 'priya');
  ok(repo, 'close', 'evt_PRV_B', '--by', 'priya');
});

test('preview skips a port another program is already listening on', async () => {
  const start = 4630;
  // Listen the way most dev servers do: default host (all interfaces).
  const blocker = spawn(process.execPath, ['-e', `require('http').createServer((q,s)=>s.end('BLOCKER')).listen(${start},()=>console.log('up'))`], { stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(blocker);
  await new Promise((res) => blocker.stdout.once('data', res));
  const repo = fresh({ previewPortStart: start });
  ok(repo, 'open', '--thread', 'evt_PRV_C', '--title', 'Prev C', '--by', 'priya');
  const r = run(repo, 'preview', 'evt_PRV_C');
  blocker.kill();
  assert.equal(r.code, 0, r.out);
  assert.notEqual(portOf(r.out), start, `picked the occupied port: ${r.out}`);
  ok(repo, 'close', 'evt_PRV_C', '--by', 'priya');
});

test('merging a thread stops its preview', () => {
  const repo = fresh({ previewPortStart: 4650 });
  openWithCommit(repo, 'evt_PRV_D');
  const port = portOf(ok(repo, 'preview', 'evt_PRV_D'));
  ok(repo, 'approve', 'evt_PRV_D', '--by', 'sam');
  ok(repo, 'approve', 'evt_PRV_D', '--by', 'lee');
  ok(repo, 'test', 'evt_PRV_D');
  ok(repo, 'merge', 'evt_PRV_D', '--by', 'lee');
  assert.notEqual(curl(`http://localhost:${port}`).status, 0, 'preview should stop on merge');
});

// ------------------------------------------------------------------ round-2 behaviours

test('approve is refused while the worktree has uncommitted changes', () => {
  const repo = fresh();
  const wt = openWithCommit(repo, 'evt_R2DIRT');
  fs.appendFileSync(path.join(wt, 'validate.js'), '\n// wip\n');
  assert.match(refused(repo, 'approve', 'evt_R2DIRT', '--by', 'sam'), /uncommitted/);
  assert.equal(state(repo).threads.evt_R2DIRT.approvals.length, 0);
});

test('tb test on a dirty tree is not recorded', () => {
  const repo = fresh();
  const wt = openWithCommit(repo, 'evt_R2TEST');
  fs.appendFileSync(path.join(wt, 'validate.js'), '\n// wip\n');
  assert.match(ok(repo, 'test', 'evt_R2TEST'), /not recorded/);
  assert.equal(state(repo).threads.evt_R2TEST.lastTest, null);
});

test('merge is refused when the worktree was checked out to another branch', () => {
  const repo = fresh();
  const wt = openWithCommit(repo, 'evt_R2CO');
  ok(repo, 'approve', 'evt_R2CO', '--by', 'sam');
  ok(repo, 'approve', 'evt_R2CO', '--by', 'lee');
  ok(repo, 'test', 'evt_R2CO');
  g(wt, 'checkout', '-q', '-b', 'elsewhere');
  assert.match(refused(repo, 'merge', 'evt_R2CO', '--by', 'lee'), /not on thread\//);
});

test('closing a merged thread is refused and revert still works', () => {
  const repo = fresh();
  openWithCommit(repo, 'evt_R2CLM');
  ok(repo, 'approve', 'evt_R2CLM', '--by', 'sam');
  ok(repo, 'approve', 'evt_R2CLM', '--by', 'lee');
  ok(repo, 'test', 'evt_R2CLM');
  ok(repo, 'merge', 'evt_R2CLM', '--by', 'lee');
  refused(repo, 'close', 'evt_R2CLM', '--by', 'sam');
  assert.equal(state(repo).threads.evt_R2CLM.status, 'merged');
  ok(repo, 'revert', 'evt_R2CLM', '--by', 'sam');
});

test('selfApproveCounts as the string "false" does not let the opener count', () => {
  const repo = fresh({ approvalsRequired: 1, selfApproveCounts: 'false' });
  const r = run(repo, 'board');
  if (r.code !== 0) { assert.equal(r.code, 2, r.out); return; } // fail-closed config error is fine
  openWithCommit(repo, 'evt_R2STR', 'priya');
  ok(repo, 'approve', 'evt_R2STR', '--by', 'priya');
  ok(repo, 'test', 'evt_R2STR');
  assert.match(ok(repo, 'check', 'evt_R2STR'), /has 0/);
});

test('zero-width and doubled @ variants of the opener still do not count', () => {
  const repo = fresh({ approvalsRequired: 1 });
  openWithCommit(repo, 'evt_R2ZW', 'priya');
  for (const who of ['pri\u200Bya', '@@priya', '\uFF50riya']) ok(repo, 'approve', 'evt_R2ZW', '--by', who);
  ok(repo, 'test', 'evt_R2ZW');
  assert.match(ok(repo, 'check', 'evt_R2ZW'), /has 0/);
});

test('a title with shell syntax is stored and merged literally', () => {
  const repo = fresh({ approvalsRequired: 1 });
  const title = 'Fix $(touch pwned) `id`; rm -rf x';
  openWithCommit(repo, 'evt_R2SH', 'priya', title);
  ok(repo, 'approve', 'evt_R2SH', '--by', 'sam');
  ok(repo, 'test', 'evt_R2SH');
  ok(repo, 'merge', 'evt_R2SH', '--by', 'sam');
  assert.ok(!fs.existsSync(path.join(repo, 'pwned')));
  assert.ok(g(repo, 'log', '-1', '--format=%s').includes('$(touch pwned)'));
});

test('a --by containing a newline is rejected (no forged trailers)', () => {
  const repo = fresh();
  openWithCommit(repo, 'evt_R2NL');
  refused(repo, 'approve', 'evt_R2NL', '--by', 'sam\nApproved-by: lee');
});

test('PR mode passes a chat title to gh as one literal argument, never through a shell', () => {
  const repo = fresh({ approvalsRequired: 1, mergeMode: 'pr' });
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-edge-remote-')));
  repos.push(bare);
  spawnSync('git', ['init', '-q', '--bare', bare]);
  g(repo, 'remote', 'add', 'origin', bare);
  g(repo, 'push', '-q', 'origin', 'main');
  const bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-edge-bin-')));
  repos.push(bin);
  const argvLog = path.join(bin, 'argv.jsonl');
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
require('fs').appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv[3] === 'create') console.log('https://github.com/acme/app/pull/7');
// Like GitHub: merging the PR moves the remote base to the approved commit.
if (process.argv[3] === 'merge') {
  const a = process.argv.slice(2);
  require('child_process').execFileSync('git', ['push', '-q', 'origin', a[a.indexOf('--match-head-commit') + 1] + ':refs/heads/main']);
}
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const tb = (...args) => {
    const r = spawnSync(process.execPath, [TB, ...args], { cwd: repo, encoding: 'utf8', env });
    const out = (r.stdout + r.stderr).trim();
    assert.equal(r.status, 0, out);
    return out;
  };
  const title = 'x $(touch PWNED) `touch PWNED2`; touch PWNED3';
  tb('open', '--thread', 'evt_R2PR', '--title', title, '--by', 'priya');
  const wt = tb('where', 'evt_R2PR');
  fs.appendFileSync(path.join(wt, 'validate.js'), '\n// pr\n');
  tb('commit', 'evt_R2PR', '-m', 'pr change', '--by', 'priya');
  tb('approve', 'evt_R2PR', '--by', 'sam');
  tb('test', 'evt_R2PR');
  const merged = tb('merge', 'evt_R2PR', '--by', 'sam');
  assert.match(merged, /pull\/7/);
  assert.match(merged, /local main updated from origin/);
  assert.equal(g(repo, 'rev-parse', 'main'), state(repo).threads.evt_R2PR.commits[0].sha, 'local main must follow the merged PR');
  // The next thread starts from what GitHub has, so it already contains the merged change.
  tb('open', '--thread', 'evt_R2PR2', '--title', 'next', '--by', 'lee');
  assert.match(fs.readFileSync(path.join(tb('where', 'evt_R2PR2'), 'validate.js'), 'utf8'), /\/\/ pr\n/);

  for (const dir of [repo, wt, bin]) for (const f of ['PWNED', 'PWNED2', 'PWNED3']) assert.ok(!fs.existsSync(path.join(dir, f)), `${f} created in ${dir}`);
  const calls = fs.readFileSync(argvLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const create = calls.find((a) => a[0] === 'pr' && a[1] === 'create');
  assert.ok(create, JSON.stringify(calls));
  assert.equal(create[create.indexOf('--title') + 1], title, 'title must arrive as exactly one argv element');
  const mergeCall = calls.find((a) => a[0] === 'pr' && a[1] === 'merge');
  const sha = state(repo).threads.evt_R2PR.commits[0].sha;
  assert.equal(mergeCall[mergeCall.indexOf('--match-head-commit') + 1], sha);
  assert.equal(g(bare, 'rev-parse', 'refs/heads/thread/' + state(repo).threads.evt_R2PR.key), sha);
  assert.equal(state(repo).threads.evt_R2PR.status, 'merged');
});

// ------------------------------------------------------------------ reviewer gaps

test('config fails closed on mistyped gate settings', () => {
  for (const bad of [{ approvalsRequired: '2' }, { selfApproveCounts: 'false' }, { mergeMode: 'yolo' }, { testCommand: '' }]) {
    const repo = fresh(); // open the thread under a valid config, then break it
    openWithCommit(repo, 'evt_CFG1');
    const file = path.join(repo, '.tb', 'config.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...bad }));
    const r = run(repo, 'check', 'evt_CFG1');
    assert.notEqual(r.code, 0, `${JSON.stringify(bad)} should make check fail, got: ${r.out}`);
    assert.notEqual(run(repo, 'merge', 'evt_CFG1', '--by', 'sam').code, 0, JSON.stringify(bad));
  }
});

test('a test command that only writes untracked artifacts still records its result', () => {
  const repo = fresh({ testCommand: 'true && mkdir -p coverage && echo x > coverage/out.txt' });
  const wt = openWithCommit(repo, 'evt_ARTIF');
  ok(repo, 'approve', 'evt_ARTIF', '--by', 'sam');
  ok(repo, 'approve', 'evt_ARTIF', '--by', 'lee');
  const out = ok(repo, 'test', 'evt_ARTIF');
  const t = state(repo).threads.evt_ARTIF;
  assert.ok(t.lastTest, `pass not recorded: ${out}`);
  assert.equal(t.lastTest.sha, g(wt, 'rev-parse', 'HEAD'));
  assert.equal(t.lastTest.ok, true);
  // The leftover artifact still makes the tree dirty, so the merge stays blocked on that alone.
  const c = ok(repo, 'check', 'evt_ARTIF');
  assert.match(c, /uncommitted changes/);
  assert.doesNotMatch(c, /tests have not passed/);
});

test('a test command that modifies a tracked file is not recorded', () => {
  const repo = fresh({ testCommand: 'echo "// touched" >> validate.js' });
  openWithCommit(repo, 'evt_TRACKM');
  assert.match(ok(repo, 'test', 'evt_TRACKM'), /not recorded/);
  assert.equal(state(repo).threads.evt_TRACKM.lastTest, null);
});

test('tb commit refuses when the worktree is checked out on another branch', () => {
  const repo = fresh();
  const wt = openWithCommit(repo, 'evt_COOTH');
  g(wt, 'checkout', '-q', '-b', 'elsewhere');
  fs.appendFileSync(path.join(wt, 'validate.js'), '\n// stray\n');
  assert.match(refused(repo, 'commit', 'evt_COOTH', '-m', 'x', '--by', 'priya'), /not on thread\//);
  assert.equal(g(wt, 'rev-parse', 'elsewhere'), state(repo).threads.evt_COOTH.commits[0].sha, 'nothing committed on the stray branch');
});

test('a failed PR-mode push is refused cleanly and audited as merge_failed', () => {
  const repo = fresh({ approvalsRequired: 1, mergeMode: 'pr' }); // no origin remote: push must fail
  openWithCommit(repo, 'evt_PRFAIL');
  ok(repo, 'approve', 'evt_PRFAIL', '--by', 'sam');
  ok(repo, 'test', 'evt_PRFAIL');
  refused(repo, 'merge', 'evt_PRFAIL', '--by', 'sam');
  assert.equal(state(repo).threads.evt_PRFAIL.status, 'open');
  assert.ok(audit(repo).some((e) => e.event === 'merge_failed' && e.thread === 'evt_PRFAIL'), 'merge_failed row missing');
});

test('a newline in a title cannot forge an Approved-by trailer in the merge commit', () => {
  const repo = fresh({ approvalsRequired: 1 });
  openWithCommit(repo, 'evt_TRAIL', 'priya', 'Harmless\n\nApproved-by: mallory');
  ok(repo, 'approve', 'evt_TRAIL', '--by', 'sam');
  ok(repo, 'test', 'evt_TRAIL');
  ok(repo, 'merge', 'evt_TRAIL', '--by', 'sam');
  const msg = g(repo, 'log', '-1', '--format=%B');
  const trailers = spawnSync('git', ['interpret-trailers', '--parse'], { cwd: repo, input: msg, encoding: 'utf8' }).stdout;
  assert.doesNotMatch(trailers, /mallory/i, trailers);
  assert.match(trailers, /Approved-by: sam/);
});
