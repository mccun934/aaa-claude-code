# Strudel composer's cheatsheet

Hand-written summary for the composing agent. For details, search the
ingested docs (`node scripts/strudel.mjs docs <query>`) and API reference
(`node scripts/strudel.mjs fn <name>`).

## Program shape

```js
setcps(120/60/4)            // tempo: cycles per second. 1 cycle = 1 bar of 4/4 → cps = bpm/60/4
// setcpm(120/4)            // same thing in cycles per minute

// Option A: one stack
stack(
  s("bd*4, [~ cp]*2, hh*8").bank("RolandTR909"),        // drums
  note("<c2 c2 ab1 bb1>*8").s("sawtooth").lpf(600),      // bass
  chord("<Cm7 Abmaj7 Bbmaj7 Gm7>").voicing().s("gm_epiano1").room(.4), // chords
  n("<0 2 4 [3 2]>*4").scale("C4:minor").s("triangle").delay(.3),      // melody
)

// Option B: labelled parallel blocks (each $: line plays at once)
$: s("bd*4").bank("RolandTR808")
$: note("c2 [~ c2] eb2 g1").s("sawtooth").lpf(500)
```

Use either `stack(...)` or `$:` blocks, not both at the top level. Keep everything
in one key: prefer `n("...").scale("Key:mode")` for melodies/basslines and
`chord("...").voicing()` for harmony so parts can't clash.

## Mini-notation (inside double quotes)

| syntax | meaning | example |
|---|---|---|
| `a b c` | sequence, squeezed into one cycle | `"bd sd hh sd"` |
| `[a b]` | subdivide one step | `"bd [sd sd]"` |
| `<a b>` | alternate: one per cycle | `"<c e g>"` |
| `a*n` / `a/n` | faster / slower | `"hh*8"`, `"<c e>/2"` |
| `~` or `-` | rest | `"bd ~ sd ~"` |
| `a, b` | play in parallel | `"bd*2, hh*4"` |
| `a@n` | weight (length) | `"c@3 e"` |
| `a!n` | replicate | `"bd!3 sd"` |
| `a?` | 50% random drop (`?0.2` = 20%) | `"hh*8?"` |
| `a(k,n,r)` | euclidean rhythm | `"bd(3,8)"`, `"rim(5,8,2)"` |
| `a:i` | sample index / variant | `"hh:2"` |
| `a \| b` | random choice per cycle | `"bd \| cp"` |
| `_` | extend previous note | `"c _ _ e"` |

## Sounds

- Drums: `s("bd sd hh oh cp rim lt mt ht cr rd sh cb tb perc")`, then `.bank("RolandTR909")` (or TR808, TR707, LinnDrum, AkaiMPC60, …). `n("0 1 2")` or `"hh:3"` picks a variant.
- Synths (pitched via `note`/`n`): `sine triangle square sawtooth supersaw pulse`, noise: `white pink brown crackle`.
- Pitched samples / soundfonts: `piano`, `gm_epiano1`, `gm_acoustic_bass`, `gm_string_ensemble_1`, `gm_pad_warm`, `gm_vibraphone`, … (see `node scripts/strudel.mjs sounds <query>`). Soundfont variants: `"gm_epiano1:2"`.
- Notes: `note("c3 eb3 g3")` or MIDI numbers `note("48 51 55")`. Default octave is 3.
- Scales: `n("0 2 4 6").scale("D:dorian")` (degrees, 0-based, any octave via e.g. `"C4:minor"`). Modes: major minor dorian phrygian lydian mixolydian locrian, `minor:pentatonic`, `major:pentatonic`, `harmonic minor`, `melodic minor`, `blues`, `whole tone`, `chromatic`.
- Chords: `chord("<C^7 Am7 Dm7 G7>").voicing()` (`^7` = maj7, `m7`, `7`, `m9`, `sus`, `o` = dim, `h` = half-dim). `.anchor("C5")` sets voicing height, `.mode("below")`, `.dict('ireal')`. Bass from chords: `n("0").set(chords).mode("root:g2").voicing()`.
- Transposition: `.add(note(12))`, `.transpose(7)`, `.scaleTranspose(2)`.

## Loops, breaks and external samples

```js
samples('github:yaxu/clean-breaks')              // load a pack (top of the program)
s("funkydrummer").fit()                           // stretch sample to its event (1 cycle)
s("funkydrummer/2").fit()                         // spread over 2 cycles
s("amen1").loopAt(2).chop(16)                     // loop over 2 cycles, cut into 16 grains
s("breaks125").slice(8, "0 1 <2 2*2> 3 [4 0] 5 <6 1> 7")  // re-sequence slices
s("breaks152").splice(8, "0 1 2 3 4 5 6 7")       // like slice but time-stretched per slice
s("sesame").fit().scrub("{0 .25 .5 .75}%8")       // jump around inside a loop
```

`node scripts/strudel.mjs sounds break` lists loop packs with durations and tempo guesses; choose
`setcps` so the loop's natural tempo matches (bpm/60/4 per bar).

## Effects (all patternable: `.lpf("<400 800 1600>")`)

- Filters: `.lpf(800).lpq(8)`, `.hpf(200)`, `.bpf(1000)`, envelope `.lpenv(4).lpa(.01).lpd(.2)`, DJ filter `.djf(.3)`.
- Amp envelope: `.attack(.01).decay(.2).sustain(.5).release(.3)` or `.adsr(".01:.2:.5:.3")`, `.clip(.5)` shortens notes.
- Level: `.gain(.8)`, `.velocity(".8 .5")`, `.postgain(1.2)`; keep total level sane (≤ ~5 layers at gain ≤ 1).
- Space: `.room(.4).size(4)`, `.delay(.3).delaytime(3/16).delayfeedback(.4)`, `.pan(sine.slow(4))`, `.orbit(2)` separates effect buses.
- Color: `.shape(.3)`, `.distort(2)`, `.crush(6)`, `.coarse(4)`, `.phaser(2)`, `.vowel("<a e i o>")`, `.fm(2).fmh(1.5)`, `.vib(4).vibmod(.2)`.
- Sidechain feel: put the kick on its own orbit and `.duckorbit(2)` on others (see `node scripts/strudel.mjs fn duckorbit`).

## Pattern transformations (musical variation)

- Time: `.fast(2)`, `.slow(2)`, `.early(1/8)`, `.late(1/16)`, `.swingBy(1/3, 4)`, `.ply(2)`, `.hurry(2)`.
- Every n cycles: `.firstOf(4, x=>x.rev())`, `.lastOf(4, x=>x.fast(2))`, `.every(4, fast(2))`.
- Chance: `.sometimes(x=>x.speed(2))`, `.often(...)`, `.rarely(...)`, `.degradeBy(.3)`, `.sometimesBy(.2, ...)` (seeded, deterministic per cycle).
- Structure: `.struct("x ~ x x")`, `.mask("<1 [1 0]>")`, `.euclid(3,8)`, `.chunk(4, x=>x.add(note(7)))`, `.iter(4)`, `.palindrome()`, `.rev()`.
- Layering: `.jux(rev)` (stereo), `.off(1/8, x=>x.add(note(12)))` (canon/echo), `.superimpose(x=>x.add(note(.1)))`, `.layer(f1, f2)`, `.echo(3, 1/8, .6)`.
- Continuous signals: `sine`, `cosine`, `saw`, `tri`, `square`, `rand`, `perlin`, `irand(8)` → `.range(200, 2000).slow(8)`, use `.segment(16)` to sample them into steps.
- Song form: `arrange([8, intro], [16, verse], [8, drop])`, `cat(a, b)`/`"<...>"` for per-cycle alternation, `.mask("<0!4 1!12>")` to bring parts in/out.

## What makes it musical (the evaluator checks these)

1. **One key**: all pitched parts from the same scale or chord progression. Put chord tones on strong beats.
2. **Consonance**: avoid stacking minor 2nds/tritones across parts. Use voicings, and keep bass below ~C3 with only one bass note sounding at a time.
3. **Groove**: rhythms on a 16th/triplet grid, a clear pulse (kick/hat/bass anchoring beats), with syncopation used deliberately.
4. **Repetition with variation**: motifs repeat every 1, 2 or 4 cycles; variation via `<>` alternation, `firstOf/lastOf`, filter movement, fills every 4th or 8th cycle.
5. **Arrangement**: distinct roles (drums, bass, harmony, melody/texture) in distinct registers; 3–5 layers is usually enough.
6. **Mix**: no clipping (lower `gain`, fewer distorted layers), bass not overwhelming (`.lpf` on bass, `.hpf` on pads), some space (`room`, `delay`) but not drowning.
7. **Genre fit**: tempo and sound palette appropriate for the request (e.g. house 120–126 bpm four-on-the-floor; DnB 170–175 bpm breaks; lo-fi 70–90 bpm swung drums + epiano; ambient: slow, sparse, long release, lots of reverb).

## Common mistakes

- Chaining after a string: write `note("c e").fast(2)` not `"c e".fast(2).note()` unless you know it's valid (in the REPL, double-quoted strings are patterns, so `"c e".fast(2)` does work, but single-quoted strings are plain JS strings).
- `.scale()` applies to `n()` degrees, not to `note()` names.
- Unknown sound names are silent. Check with `node scripts/strudel.mjs sounds <name>` first.
- Visual functions (`.pianoroll()`, `._scope()`) are fine in the editor but add nothing to the sound.
- `samples(...)` must come before the patterns that use it.
