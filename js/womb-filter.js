// "Womb filter": makes any audio (music, a recorded voice) sound roughly as it
// would from inside the uterus.
//
// What the measurements say (see README for sources):
//   - Below about 250-300 Hz, sound passes through the abdomen almost
//     unchanged. The mother's own voice is even slightly enhanced there.
//   - Above that, attenuation grows with frequency. The classic sheep and
//     human figures are about 5-6 dB per octave; other measurements range
//     from a few dB to 40+ dB by 2 kHz, so the slope is adjustable.
//   - Melody, rhythm and intonation survive; consonants mostly do not.
//   - Everything sits on top of a low, pulsing cardiovascular background.
//
// The chain:
//   mono sum -> high-pass 60 Hz (small speakers cannot play lower)
//            -> low shelf  (optional "through the body" warmth below 250 Hz)
//            -> muffle     (low-pass, 6 / 12 / 24 dB per octave)
//            -> compressor (evens out loud and quiet passages)
//            -> pulse      (gain that the engine modulates with the heartbeat)

import { biquadCoeffs, onePoleCoeffs, sectionDb } from './dsp.js';

export const WOMB_PRESETS = {
  research: { label: 'Research-like', cutoff: 300, slope: 6, bodyBoostDb: 3 },
  muffled: { label: 'Muffled', cutoff: 450, slope: 12, bodyBoostDb: 3 },
  deep: { label: 'Deep', cutoff: 400, slope: 24, bodyBoostDb: 4 },
};

export const DEFAULT_WOMB = { cutoff: 300, slope: 6, bodyBoostDb: 3 };

const HP_HZ = 60;
const SHELF_HZ = 250;
const Q_BUTTER2 = Math.SQRT1_2;
const Q_BUTTER4 = [0.5412, 1.3066];

/** The filter sections for a set of options, as plain coefficients. */
export function wombSections(opts, fs) {
  const o = { ...DEFAULT_WOMB, ...opts };
  const sections = [biquadCoeffs('highpass', HP_HZ, fs, Q_BUTTER2)];
  if (o.bodyBoostDb) sections.push(biquadCoeffs('lowshelf', SHELF_HZ, fs, 1, o.bodyBoostDb));
  if (o.slope === 6) sections.push(onePoleCoeffs(o.cutoff, fs));
  else if (o.slope === 12) sections.push(biquadCoeffs('lowpass', o.cutoff, fs, Q_BUTTER2));
  else Q_BUTTER4.forEach((q) => sections.push(biquadCoeffs('lowpass', o.cutoff, fs, q)));
  return sections;
}

/** Frequency response in dB at each frequency, for drawing and for tests. */
export function wombResponseDb(opts, freqs, fs = 48000) {
  const sections = wombSections(opts, fs);
  return freqs.map((f) => sections.reduce((db, co) => db + sectionDb(co, f, fs), 0));
}

/**
 * Build the live chain on an AudioContext.
 * Returns { input, output, pulse, set(opts), setBypass(bool) }.
 */
export function createWombChain(ctx, opts = {}) {
  let current = { ...DEFAULT_WOMB, ...opts };
  let bypass = false;

  const input = ctx.createGain();
  input.channelCount = 1;
  input.channelCountMode = 'explicit';
  input.channelInterpretation = 'speakers';

  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = HP_HZ;
  hp.Q.value = Q_BUTTER2;

  const shelf = ctx.createBiquadFilter();
  shelf.type = 'lowshelf';
  shelf.frequency.value = SHELF_HZ;

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -24;
  comp.knee.value = 12;
  comp.ratio.value = 4;
  comp.attack.value = 0.02;
  comp.release.value = 0.4;

  const pulse = ctx.createGain();
  const output = ctx.createGain();

  input.connect(hp);
  comp.connect(pulse);
  pulse.connect(output);

  let muffle = [];

  function buildMuffle() {
    if (current.slope === 6) {
      const co = onePoleCoeffs(current.cutoff, ctx.sampleRate);
      return [ctx.createIIRFilter([co.b0, 0], [1, co.a1])];
    }
    const qs = current.slope === 12 ? [Q_BUTTER2] : Q_BUTTER4;
    return qs.map((q) => {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = current.cutoff;
      f.Q.value = q;
      return f;
    });
  }

  function rewire() {
    hp.disconnect();
    shelf.disconnect();
    muffle.forEach((n) => n.disconnect());
    if (bypass) {
      // A/B listening: keep the mono sum and the compressor, skip the filter.
      hp.connect(comp);
      return;
    }
    shelf.gain.value = current.bodyBoostDb || 0;
    muffle = buildMuffle();
    hp.connect(shelf);
    let prev = shelf;
    for (const n of muffle) {
      prev.connect(n);
      prev = n;
    }
    prev.connect(comp);
  }
  rewire();

  return {
    input,
    output,
    pulse,
    set(next) {
      current = { ...current, ...next };
      rewire();
    },
    setBypass(on) {
      bypass = !!on;
      rewire();
    },
    get options() {
      return { ...current };
    },
  };
}
