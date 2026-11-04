import fs from 'node:fs';
import path from 'node:path';
import { git, repoRoot, sh, TbError } from './git.js';
import { Store } from './store.js';
import { alive, pickPort, startPreview, stop } from './preview.js';

const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'thread';
const shortId = (id) => id.replace(/[^a-zA-Z0-9]/g, '').slice(-6).toLowerCase();
const norm = (who) => String(who).trim().replace(/^@/, '').toLowerCase();

function need(value, name) {
  if (value === undefined || value === true || value === '') throw new TbError(`missing --${name}`);
  return String(value);
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
  if (state.threads[ref]) return state.threads[ref];
  const t = Object.values(state.threads).find((x) => x.key === ref || x.branch === ref || x.short === ref);
  if (!t) throw new TbError(`no thread "${ref}". Run: tb board`);
  return t;
}

const head = (t) => git(t.worktree, ['rev-parse', 'HEAD']);

function quorum(t, config, sha) {
  const valid = t.approvals.filter((a) => a.sha === sha && (config.selfApproveCounts || a.by !== norm(t.openedBy)));
  const people = [...new Set(valid.map((a) => a.by))];
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
  if (flags.approvals) overrides.approvalsRequired = Number(flags.approvals);
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
  const thread = need(flags.thread, 'thread');
  const title = need(flags.title, 'title');
  const by = need(flags.by, 'by');
  const existing = store.load().threads[thread];
  if (existing) return `already open: ${existing.branch}\nworktree: ${existing.worktree}`;

  const short = shortId(thread);
  const key = `${slugify(title)}-${short}`;
  const branch = `thread/${key}`;
  const worktree = path.join(store.worktreesDir, key);
  git(root, ['worktree', 'add', '-b', branch, worktree, config.base]);
  // Share installed dependencies so previews and tests run without a fresh install.
  const nm = path.join(root, 'node_modules');
  if (fs.existsSync(nm) && !fs.existsSync(path.join(worktree, 'node_modules'))) fs.symlinkSync(nm, path.join(worktree, 'node_modules'));
  const t = {
    thread, key, short, branch, worktree, title,
    openedBy: norm(by), openedAt: new Date().toISOString(),
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
  if (!config.testCommand) return 'no test command configured; test gate is off';
  const sha = head(t);
  const r = sh(t.worktree, config.testCommand);
  store.update((s) => { s.threads[t.thread].lastTest = { sha, ok: r.ok, at: new Date().toISOString() }; });
  store.audit('test', { thread: t.thread, sha, ok: r.ok });
  const tail = r.out.trim().split('\n').slice(-25).join('\n');
  return `${r.ok ? 'PASS' : 'FAIL'} ${config.testCommand} @ ${sha.slice(0, 7)}\n${tail}`;
}

export function preview(cwd, flags, args) {
  const { store, config } = context(cwd);
  const state = store.load();
  const t = find(state, flags.thread ?? args[0]);
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
  if (t.status !== 'open') throw new TbError(`thread is ${t.status}`);
  const by = norm(need(flags.by, 'by'));
  const sha = head(t);
  store.update((s) => {
    const x = s.threads[t.thread];
    x.approvals = x.approvals.filter((a) => a.by !== by);
    x.approvals.push({ by, sha, at: new Date().toISOString() });
  });
  store.audit('approve', { thread: t.thread, by, sha });
  const q = quorum(find(store.load(), t.thread), config, sha);
  const selfNote = !config.selfApproveCounts && by === norm(t.openedBy) ? ' (you opened this thread, so your approval does not count toward the quorum)' : '';
  return `approval from ${by} recorded for ${sha.slice(0, 7)}${selfNote}\nquorum: ${q.have}/${q.need}${q.people.length ? ` (${q.people.join(', ')})` : ''}${q.met ? ' — ready to merge' : ''}`;
}

export function unapprove(cwd, flags, args) {
  const { store } = context(cwd);
  const t = find(store.load(), flags.thread ?? args[0]);
  const by = norm(need(flags.by, 'by'));
  store.update((s) => { s.threads[t.thread].approvals = s.threads[t.thread].approvals.filter((a) => a.by !== by); });
  store.audit('unapprove', { thread: t.thread, by });
  return `approval from ${by} withdrawn`;
}

/** Explain everything that blocks a merge right now; empty list means clear. */
function blockers(t, config) {
  const out = [];
  if (t.status !== 'open') out.push(`thread is ${t.status}`);
  const sha = head(t);
  if (git(t.worktree, ['status', '--porcelain'])) out.push('uncommitted changes in the worktree (run tb commit)');
  if (!t.commits.length && git(t.worktree, ['rev-list', '--count', `${config.base}..HEAD`]) === '0') out.push('no commits on this thread yet');
  const q = quorum(t, config, sha);
  if (!q.met) out.push(`needs ${q.need} approvals on ${sha.slice(0, 7)}, has ${q.have}${q.people.length ? ` (${q.people.join(', ')})` : ''}`);
  if (config.testCommand && !(t.lastTest && t.lastTest.sha === sha && t.lastTest.ok)) out.push(`tests have not passed on ${sha.slice(0, 7)} (run tb test)`);
  return out;
}

export function check(cwd, flags, args) {
  const { store, config } = context(cwd);
  const t = find(store.load(), flags.thread ?? args[0]);
  const b = blockers(t, config);
  return b.length ? `blocked:\n- ${b.join('\n- ')}` : 'clear to merge';
}

export function merge(cwd, flags, args) {
  const { root, store, config } = context(cwd);
  const t = find(store.load(), flags.thread ?? args[0]);
  const by = norm(need(flags.by, 'by'));
  const b = blockers(t, config);
  if (b.length) {
    store.audit('merge_refused', { thread: t.thread, by, blockers: b });
    throw new TbError(`merge refused:\n- ${b.join('\n- ')}`);
  }
  const sha = head(t);
  const approvers = quorum(t, config, sha).people;
  let result;
  if (config.mergeMode === 'pr') {
    git(t.worktree, ['push', '-u', 'origin', t.branch]);
    const body = `Opened from a team chat thread by threadbranch.\n\nRequested by: ${t.openedBy}\nApproved by: ${approvers.join(', ')}\nTests: passed on ${sha.slice(0, 7)}`;
    const pr = sh(t.worktree, `gh pr create --base ${config.base} --head ${t.branch} --title ${JSON.stringify(t.title)} --body ${JSON.stringify(body)}`);
    if (!pr.ok) throw new TbError(`gh pr create failed:\n${pr.out}`);
    const url = pr.out.trim().split('\n').pop();
    const m = sh(t.worktree, `gh pr merge ${url} --merge --delete-branch=false`);
    if (!m.ok) throw new TbError(`PR opened at ${url} but gh pr merge failed:\n${m.out}`);
    result = { prUrl: url, mergeSha: null };
  } else {
    const current = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (current !== config.base) throw new TbError(`main checkout is on ${current}, expected ${config.base}`);
    if (git(root, ['status', '--porcelain'])) throw new TbError(`main checkout ${root} has uncommitted changes; refusing to merge`);
    const r = git(root, ['merge', '--no-ff', '-m', `Merge thread: ${t.title}\n\nRequested-by: ${t.openedBy}\nApproved-by: ${approvers.join(', ')}\nMerged-by: ${by}\nThread: ${t.thread}`, t.branch], { allowFail: true });
    if (!r.ok) {
      const conflicts = git(root, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true }).out;
      git(root, ['merge', '--abort'], { allowFail: true });
      throw new TbError(`merge conflicts with ${config.base}${conflicts ? ` in: ${conflicts.split('\n').join(', ')}` : ''}\nRun: tb sync ${t.key}, resolve, commit, test, and get fresh approvals.`);
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
  if (git(root, ['status', '--porcelain'])) throw new TbError('main checkout has uncommitted changes; refusing to revert');
  git(root, ['revert', '-m', '1', '--no-edit', t.mergeSha]);
  const sha = git(root, ['rev-parse', 'HEAD']);
  store.update((s) => Object.assign(s.threads[t.thread], { status: 'reverted', revertedBy: by, revertSha: sha }));
  store.audit('revert', { thread: t.thread, by, sha });
  return `reverted ${t.title} on ${config.base} as ${sha.slice(0, 7)}`;
}

export function close(cwd, flags, args) {
  const { root, store } = context(cwd);
  const t = find(store.load(), flags.thread ?? args[0]);
  const by = norm(need(flags.by, 'by'));
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
