import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kill a detached process group started by startDetached. */
export function stop(pid) {
  if (!alive(pid)) return false;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  return true;
}

function startDetached(cwd, command, env, logFile) {
  const fd = fs.openSync(logFile, 'a');
  const child = spawn('sh', ['-c', command], {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  fs.closeSync(fd);
  return child.pid;
}

function portFree(port) {
  // Synchronous check: try to bind in a child node process.
  const r = spawnSync(process.execPath, ['-e', `const s=require('net').createServer();s.once('error',()=>process.exit(1));s.listen(${port},'127.0.0.1',()=>s.close(()=>process.exit(0)))`]);
  return r.status === 0;
}

export function pickPort(start, taken) {
  for (let p = start; p < start + 500; p++) {
    if (!taken.has(p) && portFree(p)) return p;
  }
  throw new Error('no free preview port');
}

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = spawnSync(process.execPath, ['-e', `const c=require('net').connect(${port},'127.0.0.1');c.on('connect',()=>process.exit(0));c.on('error',()=>process.exit(1))`]);
    if (r.status === 0) return true;
    sleep(300);
  }
  return false;
}

function waitForTunnelUrl(logFile, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) return m[0];
    sleep(500);
  }
  return null;
}

/**
 * Start the preview server (and optional tunnel) for a thread.
 * Returns { pid, tunnelPid, url, localUrl, ready, logFile }.
 */
export function startPreview({ cwd, command, port, tunnel, logsDir, key }) {
  const logFile = path.join(logsDir, `${key}.preview.log`);
  fs.writeFileSync(logFile, '');
  const pid = startDetached(cwd, command, { PORT: String(port) }, logFile);
  const ready = waitForPort(port, 20000);
  const localUrl = `http://localhost:${port}`;
  let url = localUrl;
  let tunnelPid = null;
  if (ready && tunnel === 'cloudflared') {
    const tlog = path.join(logsDir, `${key}.tunnel.log`);
    fs.writeFileSync(tlog, '');
    tunnelPid = startDetached(cwd, `cloudflared tunnel --no-autoupdate --url ${localUrl}`, {}, tlog);
    url = waitForTunnelUrl(tlog, 20000) || localUrl;
  }
  return { pid, tunnelPid, url, localUrl, ready, logFile };
}

