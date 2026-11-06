import { TbError } from '../git.js';

// More than any acceptable password (MAX_PASSWORD_BYTES) plus a newline; stops `yes | tb login` filling memory.
const MAX_STDIN_BYTES = 64 * 1024;

/** First line of a non-TTY stream (piped stdin), without its line ending. */
function readLine(input) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const done = () => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      input.pause();
    };
    const finish = () => {
      done();
      const text = Buffer.concat(chunks).toString('utf8');
      const nl = text.search(/\r?\n/);
      resolve(nl === -1 ? text : text.slice(0, nl));
    };
    const onData = (c) => {
      chunks.push(c);
      size += c.length;
      // A full first line is all we need; stop reading so a long stream is never buffered.
      if (c.includes(10) || size > MAX_STDIN_BYTES) finish();
    };
    const onEnd = () => finish();
    const onError = (e) => {
      done();
      reject(new TbError(`cannot read password from stdin: ${e.message}`));
    };
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', onError);
    input.resume();
  });
}

/**
 * Read a line from a TTY in raw mode with no echo. Ctrl-C / Ctrl-D (on an empty line) cancel, as does
 * the TTY closing. Escape sequences (arrow keys, Home, F-keys, Alt+key) are swallowed whole, never
 * typed into the password, with parser state kept across chunks.
 */
function readHidden(input, output, prompt) {
  return new Promise((resolve, reject) => {
    let value = '';
    // '' normal | 'esc' after ESC | 'csi' inside ESC [ ... | 'ss3' after ESC O
    let esc = '';
    output.write(prompt);
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.setEncoding('utf8');
    const finish = (err) => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (esc) {
          const c = ch.codePointAt(0);
          if (esc === 'esc') esc = ch === '[' ? 'csi' : ch === 'O' ? 'ss3' : '';
          else if (esc === 'ss3') esc = '';
          else if (c >= 0x40 && c <= 0x7e) esc = ''; // CSI final byte; params/intermediates keep going
          continue;
        }
        if (ch === '\u001b') {
          esc = 'esc';
          continue;
        }
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') return finish(new TbError('cancelled'));
        if (ch === '\u0004') {
          if (!value) return finish(new TbError('cancelled'));
          continue;
        }
        if (ch === '\u007f' || ch === '\b') {
          value = [...value].slice(0, -1).join('');
          continue;
        }
        if (ch === '\u0015') { // Ctrl-U: clear the line
          value = '';
          continue;
        }
        if (/\p{Cc}/u.test(ch)) continue; // ignore other control characters (arrow keys, etc.)
        value += ch;
        if (Buffer.byteLength(value) > MAX_STDIN_BYTES) return finish(new TbError('password too long'));
      }
    };
    const onEnd = () => finish(new TbError('cancelled'));
    const onError = (e) => finish(new TbError(`cannot read password: ${e.message}`));
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', onError);
    input.resume();
  });
}

/**
 * Read a password: hidden from a TTY (prompt on stderr), or the first line of piped stdin.
 * With confirm, a TTY user types it twice. Throws TbError for an empty password.
 */
export async function readPassword(prompt = 'Password: ', { confirm = false, input = process.stdin, output = process.stderr } = {}) {
  let pw;
  if (input.isTTY && typeof input.setRawMode === 'function') {
    pw = await readHidden(input, output, prompt);
    if (confirm && pw && (await readHidden(input, output, 'Repeat password: ')) !== pw) throw new TbError('passwords do not match');
  } else {
    pw = await readLine(input);
  }
  if (!pw) throw new TbError('no password given (type it at the prompt or pipe it on stdin)');
  return pw;
}
