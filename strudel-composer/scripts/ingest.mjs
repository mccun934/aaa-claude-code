#!/usr/bin/env node
// Builds the music agent's knowledge base in knowledge/:
//   docs.json      - strudel.cc learn/recipes/understand/workshop pages, chunked by heading
//   functions.json - API reference parsed from the JSDoc in Strudel's source
//   examples.json  - full example tunes + drum patterns from the Strudel repo
//   sounds.json    - every sound the editor registers + external loop/break sample packs
//   SOURCES.md     - provenance (commit, URLs, licenses)
//
// Usage: npm run ingest [-- --skip-sounds] [-- --src /path/to/strudel/checkout]
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CACHE_DIR, KNOWLEDGE_DIR } from '../lib/paths.mjs';
import { StrudelRenderer } from '../lib/renderer.mjs';

const STRUDEL_GIT = 'https://codeberg.org/uzu/strudel.git';
const DOC_SECTIONS = ['learn', 'recipes', 'understand', 'workshop', 'functions'];

// Community sample packs loadable with samples('github:<repo>'). Loop/break
// packs get their audio probed for duration so the agent can pick
// .loopAt()/.fit() values.
const EXTRA_PACKS = [
  { repo: 'tidalcycles/dirt-samples', loops: /^(break|amen)/, note: 'Full SuperDirt library (~200 banks) incl. breaks125/152/157/165 and amencutup.' },
  { repo: 'yaxu/clean-breaks', loops: /.*/, note: 'Classic drum breaks, cleaned up. One break per bank; use .fit() or .loopAt().' },
  { repo: 'switchangel/breaks', loops: /.*/, note: 'Breakbeat loops (bank "breaks").' },
  { repo: 'Bubobubobubobubo/Dough-Amen', loops: /.*/, note: 'Amen break variations.' },
  { repo: 'eddyflux/wax', loops: /.*/, note: 'Vinyl-style loops and textures.' },
  { repo: 'eddyflux/crate', note: 'Dusty lo-fi drum kit, use .bank("crate").' },
  { repo: 'mot4i/garden', note: 'Drum kit, use .bank("garden").' },
  { repo: 'switchangel/pad', note: 'Pad samples (bank "swpad").' },
  { repo: 'yaxu/spicule', note: 'Assorted one-shots and stabs.' },
  { repo: 'Bubobubobubobubo/Dough-Fox', note: 'Electronic one-shots (kicks, snaps, blips).' },
  { repo: 'Bubobubobubobubo/Dough-Samples', note: 'General purpose kit: kick, snare, stab, shaker, perc, fx.' },
];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function log(...m) {
  console.log('[ingest]', ...m);
}

// ---------------------------------------------------------------- source

function checkoutStrudel() {
  const explicit = opt('--src');
  if (explicit) return path.resolve(explicit);
  const dir = path.join(CACHE_DIR, 'strudel-src');
  if (existsSync(path.join(dir, '.git'))) {
    log('updating', dir);
    execFileSync('git', ['-C', dir, 'pull', '--depth', '1', '--ff-only'], { stdio: 'inherit' });
  } else {
    log('cloning', STRUDEL_GIT);
    execFileSync('git', ['clone', '--depth', '1', STRUDEL_GIT, dir], { stdio: 'inherit' });
  }
  return dir;
}

async function walk(dir, filter, out = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'test', '__tests__'].includes(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(p, filter, out);
    else if (filter(p)) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- functions

function parseJsDocBlock(body) {
  const lines = body
    .split('\n')
    .map((l) => l.replace(/^\s*\*? ?/, ''))
    .join('\n');
  const [descPart, ...tagParts] = lines.split(/\n(?=@\w)/);
  const doc = { description: descPart.trim(), params: [], examples: [], synonyms: [], tags: [] };
  for (const raw of tagParts) {
    const m = raw.match(/^@(\w+)\s*([\s\S]*)$/);
    if (!m) continue;
    const [, tag, rest] = m;
    const text = rest.replace(/\s+$/, '');
    switch (tag) {
      case 'name':
        doc.name = text.trim();
        break;
      case 'memberof':
        doc.memberof = text.trim();
        break;
      case 'param': {
        const pm = text.match(/^\{([^}]*)\}\s*(\[?[\w.]+\]?)\s*([\s\S]*)$/);
        if (pm) doc.params.push({ type: pm[1], name: pm[2], description: pm[3].trim() });
        break;
      }
      case 'returns':
      case 'return':
        doc.returns = text.trim();
        break;
      case 'example':
        if (text.trim()) doc.examples.push(text.trim());
        break;
      case 'synonyms':
        doc.synonyms = text.split(/[,\s]+/).filter(Boolean);
        break;
      case 'tags':
        doc.tags = text.split(/[,\s]+/).filter(Boolean);
        break;
      case 'noAutocomplete':
        doc.hidden = true;
        break;
    }
  }
  return doc;
}

function nameFromFollowingCode(code) {
  const patterns = [
    /^\s*export\s+(?:async\s+)?function\s*\*?\s*(\w+)/,
    /^\s*export\s+const\s+\{\s*(\w+)/,
    /^\s*export\s+const\s+(\w+)/,
    /^\s*(?:const|let)\s+(\w+)\s*=/,
    /^\s*Pattern\.prototype\.(\w+)\s*=/,
    /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*register\(/,
    /^\s*function\s+(\w+)/,
  ];
  for (const re of patterns) {
    const m = code.match(re);
    if (m) return m[1];
  }
  return undefined;
}

async function ingestFunctions(src) {
  const files = await walk(path.join(src, 'packages'), (p) => /\.m?js$/.test(p));
  const byName = new Map();
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    const re = /\/\*\*([\s\S]*?)\*\/([^\n]*\n[^\n]*)/g;
    let m;
    while ((m = re.exec(text))) {
      const doc = parseJsDocBlock(m[1]);
      doc.name ??= nameFromFollowingCode(m[2]);
      if (!doc.name || doc.hidden || !doc.description) continue;
      if (/copyright|license/i.test(doc.description.slice(0, 200))) continue;
      doc.package = path.relative(path.join(src, 'packages'), file).split(path.sep)[0];
      const prev = byName.get(doc.name);
      // Keep the most complete entry when a name is documented twice.
      if (!prev || doc.examples.length + doc.description.length > prev.examples.length + prev.description.length) {
        byName.set(doc.name, doc);
      }
    }
  }
  const fns = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const f of fns) delete f.hidden;
  return fns;
}

// ---------------------------------------------------------------- docs

function mdxToMarkdown(mdx, functions) {
  let md = mdx.replace(/^---[\s\S]*?---\n/, '');
  md = md.replace(/^import .*$/gm, '');
  // <MiniRepl ... tune={`code`} ... /> -> fenced code block
  md = md.replace(/<MiniRepl[\s\S]*?tune=\{\s*`([\s\S]*?)`\s*\}[\s\S]*?\/>/g, (_, code) => `\n\`\`\`js\n${code.trim()}\n\`\`\`\n`);
  md = md.replace(/<MiniRepl[\s\S]*?\/>/g, '');
  // <JsDoc name="lpf" ... /> -> inline reference
  md = md.replace(/<JsDoc[^>]*name="([^"]+)"[^>]*\/>/g, (_, fullName) => {
    const name = fullName.replace(/^Pattern\./, "");
    const f = functions.get(name);
    if (!f) return `\n(reference: \`${name}\`)\n`;
    const syn = f.synonyms.length ? ` (synonyms: ${f.synonyms.join(', ')})` : '';
    const params = f.params.map((p) => `- \`${p.name}\` {${p.type}} ${p.description}`).join('\n');
    const ex = f.examples[0] ? `\n\`\`\`js\n${f.examples[0]}\n\`\`\`` : '';
    return `\n**\`${name}\`**${syn}: ${f.description}\n${params}${ex}\n`;
  });
  md = md.replace(/<img[^>]*>(<\/img>)?/g, '');
  md = md.replace(/<\/?(Box|QA|a|br|div|span|details|summary)[^>]*>/g, '');
  md = md.replace(/<[A-Z]\w*[^>]*\/>/g, '');
  md = md.replace(/\n{3,}/g, '\n\n');
  return md.trim();
}

function chunkMarkdown(md, maxLen = 2400) {
  const chunks = [];
  let heading = '';
  let buf = [];
  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) chunks.push({ heading, text });
    buf = [];
  };
  let inCode = false;
  for (const line of md.split('\n')) {
    if (line.startsWith('```')) inCode = !inCode;
    const h = !inCode && line.match(/^(#{1,3})\s+(.*)/);
    if (h) {
      flush();
      heading = h[2].trim();
    }
    buf.push(line);
    if (!inCode && buf.join('\n').length > maxLen && line.trim() === '') flush();
  }
  flush();
  return chunks;
}

async function ingestDocs(src, functions) {
  const byName = new Map(functions.flatMap((f) => [[f.name, f], ...f.synonyms.map((s) => [s, f])]));
  const docs = [];
  for (const section of DOC_SECTIONS) {
    const dir = path.join(src, 'website', 'src', 'pages', section);
    if (!existsSync(dir)) continue;
    for (const file of (await fs.readdir(dir)).filter((f) => f.endsWith('.mdx')).sort()) {
      const mdx = await fs.readFile(path.join(dir, file), 'utf8');
      const title = mdx.match(/^title:\s*(.*)$/m)?.[1]?.trim() ?? file;
      const slug = file.replace(/\.mdx$/, '');
      const url = `https://strudel.cc/${section}/${slug}/`;
      chunkMarkdown(mdxToMarkdown(mdx, byName)).forEach((c, i) => {
        docs.push({ id: `${section}/${slug}#${i}`, title, section, heading: c.heading, url, text: c.text });
      });
    }
  }
  return docs;
}

// ---------------------------------------------------------------- examples

function exampleMeta(code) {
  const first = code.split('\n')[0];
  const title = first.match(/"([^"]+)"/)?.[1] ?? first.replace(/^\/\/\s*/, '').slice(0, 80);
  const by = code.match(/@by\s+(.+)/)?.[1]?.trim();
  const license = code.match(/@license\s+(.+)/)?.[1]?.trim();
  const features = [...new Set([...code.matchAll(/\.(\w+)\(/g)].map((m) => m[1]))];
  return { title, by, license, features };
}

async function ingestExamples(src) {
  const out = [];
  const load = async (rel) => import(pathToFileURL(path.join(src, rel)).href);
  const tunes = await load('website/src/repl/tunes.mjs');
  for (const [name, code] of Object.entries(tunes)) {
    if (typeof code !== 'string' || /csound|hydra|midi\(|osc\(/i.test(code)) continue;
    out.push({ id: `tune/${name}`, kind: 'tune', name, code: code.trim(), ...exampleMeta(code) });
  }
  const showcase = await load('website/src/examples.mjs');
  (showcase.examples ?? []).forEach((code, i) => {
    const meta = exampleMeta(code);
    out.push({ id: `showcase/${i}`, kind: 'tune', name: meta.title, code: code.trim(), ...meta });
  });
  const drums = await load('website/src/repl/drum_patterns.mjs');
  for (const [name, code] of Object.entries(drums)) {
    if (typeof code !== 'string') continue;
    const body = code.replace(/^\/\/.*\n/gm, '').trim();
    out.push({ id: `drums/${name}`, kind: 'drum-pattern', name, code: body, title: name, features: [] });
  }
  return out;
}

// ---------------------------------------------------------------- sounds

async function wavDuration(url) {
  // Parse just the RIFF header (fetch the first 64 KiB).
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-65535' } });
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.toString('ascii', 0, 4) !== 'RIFF') return undefined;
    let off = 12;
    let byteRate;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === 'fmt ') byteRate = buf.readUInt32LE(off + 16);
      if (id === 'data' && byteRate) return +(size / byteRate).toFixed(3);
      off += 8 + size + (size % 2);
    }
  } catch {}
  return undefined;
}

function loopHint(seconds) {
  if (!seconds) return undefined;
  // Candidate tempos assuming the loop is 1, 2 or 4 bars of 4/4.
  const bpm = [1, 2, 4]
    .map((bars) => ({ bars, bpm: +((bars * 4 * 60) / seconds).toFixed(1) }))
    .filter((c) => c.bpm >= 60 && c.bpm <= 200);
  return bpm;
}

async function ingestExtraPacks() {
  const packs = [];
  for (const pack of EXTRA_PACKS) {
    const url = `https://raw.githubusercontent.com/${pack.repo}/main/strudel.json`;
    let map;
    try {
      map = await (await fetch(url)).json();
    } catch (err) {
      log(`skip ${pack.repo}: ${err.message}`);
      continue;
    }
    const base = map._base ?? `https://raw.githubusercontent.com/${pack.repo}/main/`;
    const banks = [];
    for (const [name, files] of Object.entries(map)) {
      if (name === '_base') continue;
      const list = Array.isArray(files) ? files : Object.values(files).flat();
      const bank = { name, count: list.length };
      if (pack.loops?.test(name)) {
        bank.loops = [];
        for (const [i, f] of list.slice(0, 8).entries()) {
          const seconds = /\.wav$/i.test(f) ? await wavDuration(new URL(f, base).href) : undefined;
          bank.loops.push({ index: i, file: f.split('/').pop(), seconds, tempoIf: loopHint(seconds) });
        }
      }
      banks.push(bank);
    }
    packs.push({ load: `samples('github:${pack.repo}')`, repo: pack.repo, note: pack.note, banks });
    log(`pack ${pack.repo}: ${banks.length} banks`);
  }
  return packs;
}

async function ingestSounds() {
  const renderer = new StrudelRenderer({ log });
  let registered;
  try {
    registered = await renderer.sounds();
  } finally {
    await renderer.stop();
  }
  // Recover original-case drum machine names for .bank().
  const tdm = await (await fetch('https://raw.githubusercontent.com/felixroos/dough-samples/main/tidal-drum-machines.json')).json();
  const bankCase = new Map();
  for (const key of Object.keys(tdm)) {
    const [bank] = key.split('_');
    if (key.includes('_') && bank) bankCase.set(bank.toLowerCase(), bank);
  }
  const drumMachines = {};
  const samples = [];
  const synths = [];
  const soundfonts = [];
  const DRUM_PART = /^(.+)_(bd|sd|hh|oh|cp|rim|cr|rd|ht|mt|lt|sh|cb|tb|perc|misc|fx)$/;
  for (const s of registered) {
    if (s.type === 'synth') synths.push(s.name);
    else if (s.type === 'soundfont') soundfonts.push(s.name);
    else if (s.type === 'sample' && !s.name.startsWith('_')) {
      const m = s.name.match(DRUM_PART);
      if (m) {
        const name = bankCase.get(m[1]) ?? m[1];
        (drumMachines[name] ??= []).push(m[2]);
      } else {
        samples.push({ name: s.name, count: s.count, pitched: s.pitched });
      }
    }
  }
  return {
    builtin: {
      synths: synths.sort(),
      soundfonts: soundfonts.sort(),
      samples: samples.sort((a, b) => a.name.localeCompare(b.name)),
      drumMachines: Object.fromEntries(Object.entries(drumMachines).sort(([a], [b]) => a.localeCompare(b))),
    },
    packs: await ingestExtraPacks(),
  };
}

// ---------------------------------------------------------------- main

async function main() {
  const src = checkoutStrudel();
  const commit = execFileSync('git', ['-C', src, 'rev-parse', 'HEAD']).toString().trim();
  await fs.mkdir(KNOWLEDGE_DIR, { recursive: true });
  const write = (name, data) => fs.writeFile(path.join(KNOWLEDGE_DIR, name), JSON.stringify(data, null, 1) + '\n');

  const functions = await ingestFunctions(src);
  log(`${functions.length} functions`);
  await write('functions.json', functions);

  const docs = await ingestDocs(src, functions);
  log(`${docs.length} doc chunks`);
  await write('docs.json', docs);

  const examples = await ingestExamples(src);
  log(`${examples.length} examples`);
  await write('examples.json', examples);

  if (!flag('--skip-sounds')) {
    const sounds = await ingestSounds();
    const b = sounds.builtin;
    log(`${b.synths.length} synths, ${b.soundfonts.length} soundfonts, ${b.samples.length} sample banks, ${Object.keys(b.drumMachines).length} drum machines, ${sounds.packs.length} packs`);
    await write('sounds.json', sounds);
  }

  await fs.writeFile(
    path.join(KNOWLEDGE_DIR, 'SOURCES.md'),
    `# Knowledge sources

Generated by \`npm run ingest\` on ${new Date().toISOString().slice(0, 10)}.

- Strudel source: ${STRUDEL_GIT} @ \`${commit}\`
  - \`docs.json\`: website/src/pages/{${DOC_SECTIONS.join(',')}}/*.mdx (strudel.cc documentation)
  - \`functions.json\`: JSDoc comments in packages/**
  - \`examples.json\`: website/src/repl/tunes.mjs, website/src/examples.mjs, website/src/repl/drum_patterns.mjs
- \`sounds.json\`: sound registry of @strudel/repl 1.3.0 (queried live in the headless renderer), plus
  sample maps of: ${EXTRA_PACKS.map((p) => p.repo).join(', ')}

Strudel and its documentation are licensed AGPL-3.0-or-later. Example tunes carry
their authors' licenses where noted (\`@license\`), drum patterns derive from
lvm/tidal-drum-patterns (GPL-3.0). Sample packs belong to their respective owners.
`,
  );
  log('done ->', KNOWLEDGE_DIR);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
