import test from 'node:test';
import assert from 'node:assert/strict';
import { getKnowledge, tokenize } from '../lib/knowledge.mjs';

const k = getKnowledge();

test('knowledge base is ingested', () => {
  assert.ok(k.ready, 'run npm run ingest');
  assert.ok(k.docs.length > 300);
  assert.ok(k.functions.length > 300);
  assert.ok(k.examples.some((e) => e.kind === 'tune'));
  assert.ok(k.sounds.builtin.synths.includes('sawtooth'));
  assert.ok(Object.keys(k.sounds.builtin.drumMachines).includes('RolandTR909'));
  assert.ok(k.sounds.packs.some((p) => p.repo === 'yaxu/clean-breaks'));
});

test('tokenize splits camelCase and drops stopwords', () => {
  assert.deepEqual(tokenize('the lowPass filter'), ['low', 'pass', 'filter']);
});

test('doc search surfaces relevant sections and functions', () => {
  const hits = k.searchDocs('chop drum break loop', 4).join('\n');
  assert.match(hits, /chop|fit|loopAt/);
  assert.match(k.searchDocs('euclidean rhythm', 3).join('\n'), /euclid/i);
});

test('function lookup handles synonyms and dotted names', () => {
  assert.match(k.lookupFunction('.lpf()'), /low-\*\*p\*\*ass|lpf/);
  assert.match(k.lookupFunction('cutoff'), /### lpf/);
  assert.equal(k.lookupFunction('definitelyNotAFunction'), null);
});

test('find_sounds covers drum machines, soundfonts and loop packs with tempos', () => {
  assert.match(k.findSounds('909'), /RolandTR909/);
  assert.match(k.findSounds('epiano'), /gm_epiano1/);
  const breaks = k.findSounds('break');
  assert.match(breaks, /clean-breaks/);
  assert.match(breaks, /bpm/);
});
