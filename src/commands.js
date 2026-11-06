import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { git, repoRoot, run, sh, TbError } from './git.js';
import { Store } from './store.js';
import { alive, pickPort, startPreview, stop } from './preview.js';
import { AUTH_FAILED, UserStore, authenticate, login as authLogin, resolveSecret } from './auth/index.js';
import { readPassword } from './auth/prompt.js';

const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'thread';
const shortId = (id) => id.replace(/[^a-zA-Z0-9]/g, '').slice(-6).toLowerCase();

/**
 * Canonical form of a person's name: NFKC (fullwidth/compat forms fold to ASCII), invisible
 * format characters (zero-width space/joiner, BOM, bidi marks) removed, leading @s dropped,
 * whitespace collapsed, lowercased. Never throws, so it is safe on legacy state.
 */
const canon = (who) =>
  String(who ?? '').normalize('NFKC').replace(/\p{Cf}/gu, '').trim().replace(/^@+/, '').trim()
    .replace(/\s+/g, ' ').toLowerCase();

/** Canonical identity for a --by value; rejects empty, control characters, and absurd lengths. */
function norm(who) {
  const raw = String(who).normalize('NFKC').replace(/\p{Cf}/gu, '').trim();
  if (/\p{Cc}/u.test(raw)) throw new TbError('invalid --by: control characters are not allowed in a name');
  const s = canon(raw);
  if (!s) throw new TbError(`invalid --by "${who}": empty name`);
  if (s.length > 64) throw new TbError('invalid --by: name longer than 64 characters');
  return s;
}

/**
 * Thread ids come from the chat platform and can be anything printable. They are only ever used
 * as a JSON key and in commit trailers, never in paths or branch names, so the one thing to
 * reject is control characters (a newline would forge extra trailers).
 */
function threadId(value) {
  const id = need(value, 'thread');
  if (/[\p{Cc}\p{Cf}]/u.test(id)) throw new TbError('invalid --thread: control characters are not allowed');
  if (id.length > 1024) throw new TbError('invalid --thread: longer than 1024 characters');
  return id;
}
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Single-line, bounded title so it can't forge extra paragraphs/trailers in commit messages. */
const cleanTitle = (s) => s.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

function need(value, name) {
  if (value === undefined || value === true || String(value).trim() === '') throw new TbError(`missing --${name}`);
  return String(value);
}

function requireOpen(t) {
  if (t.status !== 'open') throw new TbError(`thread is ${t.status}`);
}

/** Message if the thread's worktree has been switched off its own branch, else ''. */
function offBranch(t) {
  const ref = git(t.worktree, ['symbolic-ref', '-q', 'HEAD'], { allowFail: true }).out;
  return ref === `refs/heads/${t.branch}` ? '' : `worktree is not on ${t.branch} (it is on ${ref || 'a detached HEAD'})`;
}

function requireOnBranch(t) {
  const wrong = offBranch(t);
  if (wrong) throw new TbError(wrong);
}

export function context(cwd) {
  const root = repoRoot(cwd);
  const store = new Store(root);
  if (!store.initialized) throw new TbError(`threadbranch is not set up in ${root}. Run: tb init`);
  return { root, store, config: store.config() };
}

/** Find a thread by Switch thread/message id, branch key, or branch name. */
function find(state, ref) {
  ref = need(ref, 'thread');
  if (Object.hasOwn(state.threads, ref)) return state.threads[ref];
  const all = Object.values(state.threads);
  const t = all.find((x) => x.key === ref || x.branch === ref);
  if (t) return t;
  const byShort = all.filter((x) => x.short === ref);
  if (byShort.length > 1) throw new TbError(`"${ref}" matches ${byShort.length} threads; use the thread id or key`);
  if (!byShort.length) throw new TbError(`no thread "${ref}". Run: tb board`);
  return byShort[0];
}

const head = (t) => git(t.worktree, ['rev-parse', 'HEAD']);

function quorum(t, config, sha) {
  const opener = canon(t.openedBy);
  const valid = t.approvals.filter((a) => a.sha === sha && (config.selfApproveCounts === true || canon(a.by) !== opener));
  const people = [...new Set(valid.map((a) => canon(a.by)))].filter(Boolean);
  return { people, have: people.length, need: config.approvalsRequired, met: people.length >= config.approvalsRequired };
}

function exclude(root) {
  const file = path.join(root, '.git', 'info', 'exclude');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const missing = ['.tb/', 'node_modules'].filter((l) => !text.split('\n').includes(l));
  if (missing.length) fs.appendFileSync(file, `${text.endsWith('\n') || !text ? '' : '\n'}${missing.join('\n')}\n`);
}

// ---------------------------------------------------------------- commands

export function init(cwd, flags) {
  const root = repoRoot(cwd);
  const store = new Store(root);
  const overrides = {};
  if (flags.base) overrides.base = String(flags.base);
  else overrides.base = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (flags.approvals !== undefined) {
    const n = Number(flags.approvals);
    if (!Number.isInteger(n) || n < 1) throw new TbError('--approvals must be a whole number of at least 1');
    overrides.approvalsRequired = n;
  }
  if (flags['no-tests']) overrides.testCommand = null;
  if (flags['no-preview']) overrides.previewCommand = null;
  if (flags.tunnel) overrides.previewTunnel = String(flags.tunnel);
  if (flags.pr) overrides.mergeMode = 'pr';
  store.init(overrides);
  exclude(root);
  return `threadbranch ready in ${root}\nconfig: ${store.configPath}\n${JSON.stringify(store.config(), null, 2)}`;
}

export function open(cwd, flags) {
  const { root, store, config } = context(cwd);
  const thread = threadId(flags.thread);
  const title = cleanTitle(need(flags.title, 'title'));
  if (!title) throw new TbError('missing --title');
  const by = norm(need(flags.by, 'by'));
  const state = store.load();
  if (Object.hasOwn(state.threads, thread)) {
    const existing = state.threads[thread];
    if (existing.status === 'open') return `already open: ${existing.branch}\nworktree: ${existing.worktree}`;
    throw new TbError(`thread is ${existing.status} (${existing.branch}); start a new top-level thread for new work`);
  }

  const short = shortId(thread) || hash(thread).slice(0, 6);
  const slug = slugify(title);
  // Keys must be unique: two threads can share a title and an id tail (Slack ts ...123456).
  const taken = (k) => Object.values(state.threads).some((x) => x.key === k) ||
    fs.existsSync(path.join(store.worktreesDir, k)) ||
    git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/thread/${k}`], { allowFail: true }).ok;
  let key = `${slug}-${short}`;
  for (let i = 0; taken(key); i++) {
    if (i >= 20) throw new TbError(`could not find a free branch name for ${slug}`);
    key = `${slug}-${hash(`${thread}#${i}`).slice(0, 6)}-${short}`;
  }
  const branch = `thread/${key}`;
  const worktree = path.join(store.worktreesDir, key);
  git(root, ['worktree', 'add', '-b', branch, worktree, config.base]);
  // Share installed dependencies so previews and tests run without a fresh install.
  const nm = path.join(root, 'node_modules');
  if (fs.existsSync(nm) && !fs.existsSync(path.join(worktree, 'node_modules'))) fs.symlinkSync(nm, path.join(worktree, 'node_modules'));
  const t = {
    thread, key, short, branch, worktree, title,
    openedBy: by, openedAt: new Date().toISOString(),
    status: 'open', approvals: [], commits: [], lastTest: null, preview: null,
    baseSha: git(root, ['rev-parse', config.base]),
  };
  store.update((s) => { s.threads[thread] = t; });
  store.audit('open', { thread, branch, by: t.openedBy, title });
  return `opened ${branch}\nworktree: ${worktree}\nWork ONLY inside that directory for this thread.`;
}

export function where(cwd, flags, args) {
  const { store } = context(cwd);
  return find(store.load(), flags.thread ?? args[0]).worktree;
}

export function commit(cwd, flags, args) {
  const { store } = context(cwd);
  const t = find(store.load(), flags.thread ?? args[0]);
  requireOpen(t);
  requireOnBranch(t);
  const msg = need(flags.m ?? flags.message, 'm');
  const by = norm(need(flags.by, 'by'));
  git(t.worktree, ['add', '-A']);
  const staged = git(t.worktree, ['diff', '--cached', '--name-only']);
  if (!staged) return 'nothing to commit';
  git(t.worktree, ['commit', '-q', '-m', `${msg}\n\nRequested-by: ${by}\nThread: ${t.thread}`]);
  const sha = head(t);
  const stale = t.approvals.length > 0;
  store.update((s) => {
    const x = s.threads[t.thread];
    x.commits.push({ sha, msg, by, at: new Date().toISOString() });
  });
  store.audit('commit', { thread: t.thread, sha, by, msg });
  return `committed ${sha.slice(0, 7)} on ${t.branch}: ${msg}\nfiles: ${staged.split('\n').join(', ')}` +
    (stale ? '\nnote: earlier approvals were for an older commit and no longer count.' : '');
}

export function diff(cwd, flags, args) {
  const { store, config } = context(cwd);
  const t = find(store.load(), flags.thread ?? args[0]);
  const stat = git(t.worktree, ['diff', '--stat', `${config.base}...HEAD`]);
  const full = git(t.worktree, ['diff', `${config.base}...HEAD`]);
  const max = Number(flags.max ?? 3000);
  const body = full.length > max ? `${full.slice(0, max)}\n… (${full.length - max} more chars, see branch ${t.branch})` : full;
  return stat ? `${stat}\n\n${body}` : 'no changes yet';
}

export function test(cwd, flags, args) {
  const { store, config } = context(cwd);
  const t = find(store.load(), flags.thread ?? args[0]);
  requireOpen(t);
  if (!config.testCommand) return 'no test command configured; test gate is off';
  const sha = head(t);
  // A pass on uncommitted changes says nothing about the commit, so only a clean tree is recorded.
  const dirty = Boolean(git(t.worktree, ['status', '--porcelain']));
  const r = sh(t.worktree, config.testCommand);
  // The test command must not change tracked files either, or the result isn't about `sha`.
  // Untracked output (coverage/, junit.xml) is fine here; the merge's dirty-tree blocker still sees it.
  const changed = !dirty && (head(t) !== sha || Boolean(git(t.worktree, ['status', '--porcelain', '--untracked-files=no'])));
  const recorded = !dirty && !changed;
  if (recorded) store.update((s) => { s.threads[t.thread].lastTest = { sha, ok: r.ok, at: new Date().toISOString() }; });
  store.audit('test', { thread: t.thread, sha, ok: r.ok, recorded });
  const tail = r.out.trim().split('\n').slice(-25).join('\n');
  const note = dirty ? '\nnote: ran on uncommitted changes, so this result was not recorded. Run tb commit, then tb test again.'
    : changed ? '\nnote: the test command changed the worktree, so this result was not recorded.' : '';
  return `${r.ok ? 'PASS' : 'FAIL'} ${config.testCommand} @ ${sha.slice(0, 7)}${dirty ? ' + uncommitted changes' : ''}\n${tail}${note}`;
}

export function preview(cwd, flags, args) {
  const { store, config } = context(cwd);
  const state = store.load();
  const t = find(state, flags.thread ?? args[0]);
  requireOpen(t);
  if (!config.previewCommand) return 'previews are off (previewCommand is null)';
  if (t.preview) { stop(t.preview.pid); stop(t.preview.tunnelPid); }
  const taken = new Set(Object.values(state.threads).filter((x) => x.preview && alive(x.preview.pid) && x !== t).map((x) => x.preview.port));
  const port = t.preview?.port && !taken.has(t.preview.port) ? t.preview.port : pickPort(config.previewPortStart, taken);
  const p = startPreview({ cwd: t.worktree, command: config.previewCommand, port, tunnel: config.previewTunnel, logsDir: store.logsDir, key: t.key });
  store.update((s) => { s.threads[t.thread].preview = { port, pid: p.pid, tunnelPid: p.tunnelPid, url: p.url, sha: head(t) }; });
  store.audit('preview', { thread: t.thread, url: p.url, ready: p.ready });
  if (!p.ready) {
    const log = fs.readFileSync(p.logFile, 'utf8').trim().split('\n').slice(-20).join('\n');
    return `preview did not come up on port ${port}. Last log lines:\n${log}`;
  }
  return `preview: ${p.url}${p.url !== p.localUrl ? `  (local ${p.localUrl})` : ''}`;
}

export function approve(cwd, flags, args) {
  const { store, config } = context(cwd);
  const t = find(store.load(), flags.thread ?? args[0]);
  requireOpen(t);
  const by = norm(need(flags.by, 'by'));
  // Reviewers look at the preview/worktree; if that includes uncommitted code, HEAD isn't what they saw.
  if (git(t.worktree, ['status', '--porcelain'])) throw new TbError('the worktree has uncommitted changes; run tb commit first so the approval is for exactly what was reviewed');
  const sha = head(t);
  store.update((s) => {
    const x = s.threads[t.thread];
    x.approvals = x.approvals.filter((a) => canon(a.by) !== by);
    x.approvals.push({ by, sha, at: new Date().toISOString() });
  });
  store.audit('approve', { thread: t.thread, by, sha });
  const q = quorum(find(store.load(), t.thread), config, sha);
  const selfNote = config.selfApproveCounts !== true && by === canon(t.openedBy) ? ' (you opened this thread, so your approval does not count toward the quorum)' : '';
  return `approval from ${by} recorded for ${sha.slice(0, 7)}${selfNote}\nquorum: ${q.have}/${q.need}${q.people.length ? ` (${q.people.join(', ')})` : ''}${q.met ? ' — ready to merge' : ''}`;
}

export function unapprove(cwd, flags, args) {
  const { store } = context(cwd);
  const t = find(store.load(), flags.thread ?? args[0]);
  const by = norm(need(flags.by, 'by'));
  const had = t.approvals.some((a) => canon(a.by) === by);
  store.update((s) => { s.threads[t.thread].approvals = s.threads[t.thread].approvals.filter((a) => canon(a.by) !== by); });
  store.audit('unapprove', { thread: t.thread, by, had });
  return had ? `approval from ${by} withdrawn` : `${by} had no approval to withdraw`;
}

/**
 * Explain everything that blocks a merge right now; empty `out` means clear. Returns the sha it
 * checked so the caller merges that exact commit, not a HEAD re-read later.
 */
function blockers(t, config, root) {
  const out = [];
  if (t.status !== 'open') return { out: [`thread is ${t.status}`], sha: null };
  const sha = head(t);
  // Approvals and tests are keyed to the worktree HEAD; the merge must land exactly that commit.
  const wrong = offBranch(t);
  if (wrong) out.push(wrong);
  if (git(t.worktree, ['status', '--porcelain'])) out.push('uncommitted changes in the worktree (run tb commit)');
  if (!t.commits.length && git(t.worktree, ['rev-list', '--count', `${config.base}..HEAD`]) === '0') out.push('no commits on this thread yet');
  const q = quorum(t, config, sha);
  if (!q.met) out.push(`needs ${q.need} approvals on ${sha.slice(0, 7)}, has ${q.have}${q.people.length ? ` (${q.people.join(', ')})` : ''}`);
  if (config.testCommand && !(t.lastTest && t.lastTest.sha === sha && t.lastTest.ok)) out.push(`tests have not passed on ${sha.slice(0, 7)} (run tb test)`);
  if (config.mergeMode !== 'pr') {
    const current = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (current !== config.base) out.push(`main checkout is on ${current}, expected ${config.base}`);
    if (git(root, ['status', '--porcelain'])) out.push(`main checkout ${root} has uncommitted changes`);
  }
  return { out, sha };
}

export function check(cwd, flags, args) {
  const { root, store, config } = context(cwd);
  const t = find(store.load(), flags.thread ?? args[0]);
  const { out: b } = blockers(t, config, root);
  return b.length ? `blocked:\n- ${b.join('\n- ')}` : 'clear to merge';
}

export function merge(cwd, flags, args) {
  const { root, store, config } = context(cwd);
  const t = find(store.load(), flags.thread ?? args[0]);
  const by = norm(need(flags.by, 'by'));
  const { out: b, sha } = blockers(t, config, root);
  const refuse = (reasons) => {
    store.audit('merge_refused', { thread: t.thread, by, blockers: reasons });
    return new TbError(`merge refused:\n- ${reasons.join('\n- ')}`);
  };
  if (b.length) throw refuse(b);
  // Exactly the commit blockers() checked; never "whatever the branch points at now".
  const approvers = quorum(t, config, sha).people;
  let result;
  if (config.mergeMode === 'pr') {
    const fail = (msg) => {
      store.audit('merge_failed', { thread: t.thread, by, sha, error: msg });
      return new TbError(msg);
    };
    const push = git(t.worktree, ['push', 'origin', `${sha}:refs/heads/${t.branch}`], { allowFail: true });
    if (!push.ok) throw fail(`git push of ${t.branch} failed:\n${push.err || push.out}`);
    const body = `Opened from a team chat thread by threadbranch.\n\nRequested by: ${t.openedBy}\nApproved by: ${approvers.join(', ')}\nTests: passed on ${sha.slice(0, 7)}`;
    // Argument vectors, not a shell string: titles come from chat and must never be interpreted.
    const pr = run(t.worktree, 'gh', ['pr', 'create', '--base', config.base, '--head', t.branch, '--title', t.title, '--body', body]);
    if (!pr.ok) throw fail(`gh pr create failed:\n${pr.out}`);
    const url = pr.out.trim().split('\n').pop();
    // --match-head-commit: refuse if anyone pushed to the branch after approval.
    const m = run(t.worktree, 'gh', ['pr', 'merge', url, '--merge', '--delete-branch=false', '--match-head-commit', sha]);
    if (!m.ok) throw fail(`PR opened at ${url} but gh pr merge failed:\n${m.out}`);
    result = { prUrl: url, mergeSha: null };
  } else {
    const r = git(root, ['merge', '--no-ff', '-m', `Merge thread: ${cleanTitle(t.title)}\n\nRequested-by: ${t.openedBy}\nApproved-by: ${approvers.join(', ')}\nMerged-by: ${by}\nThread: ${t.thread}`, sha], { allowFail: true });
    if (!r.ok) {
      const conflicts = git(root, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true }).out;
      git(root, ['merge', '--abort'], { allowFail: true });
      throw refuse([`merge conflicts with ${config.base}${conflicts ? ` in: ${conflicts.split('\n').join(', ')}` : ''}. Run: tb sync ${t.key}, resolve, commit, test, and get fresh approvals.`]);
    }
    result = { prUrl: null, mergeSha: git(root, ['rev-parse', 'HEAD']) };
  }
  if (t.preview) { stop(t.preview.pid); stop(t.preview.tunnelPid); }
  git(root, ['worktree', 'remove', '--force', t.worktree], { allowFail: true });
  store.update((s) => Object.assign(s.threads[t.thread], { status: 'merged', mergedBy: by, mergedAt: new Date().toISOString(), preview: null, ...result }));
  store.audit('merge', { thread: t.thread, by, approvers, sha, ...result });
  return result.prUrl
    ? `merged via PR ${result.prUrl}\napproved by ${approvers.join(', ')}`
    : `merged ${t.branch} into ${config.base} as ${result.mergeSha.slice(0, 7)}\napproved by ${approvers.join(', ')}\nundo with: tb revert ${t.key}`;
}

export function sync(cwd, flags, args) {
  const { store, config } = context(cwd);
  const t = find(store.load(), flags.thread ?? args[0]);
  requireOpen(t);
  const r = git(t.worktree, ['merge', '--no-edit', config.base], { allowFail: true });
  if (r.ok) {
    store.audit('sync', { thread: t.thread, ok: true });
    return `brought ${config.base} into ${t.branch}\n${r.out}`;
  }
  const conflicts = git(t.worktree, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true }).out;
  store.audit('sync', { thread: t.thread, ok: false, conflicts });
  return `conflicts to resolve in ${t.worktree}:\n${conflicts}\nEdit the files, then tb commit.`;
}

export function revert(cwd, flags, args) {
  const { root, store, config } = context(cwd);
  const t = find(store.load(), flags.thread ?? args[0]);
  const by = norm(need(flags.by, 'by'));
  if (t.status !== 'merged') throw new TbError(`thread is ${t.status}; only merged threads can be reverted`);
  if (!t.mergeSha) throw new TbError(`merged through a PR (${t.prUrl}); revert it on GitHub`);
  const current = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current !== config.base) throw new TbError(`main checkout is on ${current}, expected ${config.base}; refusing to revert`);
  if (git(root, ['status', '--porcelain'])) throw new TbError('main checkout has uncommitted changes; refusing to revert');
  const rv = git(root, ['revert', '-m', '1', '--no-edit', t.mergeSha], { allowFail: true });
  if (!rv.ok) {
    git(root, ['revert', '--abort'], { allowFail: true });
    store.audit('revert_failed', { thread: t.thread, by, error: rv.err || rv.out });
    throw new TbError(`revert of ${t.mergeSha.slice(0, 7)} did not apply cleanly; nothing changed:\n${rv.err || rv.out}`);
  }
  const sha = git(root, ['rev-parse', 'HEAD']);
  store.update((s) => Object.assign(s.threads[t.thread], { status: 'reverted', revertedBy: by, revertSha: sha }));
  store.audit('revert', { thread: t.thread, by, sha });
  return `reverted ${t.title} on ${config.base} as ${sha.slice(0, 7)}`;
}

export function close(cwd, flags, args) {
  const { root, store } = context(cwd);
  const t = find(store.load(), flags.thread ?? args[0]);
  const by = norm(need(flags.by, 'by'));
  // A merged or reverted thread must keep that status (revert depends on it).
  requireOpen(t);
  if (t.preview) { stop(t.preview.pid); stop(t.preview.tunnelPid); }
  git(root, ['worktree', 'remove', '--force', t.worktree], { allowFail: true });
  store.update((s) => Object.assign(s.threads[t.thread], { status: 'closed', closedBy: by, preview: null }));
  store.audit('close', { thread: t.thread, by });
  return `closed ${t.branch} (branch kept)`;
}

export function board(cwd) {
  const { store, config } = context(cwd);
  const threads = Object.values(store.load().threads);
  if (!threads.length) return 'no threads yet';
  const icon = { open: '🟡', merged: '🟢', closed: '⚪', reverted: '⏪' };
  const lines = threads
    .sort((a, b) => (a.status === 'open' ? -1 : 1) - (b.status === 'open' ? -1 : 1) || b.openedAt.localeCompare(a.openedAt))
    .map((t) => {
      let extra = '';
      if (t.status === 'open') {
        const sha = head(t);
        const q = quorum(t, config, sha);
        const tests = !config.testCommand ? '' : t.lastTest?.sha === sha ? (t.lastTest.ok ? ' · tests ✅' : ' · tests ❌') : ' · tests –';
        const live = t.preview && alive(t.preview.pid) ? ` · ${t.preview.url}` : '';
        extra = ` · ${t.commits.length} commit(s) · approvals ${q.have}/${q.need}${tests}${live}`;
      } else if (t.prUrl) extra = ` · ${t.prUrl}`;
      return `${icon[t.status] || '•'} ${t.title} — \`${t.key}\` · ${t.status} · by ${t.openedBy}${extra}`;
    });
  return lines.join('\n');
}

export function log(cwd, flags, args) {
  const { store } = context(cwd);
  const ref = flags.thread ?? args[0];
  let rows = store.readAudit();
  if (ref) {
    const t = find(store.load(), ref);
    rows = rows.filter((r) => r.thread === t.thread);
  }
  return rows.slice(-Number(flags.n ?? 30)).map((r) => {
    const { at, event, thread, ...rest } = r;
    return `${at} ${event} ${Object.entries(rest).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : v}`).join(' ')}`;
  }).join('\n') || 'no audit entries';
}

// ---- auth: tb user add|rm, tb login, tb logout, tb whoami ----

/**
 * Auth state lives in the repository's git dir (shared by every worktree, never in the working
 * tree, never committed): users.json (hashes + login throttle) and token (this checkout's session).
 */
function authPaths(cwd) {
  const gitDir = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const dir = path.join(gitDir, 'tb-auth');
  return { dir, usersPath: path.join(dir, 'users.json'), tokenPath: path.join(dir, 'token') };
}

function authOpts(cwd) {
  const { usersPath } = authPaths(cwd);
  return { store: new UserStore(usersPath), env: process.env };
}

// A password on the command line lands in shell history and `ps`; refuse it outright. These commands
// take no flags at all, so any flag is refused, whatever it is spelled (--password=x, --pass x, -p x).
function noPasswordArgs(flags, extra) {
  const keys = Object.keys(flags);
  if (extra.length || keys.some((k) => /^(p|pw|pass|passw(or)?d)(=|$)/i.test(k))) {
    throw new TbError('passwords are never taken as arguments; type it at the prompt or pipe it on stdin');
  }
  if (keys.length) throw new TbError(`unknown flag --${keys[0].split('=')[0]} (this command takes none)`);
}

function readToken(tokenPath) {
  try {
    return fs.readFileSync(tokenPath, 'utf8').trim();
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new TbError(`${tokenPath}: ${e.message}`);
  }
}

function writeToken(dir, tokenPath, token) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${tokenPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, token + '\n', { mode: 0o600 });
  fs.renameSync(tmp, tokenPath);
}

const until = (claims) => new Date(claims.exp * 1000).toISOString();

export async function user(cwd, flags, args) {
  const [sub, name, ...extra] = args;
  const usage = 'usage: tb user add <name> | tb user rm <name> | tb user unlock <name>';
  if (!['add', 'rm', 'unlock'].includes(sub) || !name) throw new TbError(usage);
  const { store } = authOpts(cwd);
  if (sub === 'add') {
    noPasswordArgs(flags, extra);
    const created = await store.createUser(name, await readPassword(`Password for ${name}: `, { confirm: true }));
    return `created user "${created}"`;
  }
  if (extra.length || Object.keys(flags).length) throw new TbError(usage);
  if (sub === 'unlock') return `cleared failed logins and any lockout for "${await store.unlockUser(name)}"`;
  const removed = await store.deleteUser(name);
  // Deleting the user already invalidates their tokens; also drop this checkout's copy if it was theirs.
  const { tokenPath } = authPaths(cwd);
  const token = readToken(tokenPath);
  if (token) {
    try {
      const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
      if (claims.sub === removed) fs.rmSync(tokenPath, { force: true });
    } catch {}
  }
  return `removed user "${removed}"; their tokens no longer work`;
}

export async function login(cwd, flags, args) {
  const [name, ...extra] = args;
  if (!name) throw new TbError('usage: tb login <name>');
  noPasswordArgs(flags, extra);
  const opts = authOpts(cwd);
  // Fail on a missing or short secret before asking for a password.
  resolveSecret(opts);
  const { dir, tokenPath } = authPaths(cwd);
  const token = await authLogin(name, await readPassword(`Password for ${name}: `), opts);
  writeToken(dir, tokenPath, token);
  const claims = authenticate(token, opts);
  return `logged in as ${claims.sub} until ${until(claims)}`;
}

export async function logout(cwd) {
  const opts = authOpts(cwd);
  const { tokenPath } = authPaths(cwd);
  const token = readToken(tokenPath);
  if (!token) return 'not logged in';
  try {
    resolveSecret(opts);
  } catch (e) {
    // Without a usable secret the token cannot be verified or revoked; still let the user drop it.
    fs.rmSync(tokenPath, { force: true });
    throw new TbError(`removed the local token, but could not revoke it: ${e.message}`);
  }
  let claims;
  try {
    claims = authenticate(token, opts);
  } catch (e) {
    if (!(e instanceof TbError) || e.message !== AUTH_FAILED) throw e;
  }
  if (claims) await opts.store.revokeTokens(claims.sub);
  fs.rmSync(tokenPath, { force: true });
  return claims
    ? `logged out ${claims.sub}; every token issued to ${claims.sub} is revoked`
    : 'removed a token that was already invalid, expired or revoked';
}

export function whoami(cwd) {
  const opts = authOpts(cwd);
  const token = readToken(authPaths(cwd).tokenPath);
  if (!token) throw new TbError('not logged in. Run: tb login <name>');
  const claims = authenticate(token, opts);
  return `${claims.sub} (token valid until ${until(claims)})`;
}
