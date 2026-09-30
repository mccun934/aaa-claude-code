// One long-lived pseudo-terminal running Claude Code, shared by every browser
// tab. Output is kept in a scrollback buffer so a page reload reattaches to
// the same session instead of starting over.
import pty from 'node-pty';
import { ROOT } from './paths.mjs';

const SCROLLBACK_BYTES = 256 * 1024;

export const WELCOME_PROMPT =
  process.env.STRUDEL_WELCOME ||
  "[Strudel Composer just opened; this message was sent automatically.] Greet me in two or three sentences: you compose music as Strudel code, test how musical it is, and publish it so it loads and plays in the editor on the right of this page. Then ask what I'd like to hear and offer three short, varied ideas. Don't run any tools yet.";

function defaultCommand() {
  const shell = process.env.SHELL || 'bash';
  // Full override, e.g. STRUDEL_TERMINAL_CMD='claude --model sonnet "$STRUDEL_WELCOME"'.
  if (process.env.STRUDEL_TERMINAL_CMD) return { file: shell, args: ['-l', '-c', process.env.STRUDEL_TERMINAL_CMD] };
  // Run Claude Code with the welcome prompt; when it exits, drop into a
  // normal shell so the terminal stays usable (type `claude -c` to resume).
  const script = [
    'if command -v claude >/dev/null 2>&1; then',
    '  claude --settings .claude/settings.json "$STRUDEL_WELCOME"',
    'else',
    '  echo "Claude Code is not installed. Install it with: npm install -g @anthropic-ai/claude-code"',
    'fi',
    'echo; echo "Claude exited. Type \\`claude -c\\` to continue the conversation."',
    `exec ${shell} -l`,
  ].join('\n');
  return { file: shell, args: ['-l', '-c', script] };
}

export class ClaudeTerminal {
  constructor({ serverUrl, command = defaultCommand() } = {}) {
    this.serverUrl = serverUrl;
    this.command = command;
    this.clients = new Set();
    this.buffer = '';
    this.cols = 100;
    this.rows = 30;
    this.proc = null;
  }

  start() {
    if (this.proc) return;
    this.buffer = '';
    this.proc = pty.spawn(this.command.file, this.command.args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: ROOT,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        STRUDEL_SERVER: this.serverUrl,
        STRUDEL_WELCOME: WELCOME_PROMPT,
      },
    });
    const proc = this.proc;
    proc.onData((data) => {
      this.buffer += data;
      if (this.buffer.length > SCROLLBACK_BYTES) this.buffer = this.buffer.slice(-SCROLLBACK_BYTES);
      this.#broadcast({ type: 'output', data });
    });
    proc.onExit(({ exitCode }) => {
      if (this.proc !== proc) return; // a restart already replaced it
      this.proc = null;
      this.#broadcast({ type: 'exit', exitCode });
    });
  }

  restart() {
    const old = this.proc;
    this.proc = null;
    try {
      old?.kill();
    } catch {}
    this.#broadcast({ type: 'reset' });
    this.start();
  }

  stop() {
    const old = this.proc;
    this.proc = null;
    try {
      old?.kill();
    } catch {}
  }

  /** Attach a WebSocket: replay scrollback, then stream live I/O. */
  attach(ws) {
    this.clients.add(ws);
    this.start();
    ws.send(JSON.stringify({ type: 'output', data: this.buffer }));
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'input' && typeof msg.data === 'string') this.proc?.write(msg.data);
      else if (msg.type === 'resize') this.#resize(msg.cols, msg.rows);
      else if (msg.type === 'restart') this.restart();
    });
    ws.on('close', () => this.clients.delete(ws));
  }

  #resize(cols, rows) {
    cols = Math.max(20, Math.min(500, cols | 0));
    rows = Math.max(5, Math.min(200, rows | 0));
    this.cols = cols;
    this.rows = rows;
    try {
      this.proc?.resize(cols, rows);
    } catch {}
  }

  #broadcast(msg) {
    const text = JSON.stringify(msg);
    for (const ws of this.clients) if (ws.readyState === 1) ws.send(text);
  }
}
