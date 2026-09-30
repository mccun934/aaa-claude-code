// Loads the ingested knowledge base and provides BM25 search over it.
import fs from 'node:fs';
import path from 'node:path';
import { KNOWLEDGE_DIR } from './paths.mjs';

const STOP = new Set('a an and are as at be by for from how i in is it of on or s that the this to use with you your'.split(' '));

export function tokenize(text) {
  return String(text)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9#]+/)
    .filter((t) => t && !STOP.has(t));
}

export class Bm25 {
  constructor(docs, fields, { k1 = 1.2, b = 0.75 } = {}) {
    this.docs = docs;
    this.k1 = k1;
    this.b = b;
    this.tfs = docs.map((d) => {
      const tf = new Map();
      let len = 0;
      // fields: { key: weight } or { label: [extractFn, weight] }
      for (const [key, spec] of Object.entries(fields)) {
        const [text, weight] = Array.isArray(spec) ? [spec[0](d), spec[1]] : [d[key] ?? '', spec];
        for (const t of tokenize(text)) {
          tf.set(t, (tf.get(t) ?? 0) + weight);
          len += weight;
        }
      }
      return { tf, len };
    });
    this.avgLen = this.tfs.reduce((s, x) => s + x.len, 0) / Math.max(1, docs.length);
    this.df = new Map();
    for (const { tf } of this.tfs) for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
  }
  search(query, limit = 5) {
    const q = [...new Set(tokenize(query))];
    const N = this.docs.length;
    const scored = [];
    this.tfs.forEach(({ tf, len }, i) => {
      let score = 0;
      for (const t of q) {
        const f = tf.get(t);
        if (!f) continue;
        const idf = Math.log(1 + (N - this.df.get(t) + 0.5) / (this.df.get(t) + 0.5));
        score += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * len) / this.avgLen));
      }
      if (score > 0) scored.push({ score, doc: this.docs[i] });
    });
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

function load(name, fallback) {
  const file = path.join(KNOWLEDGE_DIR, name);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export class Knowledge {
  constructor() {
    this.docs = load('docs.json', []);
    this.functions = load('functions.json', []);
    this.examples = load('examples.json', []);
    this.sounds = load('sounds.json', { builtin: { synths: [], soundfonts: [], samples: [], drumMachines: {} }, packs: [] });
    this.fnByName = new Map();
    for (const f of this.functions) {
      this.fnByName.set(f.name.toLowerCase(), f);
      for (const s of f.synonyms) if (!this.fnByName.has(s.toLowerCase())) this.fnByName.set(s.toLowerCase(), f);
    }
    // Docs and function reference share one index so a query like
    // "low pass filter envelope" finds both prose and the API entry.
    const entries = [
      ...this.docs.map((d) => ({ kind: 'doc', ...d })),
      ...this.functions.map((f) => ({ kind: 'function', ...f })),
    ];
    this.docIndex = new Bm25(entries, {
      title: 2,
      heading: 3,
      text: 1,
      name: 5,
      synonyms: [(d) => (d.synonyms ?? []).join(' '), 4],
      description: 2,
      tags: [(d) => (d.tags ?? []).join(' '), 1],
    });
    this.exampleIndex = new Bm25(this.examples, {
      name: 3,
      title: 3,
      kind: 1,
      features: [(e) => (e.features ?? []).join(' '), 1],
      code: 1,
    });
  }

  get ready() {
    return this.docs.length > 0 && this.functions.length > 0;
  }

  formatFunction(f, { maxExamples = 3 } = {}) {
    const lines = [`### ${f.name}${f.synonyms.length ? ` (synonyms: ${f.synonyms.join(', ')})` : ''}`, f.description];
    for (const p of f.params) lines.push(`- param \`${p.name}\` {${p.type}}: ${p.description}`);
    if (f.returns) lines.push(`- returns: ${f.returns}`);
    for (const ex of f.examples.slice(0, maxExamples)) lines.push('```js\n' + ex + '\n```');
    return lines.join('\n');
  }

  searchDocs(query, limit = 5) {
    return this.docIndex.search(query, limit).map(({ doc }) =>
      doc.kind === 'function'
        ? this.formatFunction(doc, { maxExamples: 2 })
        : `## ${doc.title} › ${doc.heading} (${doc.url})\n${doc.text}`,
    );
  }

  lookupFunction(name) {
    const f = this.fnByName.get(String(name).replace(/^\./, '').replace(/\(.*$/, '').toLowerCase());
    return f ? this.formatFunction(f, { maxExamples: 6 }) : null;
  }

  searchExamples(query, limit = 3) {
    return this.exampleIndex.search(query, limit).map(({ doc }) => `// [${doc.kind}] ${doc.name}${doc.by ? ` by ${doc.by}` : ''}\n${doc.code}`);
  }

  findSounds(query = '', { limit = 60 } = {}) {
    const q = String(query).toLowerCase().trim();
    const { builtin, packs } = this.sounds;
    const match = (name) => !q || name.toLowerCase().includes(q) || tokenize(q).some((t) => name.toLowerCase().includes(t));
    const out = [];
    const synths = builtin.synths.filter(match);
    if (synths.length) out.push(`Synths (use .s("name"), pitched with note()): ${synths.join(', ')}`);
    const fonts = builtin.soundfonts.filter(match).slice(0, limit);
    if (fonts.length) out.push(`General MIDI soundfonts (pitched): ${fonts.join(', ')}`);
    const samples = builtin.samples.filter((s) => match(s.name)).slice(0, limit);
    if (samples.length) {
      out.push(
        `Built-in sample banks (name[count], * = pitched/multisampled, pick variants with n() or "name:i"): ` +
          samples.map((s) => `${s.name}[${s.count}]${s.pitched ? '*' : ''}`).join(', '),
      );
    }
    const machines = Object.entries(builtin.drumMachines).filter(([name, parts]) => match(name) || (q && parts.some((p) => p === q)));
    if (machines.length) {
      out.push(
        `Drum machines (use s("bd sd hh").bank("Name")): ` +
          machines.slice(0, limit).map(([n, parts]) => `${n}(${parts.join(' ')})`).join('; '),
      );
    }
    for (const pack of packs) {
      // Prefer banks whose names match; fall back to the whole pack when the
      // query only matches its name or description.
      const named = pack.banks.filter((b) => match(b.name));
      const banks = named.length ? named : match(pack.repo) || (q && match(pack.note)) ? pack.banks : [];
      if (!banks.length) continue;
      const desc = banks.slice(0, limit).map((b) => {
        const loops = b.loops
          ?.filter((l) => l.seconds)
          .slice(0, 2)
          .map((l) => `${l.index}:${l.seconds}s${l.tempoIf?.length ? ` (${l.tempoIf.map((t) => `${t.bars}bar≈${t.bpm}bpm`).join(', ')})` : ''}`)
          .join(' ');
        return `${b.name}[${b.count}]${loops ? ` {${loops}}` : ''}`;
      });
      out.push(`Pack ${pack.load} - ${pack.note}\n  ${desc.join(', ')}`);
    }
    return out.length ? out.join('\n\n') : `No sounds matching "${query}".`;
  }

  /** Compact overview used in the system prompt. */
  overview() {
    const { builtin, packs } = this.sounds;
    return [
      `Synths: ${builtin.synths.join(', ')}`,
      `Soundfonts (${builtin.soundfonts.length}): ${builtin.soundfonts.join(', ')}`,
      `Built-in sample banks (${builtin.samples.length}): ${builtin.samples.map((s) => s.name).join(', ')}`,
      `Drum machines for .bank() (${Object.keys(builtin.drumMachines).length}): ${Object.keys(builtin.drumMachines)
        .filter((n) => /[A-Z]/.test(n))
        .join(', ')}`,
      `Loadable packs: ${packs.map((p) => `${p.load} (${p.note})`).join('; ')}`,
    ].join('\n');
  }
}

let shared;
export function getKnowledge() {
  shared ??= new Knowledge();
  return shared;
}
