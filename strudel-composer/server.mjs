#!/usr/bin/env node
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';
import { ROOT, PUBLIC_DIR, STRUDEL_REPL_DIST } from './lib/paths.mjs';

if (existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));

const { evaluatePattern, formatEvaluation, PASS_SCORE } = await import('./lib/evaluate.mjs');
const { getKnowledge } = await import('./lib/knowledge.mjs');
const { getRenderer } = await import('./lib/renderer.mjs');
const { ClaudeTerminal } = await import('./lib/terminal.mjs');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 5174);
const SONGS_DIR = path.join(ROOT, 'songs');
const XTERM_DIR = path.join(ROOT, 'node_modules', '@xterm');

// The terminal is a real shell on this machine, so only this page may use
// it: requests must address localhost (blocks DNS rebinding), and the
// WebSocket needs a same-origin connection plus a per-process token.
const TOKEN = crypto.randomBytes(24).toString('hex');
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', ...(process.env.ALLOWED_HOSTS ?? '').split(',').filter(Boolean)]);
const hostOk = (hostHeader = '') => LOCAL_HOSTS.has(hostHeader.replace(/:\d+$/, ''));

const app = express();
app.use((req, res, next) => (hostOk(req.headers.host) ? next() : res.status(403).send('forbidden host')));
app.use(express.json({ limit: '1mb' }));
app.use('/vendor/strudel-repl', express.static(STRUDEL_REPL_DIST));
app.use('/vendor/xterm', express.static(path.join(XTERM_DIR, 'xterm')));
app.use('/vendor/xterm-fit', express.static(path.join(XTERM_DIR, 'addon-fit')));
app.use(express.static(PUBLIC_DIR));

// ------------------------------------------------------------ song state + events

let currentSong = null;
let editorCode = '';
const eventClients = new Set();
function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of eventClients) res.write(line);
}

app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write(': connected\n\n');
  eventClients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    eventClients.delete(res);
  });
});

app.get('/api/song', (_req, res) => res.json(currentSong));

const imagesAsDataUrls = (images) => Object.fromEntries(Object.entries(images).map(([n, b]) => [n, `data:image/png;base64,${b.toString('base64')}`]));
const clampCycles = (c) => Math.max(4, Math.min(32, Number(c) || 8));

// Render + score code. Used by the CLI's `test` command and the "Score my edits" button.
app.post('/api/evaluate', async (req, res) => {
  const { code, profile, cycles } = req.body ?? {};
  if (typeof code !== 'string' || !code.trim()) return res.status(400).json({ error: 'code required' });
  try {
    const ev = await evaluatePattern(code, { profile, cycles: clampCycles(cycles), images: true });
    res.json({ score: ev.score, pass: Boolean(ev.pass), subscores: ev.subscores, issues: ev.issues, summary: formatEvaluation(ev), images: imagesAsDataUrls(ev.images) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Called by `node scripts/strudel.mjs publish`: gate on the pass mark,
// save the song, and push it to every open editor.
app.post('/api/publish', async (req, res) => {
  const { code, title = 'Untitled', profile, force = false } = req.body ?? {};
  if (typeof code !== 'string' || !code.trim()) return res.status(400).json({ error: 'code required' });
  try {
    const ev = await evaluatePattern(code, { profile, cycles: 8, images: true });
    const summary = formatEvaluation(ev);
    if (!ev.report.ok) return res.status(422).json({ published: false, score: 0, summary });
    if (!ev.pass && !force) return res.status(422).json({ published: false, score: ev.score, summary });
    const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'song';
    const file = path.join(SONGS_DIR, 'published', `${new Date().toISOString().replace(/[:.]/g, '-')}-${slug}.strudel`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, code);
    currentSong = {
      type: 'song',
      code,
      title,
      score: ev.score,
      pass: Boolean(ev.pass),
      warning: ev.pass ? undefined : `Published below the pass mark (${ev.score}).`,
      subscores: ev.subscores,
      issues: ev.issues,
      images: imagesAsDataUrls(ev.images),
      file: path.relative(ROOT, file),
    };
    broadcast(currentSong);
    res.json({ published: true, score: ev.score, file: currentSong.file, listeners: eventClients.size, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The page reports what's in the editor so Claude can build on the user's edits.
app.get('/api/editor', (_req, res) => res.type('text/plain').send(editorCode));
app.post('/api/editor', async (req, res) => {
  const { code } = req.body ?? {};
  if (typeof code !== 'string') return res.status(400).json({ error: 'code required' });
  if (code !== editorCode) {
    editorCode = code;
    await fs.writeFile(path.join(SONGS_DIR, 'editor.strudel'), code).catch(() => {});
  }
  res.json({ ok: true });
});

app.get('/api/terminal-token', (_req, res) => res.json({ token: TOKEN }));

app.get('/api/status', (_req, res) => {
  const k = getKnowledge();
  res.json({
    passScore: PASS_SCORE,
    knowledge: { docs: k.docs.length, functions: k.functions.length, examples: k.examples.length, packs: k.sounds.packs.length },
  });
});

// ------------------------------------------------------------ terminal

const server = http.createServer(app);
const serverUrl = `http://127.0.0.1:${PORT}`;
const terminal = new ClaudeTerminal({ serverUrl });
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const origin = req.headers.origin ?? '';
  const sameOrigin = origin === `http://${req.headers.host}`;
  if (url.pathname !== '/api/terminal' || !hostOk(req.headers.host) || !sameOrigin || url.searchParams.get('token') !== TOKEN) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => terminal.attach(ws));
});

server.listen(PORT, HOST, () => {
  console.log(`Strudel Composer on http://localhost:${PORT}`);
  if (!getKnowledge().ready) console.warn('Knowledge base missing: run `npm run ingest`.');
  // Warm up the headless renderer so the first test is fast.
  getRenderer({ log: (m) => console.log(m) })
    .start()
    .catch((err) => console.error('Renderer failed to start (is Chromium installed? see README):', err.message));
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    terminal.stop();
    await getRenderer().stop().catch(() => {});
    process.exit(0);
  });
}
