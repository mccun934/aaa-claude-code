// Headless render harness. Loaded by lib/renderer.mjs inside Chromium.
// It hosts the same <strudel-editor> the web UI uses, so tests run
// exactly the engine, sample maps and soundfonts the user will hear.

const el = document.getElementById('ed');
const logs = [];
document.addEventListener('strudel.log', (e) => {
  const { message, type } = e.detail || {};
  logs.push({ message: String(message ?? ''), type: type || 'info' });
  if (logs.length > 500) logs.shift();
});

let baselineSounds;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function soundCountSettled() {
  // Sample maps load asynchronously after prebake resolves. Wait until the
  // registry stops growing so lookups of e.g. RolandTR909_bd are reliable.
  let last = -1;
  let stable = 0;
  for (let i = 0; i < 200 && stable < 4; i++) {
    const n = Object.keys(window.soundMap?.get?.() ?? {}).length;
    stable = n === last && n > 0 ? stable + 1 : 0;
    last = n;
    await sleep(250);
  }
  return last;
}

window.__ready = (async () => {
  while (!el.editor) await sleep(50);
  await el.editor.prebaked;
  const sounds = await soundCountSettled();
  baselineSounds = { ...window.soundMap.get() };
  return { sounds };
})();

function plain(value) {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' ? undefined : value;
  }
  const out = Array.isArray(value) ? [] : {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'function') continue;
    if (v && typeof v === 'object') {
      if (Array.isArray(v) && v.every((x) => typeof x !== 'object')) out[k] = v;
      continue;
    }
    out[k] = v;
  }
  return out;
}

function serializeHap(hap) {
  const value = typeof hap.value === 'object' ? plain(hap.value) : { value: hap.value };
  return {
    begin: hap.whole.begin.valueOf(),
    end: hap.whole.end.valueOf(),
    value,
  };
}

window.__sounds = () => {
  const map = window.soundMap.get();
  return Object.entries(map).map(([name, { data }]) => {
    let count = 0;
    if (data?.type === 'sample') {
      count = Array.isArray(data.samples) ? data.samples.length : Object.keys(data.samples || {}).length;
    } else if (data?.type === 'soundfont') {
      count = data.fonts?.length ?? 0;
    }
    return { name, type: data?.type ?? 'unknown', count, pitched: data?.type === 'sample' && !Array.isArray(data.samples) };
  });
};

function findMissingSounds(haps) {
  const map = window.soundMap.get();
  const missing = new Set();
  for (const h of haps) {
    const { s, bank } = h.value;
    if (typeof s !== 'string' || ['-', '~', '_'].includes(s)) continue;
    const key = (bank ? `${bank}_${s}` : s).toLowerCase();
    if (!map[key] && !map[s.toLowerCase()]) missing.add(bank ? `${s} (bank ${bank})` : s);
  }
  return [...missing];
}

async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

async function renderWav(pattern, cps, cycles, sampleRate) {
  const origCreate = URL.createObjectURL;
  const origClick = HTMLAnchorElement.prototype.click;
  let blob;
  URL.createObjectURL = (b) => {
    blob = b;
    return origCreate.call(URL, b);
  };
  // renderPatternAudio triggers a file download; swallow it.
  HTMLAnchorElement.prototype.click = function () {
    if (!this.download) return origClick.call(this);
  };
  try {
    await window.renderPatternAudio(pattern, cps, 0, cycles, sampleRate, 128, false, 'render');
  } finally {
    URL.createObjectURL = origCreate;
    HTMLAnchorElement.prototype.click = origClick;
  }
  if (!blob) throw new Error('renderer produced no audio');
  return blobToBase64(blob);
}

window.__run = async (code, { cycles = 8, render = true, sampleRate = 44100 } = {}) => {
  await window.__ready;
  const repl = el.editor.repl;
  // Songs may call samples({...}) and shadow built-in names like "bd";
  // start every run from the stock registry so runs can't affect each other.
  window.soundMap.set({ ...baselineSounds });
  logs.length = 0;
  const t0 = performance.now();
  let pattern;
  try {
    pattern = await repl.evaluate(code, false);
  } catch (err) {
    return { ok: false, error: String(err?.message || err), logs: [...logs] };
  }
  if (!pattern) {
    const err = repl.state?.evalError;
    return { ok: false, error: String(err?.message || err || 'code did not produce a pattern'), logs: [...logs] };
  }
  const cps = repl.scheduler.cps;
  let haps;
  try {
    haps = pattern
      .queryArc(0, cycles)
      .filter((h) => h.hasOnset())
      .map(serializeHap);
  } catch (err) {
    return { ok: false, error: `query failed: ${err?.message || err}`, logs: [...logs] };
  }
  const result = {
    ok: true,
    cps,
    cycles,
    haps,
    missingSounds: findMissingSounds(haps),
    evalMs: performance.now() - t0,
  };
  if (render && haps.length) {
    const t1 = performance.now();
    try {
      result.wavBase64 = await renderWav(pattern, cps, cycles, sampleRate);
      result.renderMs = performance.now() - t1;
    } catch (err) {
      result.renderError = String(err?.message || err);
    }
  }
  result.logs = [...logs];
  return result;
};
