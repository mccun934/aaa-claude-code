// Symbolic analysis of a pattern's events (haps): tonality, consonance,
// rhythm, form, melody and texture. Works on the JSON events the renderer
// extracts, so it measures what the code actually plays.

const SYNTHS = new Set([
  'sine', 'sin', 'triangle', 'tri', 'square', 'sqr', 'sawtooth', 'saw', 'supersaw', 'pulse', 'user', 'one',
  'z_sine', 'z_sawtooth', 'z_triangle', 'z_square', 'z_tan', 'bytebeat',
]);
const NOISES = new Set(['white', 'pink', 'brown', 'crackle', 'z_noise', 'sbd']);

const PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
export const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

export function noteToMidi(note) {
  if (typeof note === 'number') return note;
  const m = String(note).trim().match(/^([a-gA-G])([#sbf]*)(-?\d+)?$/);
  if (!m) return undefined;
  let midi = PC[m[1].toLowerCase()];
  for (const acc of m[2]) midi += acc === '#' || acc === 's' ? 1 : -1;
  const octave = m[3] === undefined ? 3 : Number(m[3]);
  return midi + (octave + 1) * 12;
}

export function hapMidi(v) {
  if (v.note !== undefined) return noteToMidi(v.note);
  if (typeof v.freq === 'number' && v.freq > 0) return 69 + 12 * Math.log2(v.freq / 440);
  // Synths treat n as a note number when no note is given.
  const s = typeof v.s === 'string' ? v.s.split(':')[0].toLowerCase() : undefined;
  if (typeof v.n === 'number' && (s === undefined || SYNTHS.has(s))) return v.n;
  return undefined;
}

function sourceOf(v) {
  const s = typeof v.s === 'string' ? v.s.split(':')[0] : v.note !== undefined || v.freq !== undefined ? 'triangle' : 'unknown';
  return v.bank ? `${v.bank}:${s}` : s;
}

const isSilent = (v) => ['~', '-', '_'].includes(v.s) || v.gain === 0;

// Krumhansl-Kessler key profiles.
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];

function pearson(a, b) {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let dbb = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    dbb += (b[i] - mb) ** 2;
  }
  return da && dbb ? num / Math.sqrt(da * dbb) : 0;
}

export function detectKey(hist) {
  let best = { r: -Infinity };
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const [mode, profile, scale] of [
      ['major', KK_MAJOR, MAJOR_SCALE],
      ['minor', KK_MINOR, MINOR_SCALE],
    ]) {
      const rotated = hist.map((_, i) => hist[(i + tonic) % 12]);
      const r = pearson(rotated, profile);
      if (r > best.r) best = { r, tonic, mode, scale: scale.map((x) => (x + tonic) % 12) };
    }
  }
  const total = hist.reduce((s, x) => s + x, 0) || 1;
  const inKey = best.scale.reduce((s, pc) => s + hist[pc], 0) / total;
  return { key: `${NOTE_NAMES[best.tonic]} ${best.mode}`, correlation: best.r, inKeyRatio: inKey };
}

// Perceived roughness per interval class (0 = unison .. 6 = tritone).
const IC_DISSONANCE = [0, 0.9, 0.3, 0.12, 0.08, 0.15, 0.5];

const round = (x, d = 3) => +Number(x).toFixed(d);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
/** Linear ramp: 0 at lo, 1 at hi (works for lo > hi too). */
const ramp = (x, lo, hi) => clamp01((x - lo) / (hi - lo));

function consonance(pitched) {
  // Sweep segment boundaries and measure roughness of simultaneous notes.
  const bounds = [...new Set(pitched.flatMap((h) => [h.begin, h.end]))].sort((a, b) => a - b);
  let weighted = 0;
  let weight = 0;
  let maxPoly = 0;
  for (let i = 0; i + 1 < bounds.length; i++) {
    const [a, b] = [bounds[i], bounds[i + 1]];
    const mid = (a + b) / 2;
    const active = [...new Set(pitched.filter((h) => h.begin <= mid && h.end > mid).map((h) => Math.round(h.midi)))];
    maxPoly = Math.max(maxPoly, active.length);
    if (active.length < 2) continue;
    let d = 0;
    let pairs = 0;
    for (let x = 0; x < active.length; x++) {
      for (let y = x + 1; y < active.length; y++) {
        const ic = Math.abs(active[x] - active[y]) % 12;
        // Close voicings are rougher than the same interval spread out.
        const spread = Math.abs(active[x] - active[y]) > 12 ? 0.6 : 1;
        d += IC_DISSONANCE[Math.min(ic, 12 - ic)] * spread;
        pairs++;
      }
    }
    weighted += (d / pairs) * (b - a);
    weight += b - a;
  }
  return { roughness: weight ? weighted / weight : 0, maxPolyphony: maxPoly, overlapping: weight > 0 };
}

function entropy(counts) {
  const total = counts.reduce((s, x) => s + x, 0);
  if (!total || counts.length < 2) return 0;
  let h = 0;
  for (const c of counts) if (c) h -= (c / total) * Math.log2(c / total);
  return h / Math.log2(counts.length);
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * @param {Array<{begin:number,end:number,value:object}>} haps
 * @param {{cycles:number,cps:number}} ctx
 */
export function analyzeEvents(haps, { cycles, cps }) {
  const events = haps
    .filter((h) => h.begin >= 0 && h.begin < cycles && !isSilent(h.value))
    .map((h) => {
      const midi = hapMidi(h.value);
      const s = typeof h.value.s === 'string' ? h.value.s.split(':')[0].toLowerCase() : undefined;
      return {
        begin: h.begin,
        end: Math.max(h.end, h.begin + 1e-3),
        midi: Number.isFinite(midi) ? midi : undefined,
        source: sourceOf(h.value),
        noise: s !== undefined && NOISES.has(s),
        gain: h.value.gain ?? h.value.velocity ?? 1,
      };
    });
  const seconds = cycles / cps;
  const pitched = events.filter((e) => e.midi !== undefined && !e.noise);
  const unpitched = events.filter((e) => e.midi === undefined || e.noise);

  // --- sources and roles
  const sources = new Map();
  for (const e of events) {
    const s = sources.get(e.source) ?? { name: e.source, events: [], pitched: 0 };
    s.events.push(e);
    if (e.midi !== undefined) s.pitched++;
    sources.set(e.source, s);
  }
  const roles = new Set();
  const voices = [];
  for (const s of sources.values()) {
    const isPitched = s.pitched > s.events.length / 2;
    let role = 'percussion';
    let poly = 1;
    let median;
    if (isPitched) {
      const midis = s.events.map((e) => e.midi).filter((m) => m !== undefined).sort((a, b) => a - b);
      median = midis[Math.floor(midis.length / 2)];
      const onsets = new Map();
      for (const e of s.events) onsets.set(e.begin.toFixed(4), (onsets.get(e.begin.toFixed(4)) ?? 0) + 1);
      poly = [...onsets.values()].reduce((a, b) => a + b, 0) / onsets.size;
      role = median < 52 && poly < 1.8 ? 'bass' : poly >= 1.8 ? 'harmony' : 'melody';
    }
    roles.add(role);
    voices.push({ source: s.name, role, events: s.events.length, medianNote: median, avgPolyphony: round(poly, 2) });
  }

  const metrics = {
    events: events.length,
    eventsPerSecond: round(events.length / seconds, 2),
    voices,
    roles: [...roles],
  };

  // --- tonality
  if (pitched.length >= 4) {
    const hist = new Array(12).fill(0);
    for (const e of pitched) hist[((Math.round(e.midi) % 12) + 12) % 12] += Math.min(e.end - e.begin, 1);
    const key = detectKey(hist);
    metrics.key = key.key;
    metrics.keyCorrelation = round(key.correlation);
    metrics.inKeyRatio = round(key.inKeyRatio);
    const c = consonance(pitched);
    metrics.roughness = round(c.roughness);
    metrics.maxPolyphony = c.maxPolyphony;
    const midis = pitched.map((e) => e.midi);
    metrics.pitchRange = [Math.round(Math.min(...midis)), Math.round(Math.max(...midis))];
    metrics.distinctPitchClasses = hist.filter((x) => x > 0).length;
  }

  // --- melody (monophonic pitched voices)
  const leaps = [];
  for (const v of voices.filter((v) => v.role === 'melody' || v.role === 'bass')) {
    const seq = sources
      .get(v.source)
      .events.filter((e) => e.midi !== undefined)
      .sort((a, b) => a.begin - b.begin);
    if (seq.length < 6) continue;
    for (let i = 1; i < seq.length; i++) leaps.push(Math.abs(seq[i].midi - seq[i - 1].midi));
  }
  if (leaps.length >= 5) {
    metrics.stepwiseRatio = round(leaps.filter((l) => l <= 2).length / leaps.length);
    metrics.bigLeapRatio = round(leaps.filter((l) => l > 12).length / leaps.length);
  }

  // --- rhythm
  const onsets = [...new Set(events.map((e) => round(e.begin, 5)))].sort((a, b) => a - b);
  const offGrid = (t) => {
    const f = t - Math.floor(t);
    return Math.min(...[16, 12, 24].map((g) => Math.abs(f * g - Math.round(f * g)) / g)) > 0.004;
  };
  metrics.onGridRatio = onsets.length ? round(onsets.filter((t) => !offGrid(t)).length / onsets.length) : 0;
  const iois = [];
  for (let i = 1; i < onsets.length; i++) iois.push(Math.round((onsets[i] - onsets[i - 1]) * 48));
  const ioiCounts = new Map();
  for (const x of iois) ioiCounts.set(x, (ioiCounts.get(x) ?? 0) + 1);
  // Normalized over the 12 most common values so dense grooves don't read as noise.
  const topCounts = [...ioiCounts.values()].sort((a, b) => b - a);
  metrics.ioiEntropy = round(entropy([...topCounts.slice(0, 12), ...new Array(Math.max(0, 12 - topCounts.length)).fill(0)]));
  metrics.distinctIois = ioiCounts.size;
  let beatsHit = 0;
  for (let c = 0; c < cycles; c++) {
    for (const q of [0, 0.25, 0.5, 0.75]) if (onsets.some((t) => Math.abs(t - (c + q)) < 0.01)) beatsHit++;
  }
  metrics.beatCoverage = round(beatsHit / (cycles * 4));

  // --- form: per-cycle fingerprints
  const prints = Array.from({ length: cycles }, () => new Set());
  for (const e of events) {
    const c = Math.floor(e.begin);
    if (c < cycles) prints[c].add(`${Math.round((e.begin - c) * 48)}|${e.source}|${e.midi === undefined ? '' : Math.round(e.midi)}`);
  }
  const nonEmpty = prints.filter((p) => p.size).length;
  metrics.activeCycles = nonEmpty;
  const lagSim = {};
  for (const lag of [1, 2, 4, 8]) {
    if (lag >= cycles) continue;
    let s = 0;
    for (let i = 0; i + lag < cycles; i++) s += jaccard(prints[i], prints[i + lag]);
    lagSim[lag] = round(s / (cycles - lag));
  }
  metrics.cycleSimilarity = lagSim;
  metrics.repetition = Math.max(0, ...Object.values(lagSim));
  metrics.distinctCycles = new Set(prints.map((p) => [...p].sort().join(','))).size;
  const half = Math.floor(cycles / 2);
  const firstHalf = new Set(prints.slice(0, half).flatMap((p) => [...p]));
  const secondHalf = new Set(prints.slice(half).flatMap((p) => [...p]));
  metrics.halfSimilarity = round(jaccard(firstHalf, secondHalf));

  // --- dynamics
  const gains = events.map((e) => (typeof e.gain === 'number' ? e.gain : 1));
  metrics.dynamicVariety = new Set(gains.map((g) => g.toFixed(2))).size > 1;

  return { metrics, pitchedCount: pitched.length, unpitchedCount: unpitched.length, _events: events };
}

export const PROFILES = {
  default: {
    description: 'General purpose: expects a groove, some harmony, repetition with variation.',
    density: [1, 3, 18, 32],
    needsPulse: true,
    maxSilence: 0.25,
  },
  dance: {
    description: 'House/techno/DnB/etc.: steady strong pulse, drums + bass required, denser.',
    density: [2, 5, 26, 40],
    needsPulse: true,
    requireRoles: ['percussion', 'bass'],
    maxSilence: 0.12,
  },
  ambient: {
    description: 'Ambient/drone/soundscape: sparse is fine, no drums required, slow evolution.',
    density: [0.1, 0.4, 10, 22],
    needsPulse: false,
    allowUnpitched: true,
    maxSilence: 0.45,
  },
  drums: {
    description: 'Drum loop / beat only (the user asked for just drums or a break).',
    density: [1, 3, 20, 34],
    needsPulse: true,
    allowUnpitched: true,
    maxSilence: 0.25,
  },
  chill: {
    description: 'Lo-fi/downtempo/hip-hop: relaxed pulse, swing welcome, moderate density.',
    density: [0.8, 2, 14, 26],
    needsPulse: true,
    maxSilence: 0.25,
  },
};

const trapezoid = (x, [a, b, c, d]) => (x <= a || x >= d ? 0 : x < b ? (x - a) / (b - a) : x <= c ? 1 : (d - x) / (d - c));

/**
 * Combine symbolic + audio metrics into sub-scores (0..1), an overall score
 * (0..100) and actionable issues.
 */
export function scoreMusicality({ ok, error, missingSounds = [], events, audio, renderError }, { profile = 'default' } = {}) {
  const prof = PROFILES[profile] ?? PROFILES.default;
  const issues = [];
  if (!ok) return { score: 0, pass: false, subscores: {}, issues: [`Code failed to evaluate: ${error}`] };
  const m = events?.metrics;
  if (!m || m.events === 0) return { score: 0, pass: false, subscores: {}, issues: ['Pattern produces no events in the analysed cycles.'] };

  const sub = {};
  const w = {};
  const add = (name, value, weight, issue) => {
    if (value === undefined || Number.isNaN(value)) return;
    sub[name] = round(clamp01(value), 2);
    w[name] = weight;
    if (issue && value < 0.6) issues.push(issue);
  };

  // Harmony
  if (m.keyCorrelation !== undefined) {
    add('tonalCenter', 0.5 * ramp(m.keyCorrelation, 0.35, 0.8) + 0.5 * ramp(m.inKeyRatio, 0.7, 0.95), 0.12,
      `Weak tonal center (best key ${m.key}, r=${m.keyCorrelation}, ${Math.round(m.inKeyRatio * 100)}% in key). Use .scale("C:minor") / n() degrees, or chord symbols with .voicing(), so all parts share a key.`);
    add('consonance', ramp(m.roughness, 0.34, 0.2), 0.12,
      `Harsh simultaneous intervals (roughness ${m.roughness}). Avoid stacked minor 2nds/tritones between parts; use voicings or spread chord tones.`);
    if (m.maxPolyphony > 10) issues.push(`Up to ${m.maxPolyphony} simultaneous pitched notes, likely muddy. Thin the chords or shorten the release.`);
  } else if (!prof.allowUnpitched) {
    add('harmonicContent', 0, 0.1, 'No pitched material (bass, chords or melody). Add harmonic parts, or use the "drums" profile if a beat alone is what was asked for.');
  }
  if (m.stepwiseRatio !== undefined) {
    add('melodicContour', 0.7 * ramp(m.stepwiseRatio, 0.15, 0.5) + 0.3 * ramp(m.bigLeapRatio, 0.3, 0.05), 0.06,
      `Melodic lines jump around (only ${Math.round(m.stepwiseRatio * 100)}% stepwise, ${Math.round(m.bigLeapRatio * 100)}% leaps over an octave). Favor steps and small leaps.`);
  }

  // Rhythm
  add('rhythmicGrid', ramp(m.onGridRatio, 0.55, 0.9), 0.08,
    `${Math.round((1 - m.onGridRatio) * 100)}% of onsets fall off the 16th/triplet grid. Unless intentional (swing/nudge), align rhythms.`);
  add('rhythmicCoherence', ramp(m.ioiEntropy, 0.97, 0.75), 0.06,
    `Inter-onset intervals are near-random (entropy ${m.ioiEntropy}). Use repeating rhythmic cells (e.g. "x ~ x x", euclid (3,8)).`);
  if (prof.needsPulse) {
    const pulse = audio?.pulseMatchesPattern ?? null;
    const beat = ramp(m.beatCoverage, 0.25, 0.75);
    add('pulse', pulse === null ? beat : 0.5 * beat + 0.5 * ramp(pulse, 0.05, 0.35), 0.08,
      `Weak pulse (${Math.round(m.beatCoverage * 100)}% of beats articulated${pulse !== null ? `, audio beat match ${pulse}` : ''}). Anchor the beat with a kick/hat pattern or a steady bass.`);
  }

  // Form
  add('repetition', ramp(m.repetition, 0.15, 0.55), 0.12,
    `Little repetition between cycles (max similarity ${m.repetition}). Music needs recognisable motifs: repeat patterns with <> alternation or .slow().`);
  const variation = m.distinctCycles >= 3 ? 1 : m.distinctCycles === 2 ? 0.8 : 0.45;
  add('variation', variation * (m.halfSimilarity > 0.98 && m.distinctCycles < 3 ? 0.9 : 1), 0.08,
    `Every cycle is identical (${m.distinctCycles} distinct of ${m.activeCycles}). Add variation: "<a b>" alternation, .every(4, ...), .sometimes(), .mask("<1 [1 0]>"), filter sweeps.`);

  // Texture
  const required = prof.requireRoles ?? [];
  const missingRoles = required.filter((r) => !m.roles.includes(r));
  add('layering', Math.min(1, m.roles.length / 3) * (missingRoles.length ? 0.5 : 1), 0.08,
    `Thin arrangement (roles: ${m.roles.join(', ')}${missingRoles.length ? `; missing ${missingRoles.join(', ')}` : ''}). Combine drums, bass, harmony and melody with stack().`);
  add('density', trapezoid(m.eventsPerSecond, prof.density), 0.06,
    m.eventsPerSecond > prof.density[2]
      ? `Very dense (${m.eventsPerSecond} events/s). Remove layers or use .degradeBy()/.mask().`
      : `Sparse (${m.eventsPerSecond} events/s). Add rhythmic layers or subdivisions.`);

  // Mix (audio)
  if (audio) {
    add('loudness', trapezoid(audio.rmsDb, [-45, -28, -9, -3]), 0.05,
      audio.rmsDb > -9 ? `Too loud (RMS ${audio.rmsDb} dBFS). Lower gain/.postgain().` : `Too quiet (RMS ${audio.rmsDb} dBFS). Raise .gain().`);
    add('noClipping', ramp(audio.clipRatio, 0.01, 0.0002), 0.05,
      `Clipping (${(audio.clipRatio * 100).toFixed(2)}% of samples at full scale). Reduce gain, distortion or number of layers.`);
    add('continuity', ramp(audio.silenceRatio, prof.maxSilence + 0.3, prof.maxSilence), 0.03,
      `${Math.round(audio.silenceRatio * 100)}% of the render is silent. Check for parts that never sound or long gaps.`);
    const b = audio.bands;
    const low = b.sub + b.bass;
    const top = b.highMid + b.high;
    add('spectralBalance', 1 - Math.max(0, low - 0.8) * 4 - Math.max(0, top - 0.55) * 3 - (b.lowMid + b.highMid < 0.06 ? 0.4 : 0), 0.03,
      `Unbalanced spectrum (sub+bass ${Math.round(low * 100)}%, mids ${Math.round((b.lowMid + b.highMid) * 100)}%, highs ${Math.round(top * 100)}%). Use .lpf/.hpf and gain to rebalance.`);
  } else if (renderError) {
    issues.push(`Audio render failed: ${renderError}`);
  }

  const total = Object.keys(sub).reduce((s, k) => s + w[k], 0);
  let score = (100 * Object.keys(sub).reduce((s, k) => s + sub[k] * w[k], 0)) / (total || 1);
  if (missingSounds.length) {
    score *= Math.max(0.25, 1 - 0.25 * missingSounds.length);
    issues.unshift(`Sounds not found (these parts are silent): ${missingSounds.join(', ')}. Use find_sounds to pick valid names, or load the pack with samples('github:...').`);
  }
  if (m.roughness > 0.35) score *= 0.8;
  if (audio) score *= 1 - 0.5 * ramp(audio.clipRatio, 0.003, 0.05);
  if (audio && audio.rmsDb < -60) {
    score *= 0.2;
    issues.unshift('The render is (nearly) silent.');
  }
  score = Math.round(score);
  return { score, profile: PROFILES[profile] ? profile : 'default', subscores: sub, weights: w, issues };
}
