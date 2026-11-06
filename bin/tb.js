#!/usr/bin/env node
import * as cmd from '../src/commands.js';
import { TbError } from '../src/git.js';

const HELP = `tb — every chat thread is a git branch

  tb init [--base main] [--approvals 2] [--no-tests] [--no-preview] [--tunnel cloudflared] [--pr]
  tb open    --thread <id> --title "<text>" --by <person>   new branch + worktree for a thread
  tb where   <thread>                                        print the thread's worktree path
  tb commit  <thread> -m "<msg>" --by <person>               commit everything in the worktree
  tb diff    <thread> [--max 3000]                           diffstat + diff against base
  tb test    <thread>                                        run the test command, record the result
  tb preview <thread>                                        (re)start the preview server, print URL
  tb approve <thread> --by <person>                          approve the current commit
  tb unapprove <thread> --by <person>
  tb check   <thread>                                        list what blocks a merge
  tb merge   <thread> --by <person>                          merge if quorum + tests pass
  tb sync    <thread>                                        merge base into the thread branch
  tb revert  <thread> --by <person>                          revert a merged thread on base
  tb close   <thread> --by <person>                          abandon a thread (branch kept)
  tb board                                                   every thread and its state
  tb log     [thread] [--n 30]                               audit trail

  tb user add <name>                                         create a login (password prompted, or piped on stdin)
  tb user rm  <name>                                         delete a login and revoke its tokens
  tb user unlock <name>                                      clear a login lockout
  tb login  <name>                                           log in; the token is kept in .git/tb-auth/token
  tb logout                                                  revoke your tokens and forget the local one
  tb whoami                                                  show who is logged in

<thread> is the Switch thread id, the branch key, or the branch name.
Login commands need TB_JWT_SECRET (at least 32 bytes). Passwords are never accepted as arguments.`;

function parse(argv) {
  const flags = {};
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') || (a.startsWith('-') && a.length === 2)) {
      const k = a.replace(/^-+/, '');
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) { flags[k] = next; i++; } else flags[k] = true;
    } else args.push(a);
  }
  return { flags, args };
}

const [name, ...rest] = process.argv.slice(2);
const fn = { ...cmd }[name];
if (!name || name === 'help' || name === '--help' || !fn || name === 'context') {
  console.log(HELP);
  process.exit(name && name !== 'help' && name !== '--help' ? 1 : 0);
}
try {
  const { flags, args } = parse(rest);
  console.log(await fn(process.cwd(), flags, args));
} catch (e) {
  if (e instanceof TbError) {
    console.error(`tb: ${e.message}`);
    // Auth failures share one message on purpose; the specific reason is opt-in.
    if (process.env.TB_DEBUG && e.cause) console.error(`tb: reason: ${e.cause.message ?? e.cause}`);
    process.exit(2);
  }
  throw e;
}
