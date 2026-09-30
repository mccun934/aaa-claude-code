#!/usr/bin/env node
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { ROOT, PUBLIC_DIR, STRUDEL_REPL_DIST } from './lib/paths.mjs';

if (existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));

const { ComposerSession, MODEL } = await import('./lib/agent.mjs');
const { evaluatePattern, formatEvaluation, PASS_SCORE } = await import('./lib/evaluate.mjs');
const { getKnowledge } = await import('./lib/knowledge.mjs');
const { getRenderer } = await import('./lib/renderer.mjs');

const PORT = Number(process.env.PORT || 5174);
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/vendor/strudel-repl', express.static(STRUDEL_REPL_DIST));
app.use(express.static(PUBLIC_DIR));

const sessions = new Map();
function getSession(id) {
  let entry = id && sessions.get(id);
  if (!entry) {
    id = crypto.randomUUID();
    entry = { id, session: new ComposerSession(), busy: false };
    sessions.set(id, entry);
  }
  entry.touched = Date.now();
  return entry;
}
setInterval(() => {
  for (const [id, e] of sessions) if (Date.now() - e.touched > SESSION_TTL_MS) sessions.delete(id);
}, 60_000).unref();

app.get('/api/status', (_req, res) => {
  const k = getKnowledge();
  res.json({
    model: MODEL,
    passScore: PASS_SCORE,
    apiKey: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    knowledge: { docs: k.docs.length, functions: k.functions.length, examples: k.examples.length, synths: k.sounds.builtin.synths.length, packs: k.sounds.packs.length },
  });
});

app.post('/api/chat', async (req, res) => {
  const { sessionId, message, editorCode } = req.body ?? {};
  if (typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'message required' });
  const entry = getSession(sessionId);
  if (entry.busy) return res.status(409).json({ error: 'still working on the previous message' });
  entry.busy = true;

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const emit = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  emit({ type: 'session', sessionId: entry.id });
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  try {
    await entry.session.send(message, { editorCode, emit, signal: abort.signal });
  } catch (err) {
    if (!abort.signal.aborted) {
      console.error(err);
      emit({ type: 'error', message: err.message });
      emit({ type: 'done', published: false });
    }
  } finally {
    entry.busy = false;
    res.end();
  }
});

// Score whatever is in the editor (e.g. after the user edits it by hand).
app.post('/api/evaluate', async (req, res) => {
  const { code, profile, cycles } = req.body ?? {};
  if (typeof code !== 'string' || !code.trim()) return res.status(400).json({ error: 'code required' });
  try {
    const ev = await evaluatePattern(code, { profile, cycles: Math.max(4, Math.min(32, Number(cycles) || 8)), images: true });
    res.json({
      score: ev.score,
      pass: ev.pass,
      subscores: ev.subscores,
      issues: ev.issues,
      summary: formatEvaluation(ev),
      images: Object.fromEntries(Object.entries(ev.images).map(([n, b]) => [n, `data:image/png;base64,${b.toString('base64')}`])),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Strudel Composer on http://localhost:${PORT}  (model ${MODEL})`);
  if (!getKnowledge().ready) console.warn('Knowledge base missing: run `npm run ingest`.');
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) console.warn('ANTHROPIC_API_KEY is not set; chat will fail until it is.');
  // Warm up the headless renderer so the first test is fast.
  getRenderer({ log: (m) => console.log(m) })
    .start()
    .catch((err) => console.error('Renderer failed to start (is Chromium installed? see README):', err.message));
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await getRenderer().stop().catch(() => {});
    process.exit(0);
  });
}
