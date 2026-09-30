// The composing agent: Claude with tools to read the Strudel knowledge base,
// test patterns in the real engine, "listen" to renders, and publish songs.
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { KNOWLEDGE_DIR } from './paths.mjs';
import { getKnowledge } from './knowledge.mjs';
import { evaluatePattern, formatEvaluation, PASS_SCORE, PROFILES } from './evaluate.mjs';

export const MODEL = process.env.STRUDEL_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.STRUDEL_EFFORT || 'high';
const MAX_STEPS = Number(process.env.STRUDEL_MAX_STEPS || 40);
const MAX_PUBLISH_REJECTIONS = 2;
// Server-side refusal fallbacks (Claude API only); set STRUDEL_FALLBACKS=0 on other platforms.
const FALLBACKS = process.env.STRUDEL_FALLBACKS !== '0';
const fallbackParams = () => (FALLBACKS ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {});

const cheatsheet = () => {
  try {
    return fs.readFileSync(path.join(KNOWLEDGE_DIR, 'cheatsheet.md'), 'utf8');
  } catch {
    return '';
  }
};

export function systemPrompt(knowledge = getKnowledge()) {
  const profiles = Object.entries(PROFILES)
    .map(([k, v]) => `- ${k}: ${v.description}`)
    .join('\n');
  return `You are a composer and sound designer who writes music as Strudel code (strudel.cc, the JavaScript port of TidalCycles). You chat with the user about the music they want, then build it in Strudel. The user hears your code in a Strudel editor next to this chat.

# How you work
1. Understand the request. If it's vague, make confident musical choices yourself (genre, tempo, key, palette, form) and mention them briefly, rather than asking a string of questions. Ask only when the request is genuinely ambiguous.
2. Research what you need: search_docs / lookup_function for syntax you're unsure about, search_examples for idioms, find_sounds for every sound, bank or sample pack you use. Never guess a sound name.
3. Draft the full piece and run test_pattern on it. It renders the code in the same engine the user hears and returns a musicality score (0-100) with concrete issues.
4. Iterate: fix errors, missing sounds and the listed issues, then re-test. Aim for a score of at least ${PASS_SCORE} (the pass mark) but remember the score is a sanity check, not the goal; don't strip out character just to game a metric.
5. Before publishing, call listen once on your best candidate. It gives you the spectrogram, a piano roll and an independent critic's verdict against the user's brief. Address anything important it flags.
6. Call publish_song with the final code. It re-tests the code and loads it into the user's editor. Then reply with a short description of what you made (structure, sounds, a tweak or two the user could try). Keep the chat reply concise; the code speaks for itself.

When the user asks for changes, start from the code currently in their editor (provided with each message, they may have edited it) and follow the same test → listen → publish loop. Small tweaks may skip listen if test_pattern is clean.

# Code conventions
- A complete, self-contained program: setcps(...) first, samples(...) loads next, then the music as one stack(...) or several $: blocks.
- Comment each part briefly (// drums, // bass ...). Keep lines readable; the user may live-edit it.
- Design for at least 8 cycles of interest: use <...> alternation, firstOf/lastOf, masks or arrange() so it evolves.
- Keep levels sane (gain ≤ 1 on most layers) to avoid clipping.
- Musicality profiles for test_pattern (pick the one matching the genre):
${profiles}

# Strudel reference (hand-written summary; the full docs are behind your tools)
${cheatsheet()}

# Sound library overview (use find_sounds for details, variants and loop tempos)
${knowledge.overview()}`;
}

const TOOL_DEFS = [
  {
    name: 'search_docs',
    description: 'Full-text search over the ingested strudel.cc documentation and the API reference (JSDoc of every Strudel function). Returns the best matching sections with code examples.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to know, e.g. "sidechain ducking", "euclidean rhythm", "filter envelope".' },
        limit: { type: 'integer', description: 'Max results (default 5).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'lookup_function',
    description: 'Exact API reference for one Strudel function (or synonym): description, parameters and examples.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Function name, e.g. "lpenv", "chop", "voicing".' } },
      required: ['name'],
    },
  },
  {
    name: 'search_examples',
    description: 'Search complete example tunes and ~500 classic drum patterns from the Strudel repository. Good for idioms and genre starting points.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'e.g. "house", "acid bass", "breakbeat chop", "jazz chords".' },
        limit: { type: 'integer', description: 'Max results (default 3).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'find_sounds',
    description: 'Look up available sounds: synths, General MIDI soundfonts, built-in sample banks, drum machines for .bank(), and loadable GitHub sample packs (drum breaks and loops, with durations and tempo guesses). Substring match; empty query lists categories.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'e.g. "808", "piano", "break", "pad", "bass", "amen".' } },
      required: ['query'],
    },
  },
  {
    name: 'test_pattern',
    description: `Render Strudel code headlessly in the same engine the user hears and measure its musicality: evaluation errors, missing sounds, key/consonance, rhythm grid and pulse, repetition/variation, arrangement roles, density, loudness, clipping and spectral balance. Returns a 0-100 score (pass mark ${PASS_SCORE}) with concrete issues. Fast (a few seconds).`,
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The complete Strudel program.' },
        profile: { type: 'string', enum: Object.keys(PROFILES), description: 'Genre profile for the scoring targets (default "default").' },
        cycles: { type: 'integer', description: 'Cycles to analyse, 4-32 (default 8). Use 16+ for pieces with long-form structure.' },
      },
      required: ['code'],
    },
  },
  {
    name: 'listen',
    description: 'Render the code and "listen": returns a spectrogram and a piano roll of the render (images), the full metrics, and an independent critic\'s verdict on how well it fits the brief. Slower; use on serious candidates.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The complete Strudel program.' },
        brief: { type: 'string', description: "The user's request in your words: genre, mood, tempo, instruments, anything they asked for." },
        profile: { type: 'string', enum: Object.keys(PROFILES) },
        cycles: { type: 'integer', description: 'Cycles to render (default 8).' },
      },
      required: ['code', 'brief'],
    },
  },
  {
    name: 'publish_song',
    description: `Load the final code into the user's editor. The code is re-tested first; if it errors or scores below ${PASS_SCORE} it is rejected with the issues (after ${MAX_PUBLISH_REJECTIONS} rejections in a turn it is published anyway with a warning).`,
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The complete Strudel program.' },
        title: { type: 'string', description: 'A short title for the piece.' },
        profile: { type: 'string', enum: Object.keys(PROFILES) },
      },
      required: ['code', 'title'],
    },
  },
];

// Stream tool inputs (mostly code) as they're generated; inputs are validated before use.
export const TOOLS = TOOL_DEFS.map((t) => ({ ...t, eager_input_streaming: true }));

const CRITIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fits_brief: { type: 'integer', description: '0-10' },
    groove: { type: 'integer', description: '0-10' },
    harmony_melody: { type: 'integer', description: '0-10' },
    arrangement: { type: 'integer', description: '0-10' },
    sound_and_mix: { type: 'integer', description: '0-10' },
    overall: { type: 'integer', description: '0-10' },
    summary: { type: 'string' },
    fixes: { type: 'array', items: { type: 'string' }, description: 'Most important concrete code changes, best first (max 5).' },
  },
  required: ['fits_brief', 'groove', 'harmony_melody', 'arrangement', 'sound_and_mix', 'overall', 'summary', 'fixes'],
};

const png = (buf) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: buf.toString('base64') } });

function validate(tool, input) {
  const def = TOOLS.find((t) => t.name === tool);
  if (!def) return `unknown tool ${tool}`;
  for (const key of def.input_schema.required) {
    if (typeof input?.[key] !== 'string' || !input[key].trim()) return `missing or empty "${key}"`;
  }
  return null;
}

export class ComposerSession {
  /**
   * @param {{client?: Anthropic, knowledge?: object, evaluate?: typeof evaluatePattern}} deps
   */
  constructor({ client, knowledge = getKnowledge(), evaluate = evaluatePattern } = {}) {
    this.client = client ?? new Anthropic();
    this.knowledge = knowledge;
    this.evaluate = evaluate;
    this.messages = [];
    this.system = systemPrompt(knowledge);
    this.song = null; // last published { code, title, score }
    this.lastBrief = '';
  }

  async #critic(code, ev, brief) {
    const content = [];
    if (ev.images.spectrogram) content.push({ type: 'text', text: 'Spectrogram of the render (log frequency 40 Hz-16 kHz; dotted blue lines = cycle boundaries; green lines = 100 Hz, 1 kHz, 10 kHz):' }, png(ev.images.spectrogram));
    if (ev.images.pianoRoll) content.push({ type: 'text', text: `Piano roll (pitched parts above, percussion lanes at the bottom; one color per source: ${JSON.stringify(ev.report.pianoRollLegend)}):` }, png(ev.images.pianoRoll));
    content.push({
      type: 'text',
      text: `Brief: ${brief}\n\nStrudel code:\n\`\`\`js\n${code}\n\`\`\`\n\nMeasured analysis:\n${formatEvaluation(ev)}\n\nYou are a demanding music producer reviewing this piece. You cannot hear it, but the spectrogram, piano roll, code and measurements tell you what it sounds like. Score each dimension 0-10 (5 = mediocre, 8 = good, 10 = excellent) against the brief, and list the most valuable concrete code changes.`,
    });
    const res = await this.client.beta.messages.create({
      ...fallbackParams(),
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: CRITIC_SCHEMA } },
      messages: [{ role: 'user', content }],
    });
    if (res.stop_reason === 'refusal') return null;
    const text = res.content.find((b) => b.type === 'text')?.text;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async #runTool(name, input, emit, turn) {
    const invalid = validate(name, input);
    if (invalid) return { content: `Invalid input: ${invalid}`, is_error: true };
    const k = this.knowledge;
    switch (name) {
      case 'search_docs': {
        const hits = k.searchDocs(input.query, Math.min(10, input.limit ?? 5));
        return { content: hits.length ? hits.join('\n\n---\n\n') : 'No results.' };
      }
      case 'lookup_function': {
        const f = k.lookupFunction(input.name);
        return f ? { content: f } : { content: `No function named "${input.name}". Try search_docs.`, is_error: true };
      }
      case 'search_examples': {
        const hits = k.searchExamples(input.query, Math.min(6, input.limit ?? 3));
        return { content: hits.length ? hits.join('\n\n---\n\n') : 'No results.' };
      }
      case 'find_sounds':
        return { content: k.findSounds(input.query) };
      case 'test_pattern': {
        const ev = await this.evaluate(input.code, { profile: input.profile, cycles: clampCycles(input.cycles) });
        emit({ type: 'evaluation', tool: name, score: ev.score, pass: ev.pass, subscores: ev.subscores, issues: ev.issues, code: input.code });
        return { content: formatEvaluation(ev) };
      }
      case 'listen': {
        this.lastBrief = input.brief;
        const ev = await this.evaluate(input.code, { profile: input.profile, cycles: clampCycles(input.cycles), images: true });
        let verdict = null;
        if (ev.report.ok) {
          emit({ type: 'status', text: 'Critic is reviewing the render…' });
          verdict = await this.#critic(input.code, ev, input.brief).catch((err) => ({ error: err.message }));
        }
        emit({
          type: 'evaluation',
          tool: name,
          score: ev.score,
          pass: ev.pass,
          subscores: ev.subscores,
          issues: ev.issues,
          verdict,
          code: input.code,
          images: Object.fromEntries(Object.entries(ev.images).map(([n, b]) => [n, `data:image/png;base64,${b.toString('base64')}`])),
        });
        const content = [{ type: 'text', text: formatEvaluation(ev) }];
        if (ev.images.spectrogram) content.push({ type: 'text', text: 'Spectrogram (log freq 40 Hz-16 kHz, dotted blue = cycle boundaries):' }, png(ev.images.spectrogram));
        if (ev.images.pianoRoll) content.push({ type: 'text', text: `Piano roll (legend: ${JSON.stringify(ev.report.pianoRollLegend)}):` }, png(ev.images.pianoRoll));
        content.push({ type: 'text', text: `Critic verdict: ${verdict ? JSON.stringify(verdict) : 'unavailable'}` });
        return { content };
      }
      case 'publish_song': {
        const ev = await this.evaluate(input.code, { profile: input.profile, cycles: 8 });
        const forced = turn.rejections >= MAX_PUBLISH_REJECTIONS;
        if ((!ev.report.ok || !ev.pass) && !forced) {
          turn.rejections++;
          emit({ type: 'evaluation', tool: name, score: ev.score, pass: false, subscores: ev.subscores, issues: ev.issues, code: input.code });
          return { content: `Not published (score ${ev.score}, pass mark ${PASS_SCORE}). Fix these and try again:\n${formatEvaluation(ev)}`, is_error: true };
        }
        if (!ev.report.ok) {
          return { content: `Cannot publish code that fails to evaluate: ${ev.report.error}`, is_error: true };
        }
        this.song = { code: input.code, title: input.title, score: ev.score, subscores: ev.subscores, issues: ev.issues, profile: ev.profile };
        turn.published = true;
        emit({ type: 'song', ...this.song, warning: ev.pass ? undefined : `Published below the pass mark (${ev.score}).` });
        return { content: `Published "${input.title}" to the editor with score ${ev.score}.${ev.pass ? '' : ' (below pass mark, published after repeated rejections: tell the user what is still weak.)'}` };
      }
    }
    return { content: `Unknown tool ${name}`, is_error: true };
  }

  /**
   * Handle one user message. `emit` receives UI events:
   * text | tool | evaluation | song | status | error | done.
   */
  async send(userText, { editorCode, emit = () => {}, signal } = {}) {
    const context = editorCode?.trim() && editorCode.trim() !== this.song?.code?.trim()
      ? `\n\n<editor_code note="current contents of the user's Strudel editor, possibly edited by them">\n${editorCode}\n</editor_code>`
      : '';
    this.messages.push({ role: 'user', content: userText + context });
    const turn = { rejections: 0, published: false };

    try {
      await this.#loop(turn, emit, signal);
    } finally {
      // If the turn died between a tool_use and its results (API error,
      // abort), answer the dangling calls so the conversation stays valid.
      const last = this.messages.at(-1);
      const pending = last?.role === 'assistant' && Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_use') : [];
      if (pending.length) {
        this.messages.push({
          role: 'user',
          content: pending.map((b) => ({ type: 'tool_result', tool_use_id: b.id, content: 'Interrupted before this tool ran.', is_error: true })),
        });
      }
    }
    emit({ type: 'done', published: turn.published });
    return this.song;
  }

  async #loop(turn, emit, signal) {
    let jsonRetries = 0;
    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal?.aborted) throw new Error('aborted');
      const stream = this.client.beta.messages.stream(
        {
          ...fallbackParams(),
          model: MODEL,
          max_tokens: 64000,
          thinking: { type: 'adaptive', display: 'summarized' },
          output_config: { effort: EFFORT },
          cache_control: { type: 'ephemeral' },
          system: [{ type: 'text', text: this.system, cache_control: { type: 'ephemeral' } }],
          tools: TOOLS,
          messages: this.messages,
        },
        { signal },
      );
      stream.on('text', (delta) => emit({ type: 'text', delta }));
      stream.on('thinking', (delta) => emit({ type: 'thinking', delta }));
      let message;
      try {
        message = await stream.finalMessage();
        jsonRetries = 0;
      } catch (err) {
        // With eager input streaming an unparseable tool input rejects here;
        // re-issue the turn a couple of times. API errors propagate.
        if (err instanceof Anthropic.APIError || signal?.aborted || jsonRetries++ >= 2) throw err;
        continue;
      }
      // Keep the full content (incl. thinking blocks) so later turns replay it unchanged.
      this.messages.push({ role: 'assistant', content: message.content });

      if (message.stop_reason === 'refusal') {
        emit({ type: 'error', message: 'The model declined this request.' });
        break;
      }
      if (message.stop_reason === 'max_tokens') {
        emit({ type: 'error', message: 'Response hit the token limit.' });
        break;
      }
      if (message.stop_reason === 'pause_turn') continue;
      const toolUses = message.content.filter((b) => b.type === 'tool_use');
      if (message.stop_reason !== 'tool_use' || !toolUses.length) break;

      const results = [];
      for (const tu of toolUses) {
        emit({ type: 'tool', name: tu.name, input: summarizeInput(tu.input) });
        let result;
        try {
          result = await this.#runTool(tu.name, tu.input, emit, turn);
        } catch (err) {
          result = { content: `Tool failed: ${err.message}`, is_error: true };
        }
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: result.content, ...(result.is_error ? { is_error: true } : {}) });
      }
      // All results for one assistant turn go back in a single user message.
      this.messages.push({ role: 'user', content: results });
    }
  }
}

function clampCycles(c) {
  const n = Number(c ?? 8);
  return Number.isFinite(n) ? Math.max(4, Math.min(32, Math.round(n))) : 8;
}

function summarizeInput(input) {
  const out = { ...input };
  if (typeof out.code === 'string') out.code = out.code.length > 400 ? out.code.slice(0, 400) + '…' : out.code;
  return out;
}
