// Integration tests against the real Strudel engine in headless Chromium.
// Needs Chromium + network for samples. Skip with SKIP_ENGINE_TESTS=1.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { KNOWLEDGE_DIR } from '../lib/paths.mjs';
import { getRenderer } from '../lib/renderer.mjs';
import { evaluatePattern } from '../lib/evaluate.mjs';

const skip = process.env.SKIP_ENGINE_TESTS === '1';
after(() => getRenderer().stop());

const GOOD = `setcps(0.5)
stack(
  s("bd*4, [~ cp]*2, hh*8").bank("RolandTR909").gain(.7),
  n("<0 0 5 4>*8").scale("C1:minor").s("sawtooth").lpf(500).gain(.5),
  chord("<Cm9 Cm9 Ab^7 Bb7>").voicing().s("gm_epiano1").gain(.5),
  n("<[0 2 4 2] [4 3 2 ~]>*2").scale("C4:minor").s("triangle").gain(.4).delay(.2)
)`;

test('a well-formed song renders, is analysed and passes', { skip }, async () => {
  const ev = await evaluatePattern(GOOD, { images: true });
  assert.equal(ev.report.ok, true, ev.report.error);
  assert.deepEqual(ev.report.missingSounds, []);
  assert.ok(ev.wav.length > 100_000);
  assert.ok(ev.images.spectrogram && ev.images.pianoRoll);
  assert.match(ev.report.symbolic.key, /C minor|Eb major/);
  assert.ok(ev.score >= 70, `score ${ev.score}: ${ev.issues.join(' | ')}`);
});

test('evaluation errors are reported', { skip }, async () => {
  const ev = await evaluatePattern('note("c e g").notAFunction()');
  assert.equal(ev.report.ok, false);
  assert.match(ev.report.error, /notAFunction/);
  assert.equal(ev.score, 0);
});

test('unknown sounds are detected and penalised', { skip }, async () => {
  const ev = await evaluatePattern('s("bd*4, nosuchsound*2")');
  assert.deepEqual(ev.report.missingSounds, ['nosuchsound']);
  assert.match(ev.issues[0], /nosuchsound/);
});

test('a song redefining a sample name does not leak into later renders', { skip }, async () => {
  const r = getRenderer();
  await r.run(`samples({ bd: 'bd/nope.wav' }, 'https://example.invalid/')\ns("bd")`, { cycles: 1 });
  const ev = await evaluatePattern('s("bd*4")', { cycles: 2 });
  assert.ok(ev.report.audio.rmsDb > -40, `rms ${ev.report.audio.rmsDb}`);
});

test('every code block in the cheatsheet evaluates with known sounds', { skip, timeout: 300_000 }, async () => {
  const md = fs.readFileSync(path.join(KNOWLEDGE_DIR, 'cheatsheet.md'), 'utf8');
  const blocks = [...md.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 2);
  for (const block of blocks) {
    // The loops block is a list of alternatives; run each line on its own.
    const programs = block.includes("samples('github:")
      ? block.split('\n').filter((l) => l.startsWith('s(')).map((l) => `samples('github:yaxu/clean-breaks')\nsamples('github:Bubobubobubobubo/Dough-Amen')\nsamples('github:tidalcycles/dirt-samples')\n${l}`)
      : [block];
    for (const code of programs) {
      const run = await getRenderer().run(code, { cycles: 2, render: false });
      assert.equal(run.ok, true, `${code}\n→ ${run.error}`);
      assert.deepEqual(run.missingSounds, [], code);
      assert.ok(run.haps.length > 0, code);
    }
  }
});
