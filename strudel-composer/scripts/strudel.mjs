#!/usr/bin/env node
// Command-line tools for composing in Strudel, used by Claude Code in the
// web terminal (see CLAUDE.md) and handy by hand.
//
//   node scripts/strudel.mjs docs <query>          search strudel.cc docs + API reference
//   node scripts/strudel.mjs fn <name>             API reference for one function
//   node scripts/strudel.mjs examples <query>      search example tunes and drum patterns
//   node scripts/strudel.mjs sounds <query>        find synths, soundfonts, samples, drum machines, loop packs
//   node scripts/strudel.mjs test <file> [--profile p] [--cycles n] [--listen]
//   node scripts/strudel.mjs publish <file> --title "Title" [--profile p] [--force]
//   node scripts/strudel.mjs editor                print the code currently in the web editor
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../lib/paths.mjs';
import { getKnowledge } from '../lib/knowledge.mjs';

const SERVER = process.env.STRUDEL_SERVER || `http://127.0.0.1:${process.env.PORT || 5174}`;
const LISTEN_DIR = path.join(ROOT, 'songs', '.listen');

const argv = process.argv.slice(2);
const [cmd, ...rest] = argv;
const BOOLEAN_FLAGS = new Set(['listen', 'force']);
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (!a.startsWith('--')) positional.push(a);
  else if (BOOLEAN_FLAGS.has(a.slice(2))) flags[a.slice(2)] = true;
  else flags[a.slice(2)] = rest[++i];
}
const arg = positional.join(' ');

function usage() {
  console.error('usage: node scripts/strudel.mjs <docs|fn|examples|sounds|test|publish|editor> ... (see the header of this file)');
  process.exit(2);
}

async function server(pathname, body) {
  const res = await fetch(`${SERVER}${pathname}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const type = res.headers.get('content-type') ?? '';
  const data = type.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data };
}

async function readCode(file) {
  if (!file) {
    console.error('missing <file>');
    process.exit(2);
  }
  return fs.readFile(path.resolve(file), 'utf8');
}

async function test() {
  const file = positional[0];
  const code = await readCode(file);
  const body = { code, profile: flags.profile, cycles: flags.cycles };
  let result;
  try {
    const { status, data } = await server('/api/evaluate', body);
    if (status !== 200) throw new Error(data.error || `HTTP ${status}`);
    result = data;
  } catch (err) {
    if (err.cause?.code !== 'ECONNREFUSED') throw err;
    // No server running: render locally (slower, launches its own browser).
    const { evaluatePattern, formatEvaluation } = await import('../lib/evaluate.mjs');
    const { getRenderer } = await import('../lib/renderer.mjs');
    const ev = await evaluatePattern(code, { profile: flags.profile, cycles: Number(flags.cycles) || 8, images: Boolean(flags.listen) });
    await getRenderer().stop();
    result = { summary: formatEvaluation(ev), images: Object.fromEntries(Object.entries(ev.images).map(([n, b]) => [n, `data:image/png;base64,${b.toString('base64')}`])) };
  }
  console.log(result.summary);
  if (flags.listen) {
    await fs.mkdir(LISTEN_DIR, { recursive: true });
    const base = path.basename(file).replace(/\.\w+$/, '');
    const written = [];
    for (const [name, url] of Object.entries(result.images ?? {})) {
      const out = path.join(LISTEN_DIR, `${base}.${name}.png`);
      await fs.writeFile(out, Buffer.from(url.split(',')[1], 'base64'));
      written.push(path.relative(ROOT, out));
    }
    if (written.length) {
      console.log(`\nListen: open these images to see the render:\n${written.map((w) => `- ${w}`).join('\n')}`);
      console.log('Spectrogram: log frequency 40 Hz-16 kHz, dotted blue = cycle boundaries, green = 100 Hz / 1 kHz / 10 kHz. Piano roll: pitched parts above, percussion lanes below, one color per sound.');
    }
  }
}

async function publish() {
  const code = await readCode(positional[0]);
  if (!flags.title || flags.title === true) {
    console.error('publish needs --title "Song title"');
    process.exit(2);
  }
  let res;
  try {
    res = await server('/api/publish', { code, title: flags.title, profile: flags.profile, force: Boolean(flags.force) });
  } catch (err) {
    console.error(`Could not reach the Strudel Composer server at ${SERVER} (${err.cause?.code ?? err.message}). Is \`npm start\` running?`);
    process.exit(1);
  }
  const { status, data } = res;
  if (status === 200) {
    console.log(`Published "${flags.title}" (score ${data.score}) to ${data.listeners} open editor(s); saved as ${data.file}.\n\n${data.summary}`);
  } else if (status === 422) {
    console.log(`NOT published: score ${data.score} is below the pass mark or the code fails. Fix the issues and publish again (use --force only if you've tried twice and are sure).\n\n${data.summary}`);
    process.exit(1);
  } else {
    console.error(`Publish failed: ${data.error ?? status}`);
    process.exit(1);
  }
}

async function editor() {
  try {
    const { data } = await server('/api/editor');
    console.log(data || '(editor is empty)');
  } catch {
    const file = path.join(ROOT, 'songs', 'editor.strudel');
    console.log(await fs.readFile(file, 'utf8').catch(() => '(no editor state available: is the server running?)'));
  }
}

const k = () => getKnowledge();
switch (cmd) {
  case 'docs':
    console.log(k().searchDocs(arg, Number(flags.limit) || 5).join('\n\n---\n\n') || 'No results.');
    break;
  case 'fn':
    console.log(k().lookupFunction(arg) ?? `No function named "${arg}". Try: node scripts/strudel.mjs docs ${arg}`);
    break;
  case 'examples':
    console.log(k().searchExamples(arg, Number(flags.limit) || 3).join('\n\n---\n\n') || 'No results.');
    break;
  case 'sounds':
    console.log(k().findSounds(arg));
    break;
  case 'test':
    await test();
    break;
  case 'publish':
    await publish();
    break;
  case 'editor':
    await editor();
    break;
  default:
    usage();
}
