import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TbError } from '../git.js';

export const LOCK_DEFAULTS = {
  // Give up waiting for the lock after this long.
  timeoutMs: 10_000,
  // A lock older than this is presumed abandoned even if its pid looks alive (pid reuse, hung holder).
  // Held sections only read and write a small JSON file, so this is far above a legitimate hold.
  staleMs: 30_000,
  minDelayMs: 5,
  maxDelayMs: 200,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return e.code === 'EPERM';
  }
}

function readLock(lockPath) {
  try {
    return fs.readFileSync(lockPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new TbError(`${lockPath}: cannot read lock: ${e.message}`);
  }
}

function isStale(text, staleMs, now) {
  let info;
  try {
    info = JSON.parse(text);
  } catch {
    // A holder may be between creating the file and writing it; judge an unreadable lock by age only.
    return null;
  }
  if (!info || typeof info !== 'object') return null;
  if (typeof info.at !== 'number' || now - info.at > staleMs) return true;
  // The pid only means something on the host that wrote it.
  return info.host === os.hostname() && !pidAlive(info.pid);
}

function mtimeAge(lockPath, now) {
  try {
    return now - fs.statSync(lockPath).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Remove a stale lock whose content was `seen`. Renames it aside first and checks the content, so a
 * lock another process created after we looked is put back instead of being deleted.
 */
function breakLock(lockPath, seen) {
  const aside = `${lockPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.stale`;
  try {
    fs.renameSync(lockPath, aside);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  if (fs.readFileSync(aside, 'utf8') !== seen) {
    // Not the lock we judged stale: restore it (fails only if yet another holder appeared meanwhile).
    try {
      fs.linkSync(aside, lockPath);
    } catch {}
  }
  fs.rmSync(aside, { force: true });
}

/**
 * Run fn while holding an exclusive cross-process lock on filePath (an O_EXCL lockfile beside it).
 * Waits with jittered exponential backoff up to timeoutMs; breaks locks whose holder is dead or
 * that are older than staleMs; always releases in finally. Returns fn's result.
 */
export async function withLock(filePath, fn, opts = {}) {
  const { timeoutMs, staleMs, minDelayMs, maxDelayMs } = { ...LOCK_DEFAULTS, ...opts };
  const lockPath = `${filePath}.lock`;
  const token = crypto.randomBytes(16).toString('hex');
  // The lock lives beside the file, so its directory must exist first (owner-only: it holds credentials).
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  let delay = minDelayMs;
  let body;

  for (;;) {
    // Stamped per attempt, so a lock acquired after a long wait is not born looking old.
    body = JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now(), token });
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
    } catch (e) {
      if (e.code !== 'EEXIST') throw new TbError(`${lockPath}: cannot create lock: ${e.message}`);
    }
    if (fd !== undefined) {
      try {
        fs.writeSync(fd, body);
      } finally {
        fs.closeSync(fd);
      }
      break;
    }
    const seen = readLock(lockPath);
    if (seen !== null) {
      const now = Date.now();
      const stale = isStale(seen, staleMs, now) ?? mtimeAge(lockPath, now) > staleMs;
      if (stale) {
        breakLock(lockPath, seen);
        continue;
      }
    } else continue; // released between our open and read: retry at once
    if (Date.now() >= deadline) throw new TbError(`${filePath} is locked by another tb process; try again`);
    await sleep(delay / 2 + Math.random() * (delay / 2));
    delay = Math.min(delay * 2, maxDelayMs);
  }

  try {
    return await fn();
  } finally {
    // Only remove our own lock: if it was broken as stale, the current file belongs to someone else.
    if (readLock(lockPath) === body) fs.rmSync(lockPath, { force: true });
  }
}
