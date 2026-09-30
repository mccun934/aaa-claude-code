// Drives ComposerSession with a scripted fake Claude client and a stub
// evaluator, checking the tool loop, the publish gate and emitted UI events.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ComposerSession, TOOLS, systemPrompt } from '../lib/agent.mjs';
import { getKnowledge } from '../lib/knowledge.mjs';

function fakeClient(script) {
  const requests = [];
  let i = 0;
  const stream = (params) => {
    requests.push(structuredClone(params));
    const msg = script[i++];
    if (!msg) throw new Error('script exhausted');
    const handlers = {};
    return {
      on(ev, cb) {
        handlers[ev] = cb;
        return this;
      },
      async finalMessage() {
        for (const b of msg.content) if (b.type === 'text') handlers.text?.(b.text);
        return msg;
      },
    };
  };
  const create = async () => ({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify({ fits_brief: 8, groove: 7, harmony_melody: 8, arrangement: 7, sound_and_mix: 7, overall: 8, summary: 'solid', fixes: ['more hats'] }) }],
  });
  return { requests, beta: { messages: { stream, create } } };
}

const toolUse = (id, name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] });
const say = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });

function stubEvaluate(scores) {
  const calls = [];
  const fn = async (code, opts = {}) => {
    calls.push({ code, opts });
    const score = scores.shift() ?? 80;
    return {
      report: { ok: true, cps: 0.5, cycles: 8, missingSounds: [], warnings: [], fetchFailures: [], symbolic: { events: 10, eventsPerSecond: 2, voices: [], onGridRatio: 1, ioiEntropy: 0.1, beatCoverage: 1, repetition: 1, cycleSimilarity: {}, distinctCycles: 2, halfSimilarity: 1 }, bpmIfCycleIsOneBar: 120, pianoRollLegend: [] },
      score,
      pass: score >= 70,
      profile: 'default',
      subscores: { repetition: 1 },
      issues: score >= 70 ? [] : ['too sparse'],
      images: opts.images ? { spectrogram: Buffer.from('png'), pianoRoll: Buffer.from('png') } : {},
    };
  };
  fn.calls = calls;
  return fn;
}

test('system prompt includes cheatsheet and sound overview', () => {
  const p = systemPrompt(getKnowledge());
  assert.match(p, /Mini-notation/);
  assert.match(p, /Drum machines for \.bank\(\)/);
  assert.equal(TOOLS.length, 7);
  assert.ok(TOOLS.every((t) => t.eager_input_streaming));
});

test('agent researches, tests, listens, gets rejected, then publishes', async () => {
  const code = 'setcps(.5)\ns("bd*4")';
  const client = fakeClient([
    toolUse('t1', 'find_sounds', { query: '909' }),
    toolUse('t2', 'test_pattern', { code, profile: 'dance' }),
    toolUse('t3', 'listen', { code, brief: 'techno' }),
    toolUse('t4', 'publish_song', { code, title: 'Draft' }),
    toolUse('t5', 'publish_song', { code, title: 'Final' }),
    say('Here is your techno loop.'),
  ]);
  // test=85, listen=85, first publish=50 (rejected), second publish=90
  const evaluate = stubEvaluate([85, 85, 50, 90]);
  const session = new ComposerSession({ client, evaluate });
  const events = [];
  const song = await session.send('make techno', { emit: (e) => events.push(e) });

  assert.equal(song.title, 'Final');
  assert.equal(song.score, 90);
  assert.deepEqual(evaluate.calls.map((c) => c.opts.images ?? false), [false, true, false, false]);

  // tool results are returned in order and the rejected publish is an error
  const results = client.requests.at(-1).messages.filter((m) => m.role === 'user' && Array.isArray(m.content)).map((m) => m.content[0]);
  assert.match(results[0].content, /Drum machines|RolandTR909/);
  assert.match(results[1].content, /MUSICALITY SCORE: 85/);
  assert.ok(Array.isArray(results[2].content) && results[2].content.some((b) => b.type === 'image'));
  assert.match(results[2].content.at(-1).text, /"overall":8/);
  assert.equal(results[3].is_error, true);
  assert.match(results[4].content, /Published "Final"/);

  const types = events.map((e) => e.type);
  assert.ok(types.includes('song'));
  assert.equal(types.at(-1), 'done');
  assert.equal(events.filter((e) => e.type === 'evaluation').length, 3);
  assert.equal(events.find((e) => e.type === 'song').title, 'Final');

  // every request carries the cached system prompt and tools
  for (const r of client.requests) {
    assert.equal(r.system[0].cache_control.type, 'ephemeral');
    assert.equal(r.tools.length, 7);
  }
});

test('publish is forced through after repeated rejections', async () => {
  const code = 's("bd")';
  const client = fakeClient([
    toolUse('a', 'publish_song', { code, title: 'x' }),
    toolUse('b', 'publish_song', { code, title: 'x' }),
    toolUse('c', 'publish_song', { code, title: 'x' }),
    say('done'),
  ]);
  const events = [];
  const session = new ComposerSession({ client, evaluate: stubEvaluate([40, 40, 40]) });
  await session.send('hi', { emit: (e) => events.push(e) });
  const song = events.find((e) => e.type === 'song');
  assert.ok(song.warning);
  assert.equal(session.song.score, 40);
});

test('invalid tool input is reported as an error, not executed', async () => {
  const client = fakeClient([toolUse('a', 'test_pattern', { code: '' }), say('ok')]);
  const evaluate = stubEvaluate([]);
  const session = new ComposerSession({ client, evaluate });
  await session.send('hi');
  assert.equal(evaluate.calls.length, 0);
  const result = client.requests[1].messages.at(-1).content[0];
  assert.equal(result.is_error, true);
});

test('editor code is attached when it differs from the last published song', async () => {
  const client = fakeClient([say('a'), say('b')]);
  const session = new ComposerSession({ client, evaluate: stubEvaluate([]) });
  await session.send('first', { editorCode: 's("hh*8")' });
  assert.match(client.requests[0].messages[0].content, /<editor_code/);
  session.song = { code: 's("hh*8")' };
  await session.send('second', { editorCode: 's("hh*8")' });
  assert.doesNotMatch(client.requests[1].messages.at(-1).content, /<editor_code/);
});

test('an API error mid-turn leaves no dangling tool_use', async () => {
  const client = fakeClient([toolUse('a', 'find_sounds', { query: 'x' })]);
  const session = new ComposerSession({ client, evaluate: stubEvaluate([]) });
  // Fail after the assistant's tool_use is recorded but before results exist.
  const emit = (e) => {
    if (e.type === 'tool') throw new Error('connection lost');
  };
  await assert.rejects(session.send('hi', { emit }));
  assert.equal(session.messages.at(-2).content[0].type, 'tool_use');
  const last = session.messages.at(-1);
  assert.equal(last.role, 'user');
  assert.equal(last.content[0].type, 'tool_result');
});
