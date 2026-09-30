// The test loop: render a pattern in the real engine, analyse the events and
// the audio, and score how musical the result is.
import { getRenderer } from './renderer.mjs';
import { analyzeAudio } from './audio.mjs';
import { analyzeEvents, scoreMusicality, PROFILES } from './music.mjs';
import { spectrogramPng, pianoRollPng } from './plots.mjs';

export const PASS_SCORE = Number(process.env.PASS_SCORE ?? 70);
export { PROFILES };

/**
 * @param {string} code Strudel code
 * @param {{cycles?: number, profile?: string, images?: boolean, renderer?: object}} opts
 */
export async function evaluatePattern(code, { cycles = 8, profile = 'default', images = false, renderer = getRenderer() } = {}) {
  const run = await renderer.run(code, { cycles, render: true });
  const report = {
    ok: run.ok,
    error: run.error,
    cps: run.cps,
    cycles,
    missingSounds: run.missingSounds ?? [],
    renderError: run.renderError,
    fetchFailures: run.fetchFailures ?? [],
    warnings: (run.logs ?? []).filter((l) => l.type === 'error' || /not found|error|warn/i.test(l.message)).map((l) => l.message).slice(0, 10),
  };
  if (!run.ok) {
    return { report, ...scoreMusicality(report, { profile }), images: {} };
  }
  const events = analyzeEvents(run.haps, { cycles, cps: run.cps });
  let audio;
  if (run.wav) {
    try {
      audio = analyzeAudio(run.wav, { cps: run.cps });
    } catch (err) {
      report.renderError = `audio analysis failed: ${err.message}`;
    }
  }
  const scored = scoreMusicality({ ...report, events, audio }, { profile });
  const out = {
    report: {
      ...report,
      bpmIfCycleIsOneBar: +(run.cps * 60 * 4).toFixed(1),
      symbolic: events.metrics,
      audio: audio && Object.fromEntries(Object.entries(audio).filter(([k]) => !k.startsWith('_'))),
    },
    ...scored,
    pass: scored.score >= PASS_SCORE,
    images: {},
    wav: run.wav,
  };
  if (images) {
    if (audio) out.images.spectrogram = spectrogramPng(audio._spec, { cps: run.cps });
    const roll = pianoRollPng(events._events, { cycles });
    out.images.pianoRoll = roll.png;
    out.report.pianoRollLegend = roll.legend;
  }
  return out;
}

/** Human/LLM-readable summary of an evaluation. */
export function formatEvaluation(ev) {
  const { report, score, subscores, issues, profile } = ev;
  if (!report.ok) return `EVALUATION FAILED (score 0)\nError: ${report.error}`;
  const s = report.symbolic;
  const a = report.audio;
  const lines = [
    `MUSICALITY SCORE: ${score}/100 (${ev.pass ? 'PASS' : 'below pass mark ' + PASS_SCORE}, profile "${profile}")`,
    `Subscores: ${Object.entries(subscores).map(([k, v]) => `${k}=${v}`).join(', ')}`,
    `Tempo: cps=${report.cps} (${report.bpmIfCycleIsOneBar} bpm if 1 cycle = 1 bar of 4/4), analysed ${report.cycles} cycles`,
    `Events: ${s.events} (${s.eventsPerSecond}/s); voices: ${s.voices.map((v) => `${v.source}=${v.role}${v.medianNote !== undefined ? `@${Math.round(v.medianNote)}` : ''}`).join(', ')}`,
  ];
  if (s.key) lines.push(`Harmony: key ${s.key} (r=${s.keyCorrelation}, ${Math.round(s.inKeyRatio * 100)}% in key), roughness ${s.roughness}, max polyphony ${s.maxPolyphony}, range midi ${s.pitchRange.join('-')}`);
  lines.push(`Rhythm: on-grid ${Math.round(s.onGridRatio * 100)}%, IOI entropy ${s.ioiEntropy}, beat coverage ${Math.round(s.beatCoverage * 100)}%`);
  lines.push(`Form: repetition ${s.repetition} (by lag ${JSON.stringify(s.cycleSimilarity)}), ${s.distinctCycles} distinct cycles, first/second half similarity ${s.halfSimilarity}`);
  if (a) {
    lines.push(`Audio: RMS ${a.rmsDb} dBFS, peak ${a.peakDb} dBFS, clipping ${(a.clipRatio * 100).toFixed(3)}%, silence ${Math.round(a.silenceRatio * 100)}%, centroid ${a.spectralCentroidHz} Hz, bands ${JSON.stringify(a.bands)}, pulse clarity ${a.pulseClarity}, beat match ${a.pulseMatchesPattern}`);
  }
  if (report.missingSounds.length) lines.push(`Missing sounds: ${report.missingSounds.join(', ')}`);
  if (report.fetchFailures.length) lines.push(`Downloads failed (those sounds are silent): ${report.fetchFailures.slice(0, 5).join(', ')}`);
  if (report.warnings.length) lines.push(`Engine warnings: ${report.warnings.join(' | ')}`);
  if (issues.length) lines.push('Issues to fix:\n' + issues.map((i) => `- ${i}`).join('\n'));
  return lines.join('\n');
}
