import test from 'node:test';
import assert from 'node:assert/strict';
import { noteToMidi, detectKey, analyzeEvents, scoreMusicality } from '../lib/music.mjs';
import { decodeWav, analyzeAudio, fft } from '../lib/audio.mjs';

test('noteToMidi parses names, accidentals and default octave', () => {
  assert.equal(noteToMidi('c4'), 60);
  assert.equal(noteToMidi('C#4'), 61);
  assert.equal(noteToMidi('eb3'), 51);
  assert.equal(noteToMidi('a'), 57);
  assert.equal(noteToMidi(64), 64);
  assert.equal(noteToMidi('x9'), undefined);
});

test('detectKey finds C major and A minor', () => {
  const cMajor = [5, 0, 3, 0, 4, 3, 0, 5, 0, 3, 0, 2];
  assert.equal(detectKey(cMajor).key, 'C major');
  const aMinor = [3, 0, 2, 0, 3, 2, 0, 2, 1, 5, 0, 2];
  assert.equal(detectKey(aMinor).key, 'A minor');
});

const hap = (begin, end, value) => ({ begin, end, value });

function groove(cycles = 8) {
  const haps = [];
  const prog = [48, 53, 55, 48];
  for (let c = 0; c < cycles; c++) {
    for (let i = 0; i < 4; i++) haps.push(hap(c + i / 4, c + i / 4 + 0.1, { s: 'bd' }));
    for (let i = 0; i < 8; i++) haps.push(hap(c + i / 8, c + i / 8 + 0.05, { s: 'hh', gain: i % 2 ? 0.6 : 0.9 }));
    const root = prog[c % 4];
    for (let i = 0; i < 4; i++) haps.push(hap(c + i / 4, c + (i + 1) / 4, { note: root - 12, s: 'sawtooth' }));
    for (const iv of [0, 4, 7]) haps.push(hap(c, c + 1, { note: root + iv + (root === 48 ? 0 : 0), s: 'piano' }));
    const mel = [72, 74, 76, 74][c % 4];
    haps.push(hap(c, c + 0.5, { note: mel, s: 'triangle' }), hap(c + 0.5, c + 1, { note: mel - 2, s: 'triangle' }));
  }
  return haps;
}

test('a tonal, layered, repeating groove scores well symbolically', () => {
  const ev = analyzeEvents(groove(), { cycles: 8, cps: 0.5 });
  const m = ev.metrics;
  assert.ok(m.roles.includes('percussion') && m.roles.includes('bass') && m.roles.includes('harmony'));
  assert.ok(m.keyCorrelation > 0.6, `key r ${m.keyCorrelation}`);
  assert.equal(m.onGridRatio, 1);
  assert.ok(m.repetition >= 0.9);
  const s = scoreMusicality({ ok: true, events: ev });
  assert.ok(s.score >= 80, `score ${s.score} ${JSON.stringify(s.subscores)}`);
});

test('random chromatic notes at random times score poorly', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const haps = [];
  for (let i = 0; i < 80; i++) {
    const b = rnd() * 8;
    haps.push(hap(b, b + rnd() * 0.3 + 0.01, { note: 36 + Math.floor(rnd() * 48), s: 'square' }));
  }
  const s = scoreMusicality({ ok: true, events: analyzeEvents(haps, { cycles: 8, cps: 0.5 }) });
  assert.ok(s.score < 60, `score ${s.score}`);
  assert.ok(s.issues.length >= 2);
});

test('errors, empty patterns and missing sounds are penalised', () => {
  assert.equal(scoreMusicality({ ok: false, error: 'boom' }).score, 0);
  assert.equal(scoreMusicality({ ok: true, events: analyzeEvents([], { cycles: 8, cps: 0.5 }) }).score, 0);
  const ev = analyzeEvents(groove(), { cycles: 8, cps: 0.5 });
  const full = scoreMusicality({ ok: true, events: ev }).score;
  const missing = scoreMusicality({ ok: true, events: ev, missingSounds: ['foo'] });
  assert.ok(missing.score < full);
  assert.match(missing.issues[0], /foo/);
});

function wav(samples, sampleRate = 22050) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), 44 + i * 2));
  return buf;
}

test('fft finds a pure tone', () => {
  const n = 1024;
  const re = Float64Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 64 * i) / n));
  const im = new Float64Array(n);
  fft(re, im);
  let best = 0;
  for (let k = 1; k < n / 2; k++) if (Math.hypot(re[k], im[k]) > Math.hypot(re[best], im[best])) best = k;
  assert.equal(best, 64);
});

test('audio analysis measures level, clipping, band balance and pulse', () => {
  const sr = 22050;
  const seconds = 4;
  // 120 bpm clicks of a 100 Hz decaying tone at -12 dB-ish, plus clipped section check below.
  const samples = new Array(sr * seconds).fill(0);
  for (let beat = 0; beat < seconds * 2; beat++) {
    const start = beat * (sr / 2);
    for (let i = 0; i < sr * 0.2; i++) samples[start + i] = 0.5 * Math.exp(-i / (sr * 0.05)) * Math.sin((2 * Math.PI * 100 * i) / sr);
  }
  const decoded = decodeWav(wav(samples, sr));
  assert.equal(decoded.sampleRate, sr);
  const a = analyzeAudio(wav(samples, sr), { cps: 0.5 });
  assert.equal(a.clipRatio, 0);
  assert.ok(a.bands.bass > 0.8, JSON.stringify(a.bands));
  assert.ok(Math.abs(a.tempoEstimateBpm - 120) < 6 || Math.abs(a.tempoEstimateBpm - 60) < 3, `tempo ${a.tempoEstimateBpm}`);
  assert.ok(a.pulseMatchesPattern > 0.3, `pulse ${a.pulseMatchesPattern}`);
  const clipped = analyzeAudio(wav(samples.map((x) => x * 4), sr));
  assert.ok(clipped.clipRatio > 0.001);
});
