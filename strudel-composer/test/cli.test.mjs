import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { ClaudeTerminal } from '../lib/terminal.mjs';

const cli = (...args) => execFileSync('node', ['scripts/strudel.mjs', ...args], { encoding: 'utf8' });

test('CLI knowledge commands', () => {
  assert.match(cli('fn', 'lpf'), /### lpf/);
  assert.match(cli('sounds', '909'), /RolandTR909/);
  assert.match(cli('docs', 'euclidean', 'rhythm'), /euclid/i);
  assert.match(cli('examples', 'house'), /House/);
});

test('publish without a title is refused', () => {
  assert.throws(() => execFileSync('node', ['scripts/strudel.mjs', 'publish', 'CLAUDE.md'], { stdio: 'pipe' }), /title/);
});

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(text) {
    this.sent.push(JSON.parse(text));
  }
}

test('terminal streams output, takes input and replays scrollback to new clients', async () => {
  const t = new ClaudeTerminal({ serverUrl: 'http://x', command: { file: 'bash', args: ['--norc', '-i'] } });
  const a = new FakeSocket();
  t.attach(a);
  a.emit('message', JSON.stringify({ type: 'input', data: 'echo "$STRUDEL_SERVER-ok"\r' }));
  const until = async (fn) => {
    for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 50));
  };
  const text = (s) => s.sent.map((m) => m.data ?? '').join('');
  await until(() => text(a).includes('http://x-ok'));
  assert.match(text(a), /http:\/\/x-ok/);
  const b = new FakeSocket();
  t.attach(b);
  assert.match(b.sent[0].data, /http:\/\/x-ok/, 'late client gets scrollback');
  t.stop();
});
