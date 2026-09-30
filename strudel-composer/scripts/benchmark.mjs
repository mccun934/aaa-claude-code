#!/usr/bin/env node
// Calibrates the musicality score: known-good tunes from the Strudel repo
// should score high, deliberately unmusical controls should score low.
// Usage: npm run benchmark [-- --limit 20] [--drums 15]
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../lib/paths.mjs';
import { getKnowledge } from '../lib/knowledge.mjs';
import { evaluatePattern, PASS_SCORE } from '../lib/evaluate.mjs';
import { getRenderer } from '../lib/renderer.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? Number(args[args.indexOf(n) + 1]) : d);

// Seeded RNG so controls are identical run to run.
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const NOTES = ['c', 'c#', 'd', 'eb', 'e', 'f', 'f#', 'g', 'ab', 'a', 'bb', 'b'];
const randNote = () => `${pick(NOTES)}${1 + Math.floor(rnd() * 6)}`;
const randWeight = () => (0.3 + rnd() * 2.7).toFixed(2);

function negativeControls() {
  const controls = [];
  for (let i = 0; i < 4; i++) {
    const cycles = Array.from({ length: 8 }, () =>
      `[${Array.from({ length: 3 + Math.floor(rnd() * 9) }, () => `${randNote()}@${randWeight()}`).join(' ')}]`,
    );
    controls.push({ name: `random-notes-${i}`, code: `note("<${cycles.join(' ')}>").s("${pick(['sawtooth', 'square', 'piano', 'gm_epiano1'])}")` });
  }
  for (let i = 0; i < 3; i++) {
    const sounds = ['bd', 'sd', 'hh', 'cp', 'rim', 'oh', 'cr', 'lt', 'misc', '~'];
    const cycles = Array.from({ length: 8 }, () => `[${Array.from({ length: 2 + Math.floor(rnd() * 13) }, () => `${pick(sounds)}@${randWeight()}`).join(' ')}]`);
    const tonal = Array.from({ length: 8 }, () => `[${Array.from({ length: 2 + Math.floor(rnd() * 6) }, () => `${randNote()}@${randWeight()}`).join(' ')}]`);
    controls.push({ name: `random-drums+notes-${i}`, code: `stack(s("<${cycles.join(' ')}>"), note("<${tonal.join(' ')}>").s("triangle"))` });
  }
  controls.push({ name: 'cluster-chords', code: `note("<[c3,c#3,d3,eb3] [f#3,g3,ab3,a3] [b2,c3,c#3] [e3,f3,f#3,g3]>").s("sawtooth").sustain(1)` });
  controls.push({ name: 'tritone-stack', code: `note("[c3,f#3,c4,f#4] [c#3,g3,c#4,g4]").s("square").fast(2)` });
  controls.push({ name: 'near-silent', code: `s("bd ~ ~ ~").gain(0.002)` });
  controls.push({ name: 'clipping-wall', code: `stack(s("bd*16").gain(6).distort(4), note("c1*16").s("sawtooth").gain(5))` });
  controls.push({ name: 'missing-sounds', code: `s("kickdrum*4, snarey*2, hatz*8")` });
  controls.push({ name: 'noise-burst', code: `s("white*32").gain(rand).speed(rand)` });
  controls.push({ name: 'polyrhythm-soup', code: `stack(note("c3 d#4 f#2").s("sawtooth").fast(1.37), note("a#5 e1").s("square").fast(2.71), s("hh").fast(3.33), s("bd").fast(1.61))` });
  return controls;
}

async function main() {
  const k = getKnowledge();
  const limit = opt('--limit', Infinity);
  const drumCount = opt('--drums', 15);
  const tunes = k.examples.filter((e) => e.kind === 'tune').slice(0, limit);
  const drums = k.examples.filter((e) => e.kind === 'drum-pattern');
  const drumSample = Array.from({ length: Math.min(drumCount, drums.length) }, (_, i) => drums[Math.floor((i * drums.length) / drumCount)]);
  const cases = [
    ...tunes.map((e) => ({ group: 'example-tune', name: e.name, code: e.code })),
    ...drumSample.map((e) => ({ group: 'drum-pattern', name: e.name, code: e.code })),
    ...negativeControls().map((c) => ({ group: 'control', ...c })),
  ];
  const results = [];
  for (const c of cases) {
    const t0 = Date.now();
    const ev = await evaluatePattern(c.code, { cycles: 8, profile: c.group === 'drum-pattern' ? 'drums' : 'default' });
    // Examples whose samples can't be downloaded here measure the network, not the scorer.
    const unavailable = c.group !== 'control' && ev.report.fetchFailures?.length && (ev.report.audio?.rmsDb ?? -99) < -45;
    const r = { group: c.group, name: c.name, score: ev.score, ok: ev.report.ok && !unavailable, error: unavailable ? `samples unavailable: ${ev.report.fetchFailures[0]}` : ev.report.error, subscores: ev.subscores, issues: ev.issues.length, ms: Date.now() - t0 };
    results.push(r);
    console.log(`${c.group.padEnd(13)} ${String(r.score).padStart(3)} ${r.ok ? '' : 'ERR '}${c.name}${r.ok ? '' : ` (${String(r.error).slice(0, 80)})`}`);
  }
  await getRenderer().stop();

  const valid = results.filter((r) => r.ok || r.group === 'control');
  const byGroup = {};
  for (const r of valid) (byGroup[r.group] ??= []).push(r.score);
  const stats = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return { n: s.length, mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1), median: s[Math.floor(s.length / 2)], min: s[0], max: s.at(-1), passRate: +(s.filter((x) => x >= PASS_SCORE).length / s.length).toFixed(2) };
  };
  const summary = Object.fromEntries(Object.entries(byGroup).map(([g, xs]) => [g, stats(xs)]));
  // AUC: probability a random good example outscores a random control.
  const pos = valid.filter((r) => r.group !== 'control').map((r) => r.score);
  const neg = valid.filter((r) => r.group === 'control').map((r) => r.score);
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  const auc = +(wins / (pos.length * neg.length)).toFixed(3);
  const skipped = results.filter((r) => !r.ok && r.group !== 'control').map((r) => `${r.name}: ${r.error}`);

  console.log('\nSummary', JSON.stringify(summary, null, 1), '\nAUC (good vs control):', auc);
  const dir = path.join(ROOT, 'benchmark');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'results.json'), JSON.stringify({ date: new Date().toISOString(), passScore: PASS_SCORE, auc, summary, skipped, results }, null, 1));
  const table = results.map((r) => `| ${r.group} | ${r.name} | ${r.ok ? r.score : 'error'} |`).join('\n');
  await fs.writeFile(
    path.join(dir, 'RESULTS.md'),
    `# Musicality benchmark\n\nGenerated by \`npm run benchmark\` on ${new Date().toISOString().slice(0, 10)}. Pass mark: ${PASS_SCORE}.\n\n` +
      `**AUC (example tunes + drum patterns vs. unmusical controls): ${auc}**\n\n` +
      `| group | n | mean | median | min | max | pass rate |\n|---|---|---|---|---|---|---|\n` +
      Object.entries(summary).map(([g, s]) => `| ${g} | ${s.n} | ${s.mean} | ${s.median} | ${s.min} | ${s.max} | ${s.passRate} |`).join('\n') +
      `\n\n${skipped.length ? `Examples that failed to evaluate headlessly (excluded):\n${skipped.map((s) => `- ${s}`).join('\n')}\n\n` : ''}` +
      `## All cases\n\n| group | name | score |\n|---|---|---|\n${table}\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
