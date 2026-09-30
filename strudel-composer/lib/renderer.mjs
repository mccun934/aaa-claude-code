// Drives a headless Chromium page that runs the real Strudel engine
// (@strudel/repl) to evaluate patterns, extract events and render audio.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright-core';
import { PUBLIC_DIR, CACHE_DIR, STRUDEL_REPL_DIST } from './paths.mjs';

// Nothing listens here: every request to this origin is fulfilled from disk
// by page.route. A localhost origin keeps the page a secure context, which
// AudioWorklet requires.
const LOCAL_ORIGIN = 'http://localhost:47999';

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};

function chromiumExecutable() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const pwPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (pwPath && existsSync(path.join(pwPath, 'chromium'))) return path.join(pwPath, 'chromium');
  return undefined; // fall back to playwright's own browser install
}

// Disk cache for sample maps, samples and soundfonts so repeated renders
// don't re-download audio from GitHub.
class NetCache {
  constructor(dir) {
    this.dir = dir;
  }
  file(url) {
    return path.join(this.dir, crypto.createHash('sha256').update(url).digest('hex'));
  }
  async get(url) {
    try {
      const meta = JSON.parse(await fs.readFile(this.file(url) + '.json', 'utf8'));
      return { ...meta, body: await fs.readFile(this.file(url)) };
    } catch {
      return null;
    }
  }
  async put(url, contentType, body) {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.file(url), body);
    await fs.writeFile(this.file(url) + '.json', JSON.stringify({ url, contentType }));
  }
}

async function fetchWithRetry(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 300 * 2 ** i));
    }
  }
  throw lastErr;
}

export class StrudelRenderer {
  constructor({ timeoutMs = 90_000, log = () => {} } = {}) {
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.cache = new NetCache(path.join(CACHE_DIR, 'net'));
    this.queue = Promise.resolve();
    this.browser = null;
    this.page = null;
    this.fetchFailures = [];
    this.failedUrls = new Set(); // across runs: the page caches failed loads and won't refetch
  }

  async #serveLocal(route, url) {
    let rel = decodeURIComponent(url.pathname);
    let file;
    if (rel.startsWith('/vendor/strudel-repl/')) {
      file = path.join(STRUDEL_REPL_DIST, rel.slice('/vendor/strudel-repl/'.length));
    } else {
      file = path.join(PUBLIC_DIR, rel);
    }
    const base = rel.startsWith('/vendor/') ? STRUDEL_REPL_DIST : PUBLIC_DIR;
    if (!path.resolve(file).startsWith(base)) return route.fulfill({ status: 403, body: 'forbidden' });
    try {
      const body = await fs.readFile(file);
      return route.fulfill({ status: 200, body, contentType: MIME[path.extname(file)] || 'application/octet-stream' });
    } catch {
      return route.fulfill({ status: 404, body: 'not found' });
    }
  }

  async #serveRemote(route, url) {
    const href = url.href;
    const req = route.request();
    if (req.method() !== 'GET') return route.continue();
    const headers = { 'access-control-allow-origin': '*' };
    const cached = await this.cache.get(href);
    if (cached) {
      return route.fulfill({ status: 200, body: cached.body, headers: { ...headers, 'content-type': cached.contentType } });
    }
    try {
      const res = await fetchWithRetry(href);
      const body = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get('content-type') || 'application/octet-stream';
      if (res.status === 200) await this.cache.put(href, contentType, body);
      else this.#failed(`${href} (HTTP ${res.status})`);
      return route.fulfill({ status: res.status, body, headers: { ...headers, 'content-type': contentType } });
    } catch (err) {
      this.log(`[renderer] fetch failed ${href}: ${err.message}`);
      this.#failed(`${href} (${err.message})`);
      return route.abort('failed');
    }
  }

  #failed(entry) {
    this.fetchFailures.push(entry);
    this.failedUrls.add(entry);
  }

  async start() {
    if (this.page) return;
    this.browser = await chromium.launch({
      executablePath: chromiumExecutable(),
      args: ['--autoplay-policy=no-user-gesture-required'],
    });
    const context = await this.browser.newContext();
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      return url.origin === LOCAL_ORIGIN ? this.#serveLocal(route, url) : this.#serveRemote(route, url);
    });
    this.page = await context.newPage();
    this.page.on('pageerror', (err) => this.log(`[renderer] page error: ${err.message}`));
    await this.page.goto(`${LOCAL_ORIGIN}/render/index.html`);
    const info = await this.page.evaluate(() => window.__ready);
    this.log(`[renderer] ready, ${info.sounds} sounds registered`);
  }

  async stop() {
    const b = this.browser;
    this.browser = null;
    this.page = null;
    await b?.close();
  }

  #enqueue(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async #withTimeout(promise) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`render timed out after ${this.timeoutMs} ms`)), this.timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** List every sound registered in the editor (synths, samples, soundfonts). */
  sounds() {
    return this.#enqueue(async () => {
      await this.start();
      return this.page.evaluate(() => window.__sounds());
    });
  }

  /**
   * Evaluate Strudel code and (optionally) render it to audio.
   * Resolves to { ok, error?, cps, cycles, haps, missingSounds, logs, wav?: Buffer }.
   */
  run(code, { cycles = 8, render = true, sampleRate = 44100 } = {}) {
    return this.#enqueue(async () => {
      await this.start();
      this.fetchFailures = [];
      let result;
      try {
        result = await this.#withTimeout(
          this.page.evaluate(([c, opts]) => window.__run(c, opts), [code, { cycles, render, sampleRate }]),
        );
      } catch (err) {
        // A hung or crashed page gets replaced so the next run starts clean.
        await this.stop().catch(() => {});
        return { ok: false, error: err.message, logs: [] };
      }
      const decodeErrors = (result.logs ?? []).some((l) => /unable to decode|error loading/i.test(l.message));
      if (this.fetchFailures.length) result.fetchFailures = [...new Set(this.fetchFailures)];
      else if (decodeErrors && this.failedUrls.size) result.fetchFailures = [...this.failedUrls].map((u) => `${u} (failed earlier, cached)`);
      if (result.wavBase64) {
        result.wav = Buffer.from(result.wavBase64, 'base64');
        delete result.wavBase64;
      }
      return result;
    });
  }
}

let shared;
/** Process-wide renderer instance (one browser, serialized jobs). */
export function getRenderer(opts) {
  shared ??= new StrudelRenderer(opts);
  return shared;
}
