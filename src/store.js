import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CONFIG = {
  base: 'main',
  // Distinct people who must approve before a thread can merge.
  approvalsRequired: 2,
  // Whether the person who opened the thread counts toward the quorum.
  selfApproveCounts: false,
  // Run in the worktree before merge; null skips the test gate.
  testCommand: 'npm test',
  // Started in the worktree with PORT set; null disables previews.
  previewCommand: 'npm start',
  previewPortStart: 4100,
  // "none" or "cloudflared" (public trycloudflare.com URL teammates can open).
  previewTunnel: 'none',
  // "merge" merges locally into base; "pr" pushes and opens a GitHub PR with gh.
  mergeMode: 'merge',
};

export class Store {
  constructor(root) {
    this.root = root;
    this.dir = path.join(root, '.tb');
    this.statePath = path.join(this.dir, 'state.json');
    this.configPath = path.join(this.dir, 'config.json');
    this.auditPath = path.join(this.dir, 'audit.jsonl');
    this.logsDir = path.join(this.dir, 'logs');
    this.worktreesDir = path.join(this.dir, 'worktrees');
  }

  get initialized() {
    return fs.existsSync(this.configPath);
  }

  init(overrides = {}) {
    fs.mkdirSync(this.logsDir, { recursive: true });
    fs.mkdirSync(this.worktreesDir, { recursive: true });
    if (!fs.existsSync(this.configPath)) {
      fs.writeFileSync(this.configPath, JSON.stringify({ ...DEFAULT_CONFIG, ...overrides }, null, 2) + '\n');
    }
    if (!fs.existsSync(this.statePath)) this.save({ threads: {} });
  }

  config() {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(this.configPath, 'utf8')) };
  }

  load() {
    return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
  }

  save(state) {
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    fs.renameSync(tmp, this.statePath);
  }

  update(fn) {
    const state = this.load();
    const result = fn(state);
    this.save(state);
    return result;
  }

  audit(event, data) {
    fs.appendFileSync(this.auditPath, JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n');
  }

  readAudit() {
    if (!fs.existsSync(this.auditPath)) return [];
    return fs.readFileSync(this.auditPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
}
