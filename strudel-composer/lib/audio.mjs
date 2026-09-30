// Audio feature extraction for rendered WAVs: loudness, clipping, spectral
// balance and pulse/tempo from an onset envelope. Pure JS, no native deps.

export function decodeWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let off = 12;
  let fmt;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitDepth: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('data chunk before fmt chunk');
      const { format, channels, bitDepth } = fmt;
      const bytes = bitDepth / 8;
      const frames = Math.floor(Math.min(size, buf.length - body) / (bytes * channels));
      const data = Array.from({ length: channels }, () => new Float32Array(frames));
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < channels; c++) {
          const p = body + (i * channels + c) * bytes;
          data[c][i] = format === 3 ? buf.readFloatLE(p) : bitDepth === 16 ? buf.readInt16LE(p) / 32768 : buf.readInt32LE(p) / 2147483648;
        }
      }
      return { sampleRate: fmt.sampleRate, channels: data };
    }
    off = body + size + (size % 2);
  }
  throw new Error('no data chunk');
}

// In-place iterative radix-2 FFT.
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}

const db = (x) => 20 * Math.log10(Math.max(x, 1e-9));
const percentile = (arr, p) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

export const BANDS = [
  ['sub', 20, 60],
  ['bass', 60, 250],
  ['lowMid', 250, 2000],
  ['highMid', 2000, 6000],
  ['high', 6000, 20000],
];

/**
 * Short-time spectrum of a mono signal. Returns per-frame magnitude spectra
 * plus framing info; shared by feature extraction and the spectrogram plot.
 */
export function stft(mono, sampleRate, { size = 2048, hop = 1024 } = {}) {
  const win = new Float32Array(size).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
  const frames = [];
  const rms = [];
  for (let start = 0; start + size <= mono.length; start += hop) {
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    let sq = 0;
    for (let i = 0; i < size; i++) {
      const x = mono[start + i];
      sq += x * x;
      re[i] = x * win[i];
    }
    fft(re, im);
    const mag = new Float32Array(size / 2);
    for (let k = 0; k < size / 2; k++) mag[k] = Math.hypot(re[k], im[k]) / (size / 4);
    frames.push(mag);
    rms.push(Math.sqrt(sq / size));
  }
  return { frames, rms, size, hop, sampleRate, binHz: sampleRate / size, frameRate: sampleRate / hop };
}

function autocorr(x, maxLag) {
  const n = x.length;
  const mean = x.reduce((s, v) => s + v, 0) / n;
  const y = x.map((v) => v - mean);
  const out = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += y[i] * y[i + lag];
    out[lag] = s;
  }
  return out;
}

/**
 * @param {Buffer} wav
 * @param {{cps?: number}} opts cps lets us check the audio pulse against the pattern tempo
 */
export function analyzeAudio(wav, { cps } = {}) {
  const { sampleRate, channels } = decodeWav(wav);
  const n = channels[0].length;
  const mono = new Float32Array(n);
  let peak = 0;
  let clipped = 0;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (const ch of channels) {
      const v = ch[i];
      m += v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      if (a >= 0.999) clipped++;
    }
    m /= channels.length;
    mono[i] = m;
    sq += m * m;
  }
  const duration = n / sampleRate;
  const rmsDb = db(Math.sqrt(sq / Math.max(1, n)));
  const spec = stft(mono, sampleRate);
  const frameDb = spec.rms.map(db);
  const silentFrames = frameDb.filter((d) => d < -50).length;
  const active = frameDb.filter((d) => d >= -50);

  // Spectral balance, centroid and flatness over non-silent frames.
  const bandEnergy = Object.fromEntries(BANDS.map(([name]) => [name, 0]));
  let centroidSum = 0;
  let flatnessSum = 0;
  let counted = 0;
  const flux = [];
  let prev;
  spec.frames.forEach((mag, fi) => {
    let f = 0;
    if (prev) for (let k = 0; k < mag.length; k++) f += Math.max(0, Math.log1p(1000 * mag[k]) - Math.log1p(1000 * prev[k]));
    flux.push(f);
    prev = mag;
    if (frameDb[fi] < -50) return;
    let total = 0;
    let weighted = 0;
    let logSum = 0;
    for (let k = 1; k < mag.length; k++) {
      const p = mag[k] * mag[k];
      const hz = k * spec.binHz;
      total += p;
      weighted += p * hz;
      logSum += Math.log(p + 1e-12);
      for (const [name, lo, hi] of BANDS) if (hz >= lo && hz < hi) bandEnergy[name] += p;
    }
    if (total > 0) {
      centroidSum += weighted / total;
      flatnessSum += Math.exp(logSum / (mag.length - 1)) / (total / (mag.length - 1));
      counted++;
    }
  });
  const bandTotal = Object.values(bandEnergy).reduce((s, v) => s + v, 0) || 1;
  const bands = Object.fromEntries(Object.entries(bandEnergy).map(([k, v]) => [k, +(v / bandTotal).toFixed(3)]));

  // Pulse: autocorrelation of the onset (spectral flux) envelope.
  const fr = spec.frameRate;
  const minLag = Math.max(1, Math.floor((fr * 60) / 200));
  const maxLag = Math.min(flux.length - 1, Math.ceil((fr * 60) / 50));
  let tempo = null;
  let pulseClarity = 0;
  let expectedBeatMatch = null;
  if (maxLag > minLag + 2) {
    const ac = autocorr(flux, maxLag);
    let best = minLag;
    for (let l = minLag; l <= maxLag; l++) if (ac[l] > ac[best]) best = l;
    pulseClarity = ac[0] > 0 ? Math.max(0, ac[best] / ac[0]) : 0;
    tempo = +((60 * fr) / best).toFixed(1);
    if (cps) {
      // How strongly does the envelope repeat at the pattern's own
      // subdivisions (1/2, 1/4, 1/8 cycle)? High values mean the audio
      // grooves in time with the code.
      const lagsFor = [2, 4, 8].map((d) => Math.round(fr / cps / d)).filter((l) => l > 0 && l <= maxLag);
      if (lagsFor.length && ac[0] > 0) expectedBeatMatch = +Math.max(...lagsFor.map((l) => ac[l] / ac[0])).toFixed(3);
    }
  }

  return {
    duration: +duration.toFixed(2),
    sampleRate,
    rmsDb: +rmsDb.toFixed(1),
    peakDb: +db(peak).toFixed(1),
    crestDb: +(db(peak) - rmsDb).toFixed(1),
    clipRatio: +(clipped / Math.max(1, n * channels.length)).toFixed(5),
    silenceRatio: +(silentFrames / Math.max(1, frameDb.length)).toFixed(3),
    loudnessRangeDb: active.length ? +(percentile(active, 0.95) - percentile(active, 0.1)).toFixed(1) : 0,
    spectralCentroidHz: counted ? Math.round(centroidSum / counted) : 0,
    spectralFlatness: counted ? +(flatnessSum / counted).toFixed(3) : 0,
    bands,
    tempoEstimateBpm: tempo,
    pulseClarity: +pulseClarity.toFixed(3),
    pulseMatchesPattern: expectedBeatMatch,
    _spec: spec,
  };
}
