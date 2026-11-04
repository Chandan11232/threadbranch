import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';

export class TbError extends Error {}

/** Run git and return trimmed stdout; throws TbError with git's stderr on failure. */
export function git(cwd, args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) {
    throw new TbError(`git ${args.join(' ')} failed:\n${(r.stderr || r.stdout).trim()}`);
  }
  return allowFail ? { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() } : r.stdout.trim();
}

/** The main checkout of the repository containing cwd, even when cwd is inside a worktree. */
export function repoRoot(cwd) {
  const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return path.dirname(common);
}

export function sh(cwd, command, env = {}) {
  // A test runner's context variable would make a nested `node --test` report upward instead of exiting non-zero.
  const { NODE_TEST_CONTEXT, ...base } = process.env;
  try {
    const out = execFileSync('sh', ['-c', command], {
      cwd,
      encoding: 'utf8',
      env: { ...base, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 20 * 1024 * 1024,
    });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}
