// Small DSP helpers shared by the sound engine, the womb filter and the
// fallback cry heuristic. Pure functions: no Web Audio objects in here.

/** RBJ cookbook biquad coefficients, normalised so a0 = 1. */
export function biquadCoeffs(type, fc, fs, q = Math.SQRT1_2, gainDb = 0) {
  const w = (2 * Math.PI * fc) / fs;
  const c = Math.cos(w);
  const s = Math.sin(w);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lowpass' || type === 'highpass') {
    const alpha = s / (2 * q);
    a0 = 1 + alpha;
    a1 = -2 * c;
    a2 = 1 - alpha;
    if (type === 'lowpass') {
      b0 = (1 - c) / 2;
      b1 = 1 - c;
      b2 = (1 - c) / 2;
    } else {
      b0 = (1 + c) / 2;
      b1 = -(1 + c);
      b2 = (1 + c) / 2;
    }
  } else if (type === 'lowshelf') {
    // Shelf slope S = 1, the same shape Web Audio's BiquadFilterNode uses.
    const A = Math.pow(10, gainDb / 40);
    const alpha = (s / 2) * Math.SQRT2;
    const k = 2 * Math.sqrt(A) * alpha;
    b0 = A * (A + 1 - (A - 1) * c + k);
    b1 = 2 * A * (A - 1 - (A + 1) * c);
    b2 = A * (A + 1 - (A - 1) * c - k);
    a0 = A + 1 + (A - 1) * c + k;
    a1 = -2 * (A - 1 + (A + 1) * c);
    a2 = A + 1 + (A - 1) * c - k;
  } else {
    throw new Error('Unsupported biquad type: ' + type);
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** One-pole low-pass (6 dB per octave): y[n] = (1-a)·x[n] + a·y[n-1]. */
export function onePoleCoeffs(fc, fs) {
  const a = Math.exp((-2 * Math.PI * fc) / fs);
  return { b0: 1 - a, b1: 0, b2: 0, a1: -a, a2: 0 };
}

/** Magnitude in dB of a (bi)quad section at frequency f. */
export function sectionDb(co, f, fs) {
  const w = (2 * Math.PI * f) / fs;
  const c1 = Math.cos(w), s1 = Math.sin(w);
  const c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = co.b0 + co.b1 * c1 + co.b2 * c2;
  const ni = -(co.b1 * s1 + co.b2 * s2);
  const dr = 1 + co.a1 * c1 + co.a2 * c2;
  const di = -(co.a1 * s1 + co.a2 * s2);
  const mag2 = (nr * nr + ni * ni) / (dr * dr + di * di);
  return 10 * Math.log10(Math.max(mag2, 1e-20));
}

/** Run a biquad over an array in place. */
export function biquadInPlace(x, co) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const y = co.b0 * xi + co.b1 * x1 + co.b2 * x2 - co.a1 * y1 - co.a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = y;
    x[i] = y;
  }
  return x;
}

export function rms(x, start = 0, end = x.length) {
  let sum = 0;
  for (let i = start; i < end; i++) sum += x[i] * x[i];
  return Math.sqrt(sum / Math.max(1, end - start));
}

export function toDb(v) {
  return 20 * Math.log10(Math.max(v, 1e-9));
}

export function fromDb(db) {
  return Math.pow(10, db / 20);
}

export function normaliseRms(x, target) {
  const g = target / Math.max(rms(x), 1e-9);
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}

/**
 * Turn a noise array into one that loops without a click: the tail is
 * cross-faded into the head (equal power, since the two are uncorrelated).
 * Returns a new array that is `fadeLen` samples shorter.
 */
export function makeSeamless(x, fadeLen) {
  const len = x.length - fadeLen;
  const out = new Float32Array(len);
  out.set(x.subarray(0, len));
  for (let i = 0; i < fadeLen; i++) {
    const th = (i / fadeLen) * (Math.PI / 2);
    out[i] = x[i] * Math.sin(th) + x[len + i] * Math.cos(th);
  }
  return out;
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
