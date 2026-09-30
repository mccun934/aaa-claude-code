#!/usr/bin/env node
// Evaluate a Strudel file from the command line.
// Usage: npm run evaluate -- song.strudel [--profile dance] [--cycles 8] [--out dir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { evaluatePattern, formatEvaluation } from '../lib/evaluate.mjs';
import { getRenderer } from '../lib/renderer.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!file) {
  console.error('usage: npm run evaluate -- <file> [--profile default|dance|ambient|chill] [--cycles 8] [--out dir]');
  process.exit(2);
}
const code = await fs.readFile(file, 'utf8');
const outDir = opt('--out');
const ev = await evaluatePattern(code, { cycles: Number(opt('--cycles', 8)), profile: opt('--profile', 'default'), images: !!outDir });
console.log(formatEvaluation(ev));
if (outDir) {
  await fs.mkdir(outDir, { recursive: true });
  const base = path.join(outDir, path.basename(file).replace(/\.\w+$/, ''));
  if (ev.wav) await fs.writeFile(`${base}.wav`, ev.wav);
  for (const [name, png] of Object.entries(ev.images)) await fs.writeFile(`${base}.${name}.png`, png);
  await fs.writeFile(`${base}.report.json`, JSON.stringify({ score: ev.score, subscores: ev.subscores, issues: ev.issues, report: ev.report }, null, 2));
  console.log(`\nwrote ${base}.{wav,spectrogram.png,pianoRoll.png,report.json}`);
}
await getRenderer().stop();
