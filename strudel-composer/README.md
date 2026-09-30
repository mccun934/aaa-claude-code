# Strudel Composer

Chat with Claude about the music you want; Claude writes it as a
[Strudel](https://strudel.cc) program, renders it headlessly, measures how
musical it is, iterates, and loads the result into a live Strudel editor
next to the chat.

```
┌──────────── browser ─────────────┐        ┌──────────────── server.mjs ─────────────────┐
│ chat  ◄──── SSE events ──────────┼────────┤ ComposerSession (lib/agent.mjs)             │
│ <strudel-editor> ◄── song code   │        │   Claude + tools:                           │
│ "Score my edits" ──► /api/evaluate        │   search_docs · lookup_function            │
└──────────────────────────────────┘        │   search_examples · find_sounds             │
                                            │   test_pattern · listen · publish_song      │
                                            │        │                                    │
                                            │        ▼                                    │
                                            │ headless Chromium running @strudel/repl     │
                                            │   (lib/renderer.mjs + public/render/)       │
                                            │   → events (haps) + WAV render              │
                                            │ lib/music.mjs  symbolic analysis            │
                                            │ lib/audio.mjs  audio analysis               │
                                            │ lib/plots.mjs  spectrogram + piano roll     │
                                            └─────────────────────────────────────────────┘
```

## Quick start

```bash
cd strudel-composer
npm install
npx playwright-core install chromium   # skip if you have Chromium; or set CHROMIUM_PATH
cp .env.example .env                   # add ANTHROPIC_API_KEY
npm start                              # http://localhost:5174
```

The knowledge base is committed in `knowledge/`, so `npm run ingest` is only
needed to refresh it from the latest Strudel sources.

## What the agent knows (`knowledge/`)

Built by `npm run ingest` (clones `codeberg.org/uzu/strudel`, queries the live
engine, fetches sample maps):

| file | contents |
|---|---|
| `docs.json` | strudel.cc learn / recipes / understand / workshop pages, chunked by heading; `<MiniRepl>` examples become code blocks, `<JsDoc>` tags are inlined |
| `functions.json` | API reference parsed from the JSDoc in Strudel's packages (≈470 functions with params, synonyms, examples) |
| `examples.json` | the REPL's example tunes, showcase tunes and ≈490 classic drum patterns |
| `sounds.json` | every sound the editor registers (synths, 125 GM soundfonts, sample banks, 70+ drum machines for `.bank()`), plus loop and break packs (`github:yaxu/clean-breaks`, dirt-samples breaks, amen, wax loops, …) with measured loop lengths and tempo guesses |
| `cheatsheet.md` | hand-written summary that goes into the system prompt: program shape, mini-notation, sounds, loops, effects, transformations, and what the evaluator treats as musical. Every code block in it is run by the engine tests |

The agent searches docs and functions with BM25 (`search_docs`,
`lookup_function`), looks up example tunes (`search_examples`), and checks
every sound name it uses (`find_sounds`).

## The test loop: how "musicality" is measured

`test_pattern` renders the code in the **same engine and sound library the
user hears**: `@strudel/repl` in headless Chromium, with an offline audio
render. It then scores 0–100 from two sources:

**Symbolic** (from the pattern's events):
- *tonalCenter*: Krumhansl–Kessler key correlation and the share of notes in that key
- *consonance*: roughness of the notes that sound together
- *melodicContour*: how much of each line moves stepwise, and how often it leaps more than an octave
- *rhythmicGrid* / *rhythmicCoherence*: share of onsets on a 16th/triplet grid, and entropy of the gaps between onsets
- *pulse*: how many beats are played, plus whether the audio's onsets line up with the pattern's subdivisions
- *repetition* / *variation*: similarity between cycles at lags 1, 2, 4 and 8, and the number of distinct cycles
- *layering* / *density*: roles present (percussion, bass, harmony, melody) and events per second
- *harmonicContent*: requires pitched material unless the profile is `drums` or `ambient`

**Audio** (from the rendered WAV): *loudness* (RMS), *noClipping*,
*continuity* (share of silent frames), and *spectralBalance* (sub, bass,
mid and high bands).

Errors, missing sounds, failed sample downloads, silent renders, severe
clipping and very harsh harmony apply extra penalties. Every issue comes
back as a concrete fix ("Use `.scale()` so all parts share a key…").
Genre profiles (`default`, `dance`, `chill`, `ambient`, `drums`) shift the
targets.

`listen` also draws a spectrogram and a piano roll (PNG) and passes them, with
the metrics and the code, to a separate Claude critic. The critic scores the
piece 0–10 against the brief and suggests fixes. The composing agent also sees
the images. `publish_song` re-tests the code and rejects anything below the
pass mark (70). After two rejections in one turn it publishes anyway, with a
warning.

### Calibration

`npm run benchmark` scores the Strudel repo's own example tunes and drum
patterns against deliberately unmusical controls: random chromatic notes at
random times, cluster chords, tritone stacks, clipping, silence, missing
sounds, noise and polyrhythm soup. Latest run
([benchmark/RESULTS.md](benchmark/RESULTS.md)):

| group | n | median | pass rate |
|---|---|---|---|
| example tunes | 29 | 82 | 86% |
| drum patterns (`drums` profile) | 15 | 87 | 80% |
| unmusical controls | 14 | 51 | 0% |

**AUC 0.97**: in 97% of good/control pairs, the good piece scores higher.
Tunes whose samples could not be downloaded are excluded; the benchmark
lists them.

## Commands

| command | what it does |
|---|---|
| `npm start` | chat UI + API on `:5174` |
| `npm run ingest` | rebuild `knowledge/` from the latest Strudel sources |
| `npm run evaluate -- song.strudel [--profile dance] [--cycles 16] [--out dir]` | score a file from the CLI; `--out` writes the WAV, spectrogram, piano roll and a JSON report |
| `npm run benchmark` | recalibrate the scorer (writes `benchmark/`) |
| `npm test` | unit tests (agent loop with a fake Claude, analysis, search) and engine tests (`SKIP_ENGINE_TESTS=1` to skip) |

## Configuration

See `.env.example`. The default model is `claude-opus-5-5` with adaptive
thinking at `high` effort, server-side refusal fallbacks, and prompt caching
of the system prompt and tools.

## Notes

- Samples stream from GitHub in the browser. The headless renderer caches
  them in `.cache/net/`.
- Each render starts from the stock sound registry, so a song that redefines
  `bd` can't affect the next one.
- Strudel is AGPL-3.0. The ingested docs and examples keep their licenses;
  see `knowledge/SOURCES.md`.
