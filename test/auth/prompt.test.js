import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readPassword } from '../../src/auth/prompt.js';
import { TbError } from '../../src/git.js';

/** A PassThrough that looks like a TTY with raw mode. */
function fakeTty() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.rawCalls = [];
  input.setRawMode = (v) => { input.rawCalls.push(v); input.isRaw = v; return input; };
  const output = new PassThrough();
  let written = '';
  output.on('data', (d) => { written += d; });
  return { input, output, written: () => written };
}
const tick = () => new Promise((r) => setImmediate(r));
const tbErr = (re) => (e) => e instanceof TbError && re.test(e.message);

describe('readPassword over a TTY', () => {
  test('plain line; prompt written to output; raw mode on then restored', async () => {
    const t = fakeTty();
    const p = readPassword('PW: ', { input: t.input, output: t.output });
    t.input.write('hunter22\r');
    assert.equal(await p, 'hunter22');
    assert.equal(t.written(), 'PW: \n');
    assert.deepEqual(t.input.rawCalls, [true, false]);
    assert.equal(t.input.isRaw, false);
  });

  test('escape sequences split across chunks are dropped whole', async () => {
    const t = fakeTty();
    const p = readPassword('PW: ', { input: t.input, output: t.output });
    t.input.write('abc\x1b[D'); await tick();
    t.input.write('def\x1bOA\r');
    assert.equal(await p, 'abcdef');
  });

  test('ESC split exactly after ESC and after ESC [', async () => {
    const t = fakeTty();
    const p = readPassword('', { input: t.input, output: t.output });
    t.input.write('ab\x1b'); await tick();
    t.input.write('['); await tick();
    t.input.write('1;5Ccd\r');
    assert.equal(await p, 'abcd');
  });

  test('CSI with params (ESC[1;5C), Alt+key (ESC x), F-keys (ESC[15~) dropped', async () => {
    const t = fakeTty();
    const p = readPassword('', { input: t.input, output: t.output });
    t.input.write('a\x1b[1;5Cb\x1bxc\x1b[15~d\r');
    assert.equal(await p, 'abcd');
  });

  test('backspace (DEL and ^H), Ctrl-U, other control chars', async () => {
    const t = fakeTty();
    const p = readPassword('', { input: t.input, output: t.output });
    t.input.write('wrong\x15pa\x7fass\bsw\x01\x02ord\r');
    assert.equal(await p, 'passsword'.replace('sss', 'ss'));
  });

  test('backspace removes a whole emoji (code point), not half a surrogate', async () => {
    const t = fakeTty();
    const p = readPassword('', { input: t.input, output: t.output });
    t.input.write('pw🚀🚀\x7f\r');
    assert.equal(await p, 'pw🚀');
  });

  test('\\n also ends input', async () => {
    const t = fakeTty();
    const p = readPassword('', { input: t.input, output: t.output });
    t.input.write('line\n');
    assert.equal(await p, 'line');
  });

  test('Ctrl-C -> TbError cancelled; raw restored', async () => {
    const t = fakeTty();
    const p = readPassword('', { input: t.input, output: t.output });
    t.input.write('abc\x03');
    await assert.rejects(p, tbErr(/^cancelled$/));
    assert.equal(t.input.isRaw, false);
  });

  test('Ctrl-D on empty line cancels; mid-line it is ignored', async () => {
    let t = fakeTty();
    let p = readPassword('', { input: t.input, output: t.output });
    t.input.write('\x04');
    await assert.rejects(p, tbErr(/^cancelled$/));
    t = fakeTty();
    p = readPassword('', { input: t.input, output: t.output });
    t.input.write('ab\x04cd\r');
    assert.equal(await p, 'abcd');
  });

  test('stream ends before Enter -> TbError cancelled; raw restored', async () => {
    const t = fakeTty();
    const p = readPassword('', { input: t.input, output: t.output });
    t.input.write('partial');
    t.input.end();
    await assert.rejects(p, tbErr(/^cancelled$/));
    assert.equal(t.input.isRaw, false);
  });

  test('stream error -> TbError "cannot read password: <msg>"; raw restored', async () => {
    const t = fakeTty();
    const p = readPassword('', { input: t.input, output: t.output });
    await tick();
    t.input.emit('error', new Error('EIO boom'));
    await assert.rejects(p, tbErr(/^cannot read password: EIO boom$/));
    assert.equal(t.input.isRaw, false);
  });

  test('empty line -> no password given', async () => {
    const t = fakeTty();
    const p = readPassword('', { input: t.input, output: t.output });
    t.input.write('\r');
    await assert.rejects(p, tbErr(/^no password given/));
  });

  test('confirm: match resolves, mismatch rejects', async () => {
    let t = fakeTty();
    let p = readPassword('A: ', { input: t.input, output: t.output, confirm: true });
    t.input.write('samepass\r'); await tick(); await tick();
    t.input.write('samepass\r');
    assert.equal(await p, 'samepass');
    assert.match(t.written(), /A: \nRepeat password: \n/);
    t = fakeTty();
    p = readPassword('A: ', { input: t.input, output: t.output, confirm: true });
    t.input.write('samepass\r'); await tick(); await tick();
    t.input.write('otherpass\r');
    await assert.rejects(p, tbErr(/^passwords do not match$/));
  });

  test('wasRaw restored when input was already raw', async () => {
    const t = fakeTty();
    t.input.isRaw = true;
    const p = readPassword('', { input: t.input, output: t.output });
    t.input.write('x\r');
    await p;
    assert.equal(t.input.isRaw, true);
  });
});

describe('readPassword from a pipe (non-TTY)', () => {
  const pipe = (chunks, end = true) => {
    const s = new PassThrough();
    (async () => { for (const c of chunks) { s.write(c); await tick(); } if (end) s.end(); })();
    return s;
  };
  test('first line only, CRLF stripped, spaces kept', async () => {
    assert.equal(await readPassword('', { input: pipe([' a b \r\nnext\n']) }), ' a b ');
  });
  test('line split across chunks', async () => {
    assert.equal(await readPassword('', { input: pipe(['pass', 'word', '\nrest']) }), 'password');
  });
  test('no newline before EOF', async () => {
    assert.equal(await readPassword('', { input: pipe(['tail']) }), 'tail');
  });
  test('resolves at first newline without waiting for EOF', async () => {
    assert.equal(await readPassword('', { input: pipe(['early\n'], false) }), 'early');
  });
  test('empty input / empty first line -> no password given', async () => {
    await assert.rejects(readPassword('', { input: pipe([]) }), tbErr(/^no password given/));
    await assert.rejects(readPassword('', { input: pipe(['\nsecond\n']) }), tbErr(/^no password given/));
  });
  test('stream error -> TbError cannot read password from stdin', async () => {
    const s = new PassThrough();
    const p = readPassword('', { input: s });
    await tick();
    s.emit('error', new Error('boom'));
    await assert.rejects(p, tbErr(/^cannot read password from stdin: boom$/));
  });
  test('nothing is written to output for piped input', async () => {
    const out = new PassThrough();
    let w = '';
    out.on('data', (d) => { w += d; });
    await readPassword('PROMPT: ', { input: pipe(['x\n']), output: out });
    assert.equal(w, '');
  });
});
