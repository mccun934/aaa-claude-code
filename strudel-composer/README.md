# Strudel Composer

A web page with **Claude Code in a terminal** on the left and a live
[Strudel](https://strudel.cc) editor on the right. Tell Claude what music you
want. It writes the song as Strudel code, renders it headlessly, measures how
musical it is, and iterates. When it runs `publish`, the song loads into the
editor and starts playing.

```
┌──────────────────────── browser ────────────────────────┐
│ xterm.js  ◄── WebSocket ──┐     <strudel-editor>  ◄── SSE (song events)
└───────────────────────────┼──────────────────▲──────────┘
                            │                  │
┌──────────── server.mjs ───┼──────────────────┼────────────────────────┐
│ node-pty: $SHELL → claude "welcome prompt"   │                        │
│   Claude Code reads CLAUDE.md + knowledge/, runs:                     │
│   node scripts/strudel.mjs docs|fn|examples|sounds  (knowledge base)  │
│   node scripts/strudel.mjs test  ──► /api/evaluate ─┐                 │
│   node scripts/strudel.mjs publish ► /api/publish ──┴► headless Chromium
│                                                    running @strudel/repl
│                                          → events + WAV → musicality score
└───────────────────────────────────────────────────────────────────────┘
```

## Quick start

```bash
cd strudel-composer
npm install                            # builds node-pty (needs a C++ toolchain on some systems)
npx playwright-core install chromium   # skip if you have Chromium; or set CHROMIUM_PATH
npm install -g @anthropic-ai/claude-code   # if you don't have Claude Code yet
npm start                              # open http://localhost:5174
```

**No API key is needed.** The terminal runs your own `claude` command, so it
uses whatever Claude Code login you already have. On first launch Claude Code
may ask you to log in and to trust the folder, as it does in any new
directory. Then it greets you with a welcome message.

The terminal is shared and persistent: reloading the page reattaches to the
same session, and **Restart** starts a fresh one. If Claude exits, you're
left in a normal shell; `claude -c` resumes the conversation. Linux and macOS
are supported (on Windows, use WSL).

### Troubleshooting

- **`Error: posix_spawnp failed` (macOS):** node-pty 1.1.0 installs its
  `spawn-helper` without execute permission. A `postinstall` step and the
  server both fix this automatically. On an older checkout, run
  `chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper`.
- **The terminal shows "Could not start the terminal":** the server log has
  the details. Fix the cause, then press **Restart**.

### How Claude Code is set up

- `CLAUDE.md` gives Claude its role and workflow: research → draft
  `songs/draft.strudel` → `test` → fix → `test --listen` → `publish`. It also
  imports `knowledge/cheatsheet.md`.
- `.claude/settings.json` pre-approves the composer CLI and edits under
  `songs/`, so Claude doesn't ask for permission at every step. It is passed
  explicitly with `--settings`.
- `node scripts/strudel.mjs editor` prints what's in the web editor, including
  your hand edits. Claude starts every revision from it.
- `test --listen` writes a spectrogram and a piano roll PNG, which Claude opens
  to "look at" the render.
- `publish` refuses songs under the pass mark (70) unless given `--force`.

### Security

The terminal is a real shell on your machine. The server listens on
`127.0.0.1` only and rejects requests whose `Host` isn't localhost, which
blocks DNS rebinding. The WebSocket also requires a same-origin connection and
a random per-process token. Don't expose the port to a network.

## What Claude knows (`knowledge/`)

Built by `npm run ingest` (clones `codeberg.org/uzu/strudel`, queries the live
engine, fetches sample maps):

| file | contents |
|---|---|
| `docs.json` | strudel.cc learn / recipes / understand / workshop pages, chunked by heading; `<MiniRepl>` examples become code blocks, `<JsDoc>` tags are inlined |
| `functions.json` | API reference parsed from the JSDoc in Strudel's packages (≈470 functions with params, synonyms, examples) |
| `examples.json` | the REPL's example tunes, showcase tunes and ≈490 classic drum patterns |
| `sounds.json` | every sound the editor registers (synths, 125 GM soundfonts, sample banks, 70+ drum machines for `.bank()`), plus loop and break packs (`github:yaxu/clean-breaks`, dirt-samples breaks, amen, wax loops, …) with measured loop lengths and tempo guesses |
| `cheatsheet.md` | hand-written summary that goes into the system prompt: program shape, mini-notation, sounds, loops, effects, transformations, and what the evaluator treats as musical. Every code block in it is run by the engine tests |

Claude searches docs and functions with BM25 (`strudel.mjs docs` / `fn`),
looks up example tunes (`examples`), and checks every sound name it uses
(`sounds`).

## The test loop: how "musicality" is measured

`strudel.mjs test` renders the code in the **same engine and sound library the
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

`test --listen` also draws a spectrogram and a piano roll (PNG), which Claude
Code opens to check the render. `publish` re-tests the code and rejects anything
below the pass mark (70) unless `--force` is given.

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
| `npm start` | the web app (terminal + editor) on `:5174` |
| `node scripts/strudel.mjs docs\|fn\|examples\|sounds <query>` | search the knowledge base |
| `node scripts/strudel.mjs test <file> [--profile p] [--cycles n] [--listen]` | render and score a file (through the server if it's running, otherwise locally) |
| `node scripts/strudel.mjs publish <file> --title "T" [--force]` | score and push a song to the open editors |
| `node scripts/strudel.mjs editor` | print the current editor contents |
| `npm run ingest` | rebuild `knowledge/` from the latest Strudel sources |
| `npm run benchmark` | recalibrate the scorer (writes `benchmark/`) |
| `npm test` | unit tests (analysis, search, CLI, terminal) and engine tests (`SKIP_ENGINE_TESTS=1` to skip) |

See `.env.example` for options: port, pass mark, welcome message, and
overriding the terminal command (for example `claude --model sonnet`).

## Notes

- Samples stream from GitHub in the browser. The headless renderer caches
  them in `.cache/net/`.
- Each render starts from the stock sound registry, so a song that redefines
  `bd` can't affect the next one.
- Strudel is AGPL-3.0. The ingested docs and examples keep their licenses;
  see `knowledge/SOURCES.md`.
