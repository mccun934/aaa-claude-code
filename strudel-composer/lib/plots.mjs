// PNG visualisations Claude can "look at": a log-frequency spectrogram of
// the rendered audio and a piano roll of the pattern's events.
import { PNG } from 'pngjs';

// Compact perceptual colormap (inferno-like) from dark to bright.
const STOPS = [
  [0, [0, 0, 4]],
  [0.25, [87, 16, 110]],
  [0.5, [188, 55, 84]],
  [0.75, [249, 142, 9]],
  [1, [252, 255, 164]],
];
function colormap(t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < STOPS.length; i++) {
    const [t1, c1] = STOPS[i];
    const [t0, c0] = STOPS[i - 1];
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return c0.map((v, k) => Math.round(v + (c1[k] - v) * f));
    }
  }
  return STOPS.at(-1)[1];
}

function canvas(width, height, bg = [16, 16, 20]) {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = bg[0];
    png.data[i * 4 + 1] = bg[1];
    png.data[i * 4 + 2] = bg[2];
    png.data[i * 4 + 3] = 255;
  }
  const set = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
  };
  return { png, set };
}

/** Log-frequency spectrogram (40 Hz - 16 kHz) with cycle markers. */
export function spectrogramPng(spec, { cps, width = 900, height = 300 } = {}) {
  const { frames, binHz, frameRate } = spec;
  const { png, set } = canvas(width, height);
  const fMin = 40;
  const fMax = Math.min(16000, (frames[0]?.length ?? 1) * binHz);
  const rowBins = Array.from({ length: height }, (_, y) => {
    const f0 = fMin * (fMax / fMin) ** ((height - 1 - y) / height);
    const f1 = fMin * (fMax / fMin) ** ((height - y) / height);
    return [Math.max(1, Math.floor(f0 / binHz)), Math.max(1, Math.ceil(f1 / binHz))];
  });
  // Normalize to the loudest bin so quiet and loud renders both use the full color range.
  let maxMag = 1e-9;
  for (const f of frames) for (const v of f) if (v > maxMag) maxMag = v;
  const topDb = 20 * Math.log10(maxMag);
  for (let x = 0; x < width; x++) {
    const fi0 = Math.floor((x / width) * frames.length);
    const fi1 = Math.max(fi0 + 1, Math.floor(((x + 1) / width) * frames.length));
    for (let y = 0; y < height; y++) {
      const [b0, b1] = rowBins[y];
      let peak = 0;
      for (let fi = fi0; fi < fi1 && fi < frames.length; fi++) {
        for (let b = b0; b <= b1 && b < frames[fi].length; b++) peak = Math.max(peak, frames[fi][b]);
      }
      const dbv = 20 * Math.log10(peak + 1e-9);
      set(x, y, colormap((dbv - topDb + 75) / 75));
    }
  }
  // Cycle boundaries and 1 kHz / 100 Hz reference lines.
  if (cps) {
    const totalSec = frames.length / frameRate;
    for (let c = 1; c < totalSec * cps; c++) {
      const x = Math.round(((c / cps) / totalSec) * width);
      for (let y = 0; y < height; y += 3) set(x, y, [90, 200, 255]);
    }
  }
  for (const hz of [100, 1000, 10000]) {
    if (hz > fMax) continue;
    const y = Math.round(height - 1 - (Math.log(hz / fMin) / Math.log(fMax / fMin)) * height);
    for (let x = 0; x < width; x += 4) set(x, y, [120, 255, 120]);
  }
  return PNG.sync.write(png);
}

const PALETTE = [
  [255, 99, 132], [54, 162, 235], [255, 206, 86], [75, 192, 192], [153, 102, 255],
  [255, 159, 64], [46, 204, 113], [231, 76, 60], [241, 196, 15], [149, 165, 166],
];

/**
 * Piano roll: pitched events by MIDI note, unpitched sources as separate
 * lanes at the bottom. One color per source.
 */
export function pianoRollPng(events, { cycles, width = 900, height = 360 } = {}) {
  const { png, set } = canvas(width, height);
  const sources = [...new Set(events.map((e) => e.source))];
  const color = (s) => PALETTE[sources.indexOf(s) % PALETTE.length];
  const pitched = events.filter((e) => e.midi !== undefined);
  const drums = events.filter((e) => e.midi === undefined);
  const drumSources = [...new Set(drums.map((e) => e.source))];
  const laneH = drumSources.length ? Math.min(14, Math.floor(height * 0.3 / drumSources.length)) : 0;
  const drumTop = height - laneH * drumSources.length;
  const midis = pitched.map((e) => e.midi);
  const lo = Math.floor(Math.min(...midis, 60)) - 2;
  const hi = Math.ceil(Math.max(...midis, 72)) + 2;
  const noteH = Math.max(1, Math.floor((drumTop - 4) / (hi - lo)));
  const xOf = (t) => Math.round((t / cycles) * width);
  // Grid: cycle lines and C notes.
  for (let c = 0; c <= cycles; c++) for (let y = 0; y < height; y++) set(Math.min(width - 1, xOf(c)), y, [70, 70, 80]);
  for (let m = lo; m <= hi; m++) {
    if (m % 12 !== 0) continue;
    const y = drumTop - 4 - (m - lo) * noteH;
    for (let x = 0; x < width; x += 2) set(x, y, [50, 50, 60]);
  }
  for (const e of pitched) {
    const y0 = drumTop - 4 - Math.round((e.midi - lo + 1) * noteH);
    const x0 = xOf(e.begin);
    const x1 = Math.max(x0 + 2, xOf(Math.min(e.end, cycles)) - 1);
    for (let x = x0; x < x1; x++) for (let y = y0; y < y0 + Math.max(2, noteH); y++) set(x, y, color(e.source));
  }
  drums.forEach((e) => {
    const lane = drumSources.indexOf(e.source);
    const y0 = drumTop + lane * laneH + 1;
    const x0 = xOf(e.begin);
    for (let x = x0; x < x0 + 3; x++) for (let y = y0; y < y0 + laneH - 2; y++) set(x, y, color(e.source));
  });
  return { png: PNG.sync.write(png), legend: sources.map((s, i) => ({ source: s, color: `rgb(${PALETTE[i % PALETTE.length].join(',')})` })) };
}
