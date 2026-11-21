// The living parts of the womb sound: a heartbeat that is not metronomic,
// slow breathing, and occasional tummy sounds. Pure generators that return
// sample arrays; the sound engine loops them.
//
// Shaped after a third-trimester abdominal recording published with
// Parga et al. 2018 (PLoS ONE 13(5): e0197045, CC BY). Measured there:
//   - energy concentrated between 80 and 250 Hz,
//   - short low thumps at the mother's heart rate (78 per minute),
//   - a slow swell at the breathing rate (19 per minute),
//   - loudness that moves by about 14 dB, where a plain noise bed is flat.
// Only measurements were taken from the recording; no audio from it is used.

const TAU = 2 * Math.PI;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Small seeded random generator, so tests can reproduce a timeline. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rng) {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * rng());
}

function peakOf(x) {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
}

function scale(x, g) {
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}

/** Add a smooth bump (fast rise, slower fall), wrapping round the loop end. */
function addBump(buf, sr, centre, rise, fall, amp) {
  const n = buf.length;
  const from = Math.floor((centre - 4 * rise) * sr);
  const to = Math.ceil((centre + 4 * fall) * sr);
  for (let i = from; i <= to; i++) {
    const d = i / sr - centre;
    const w = d < 0 ? rise : fall;
    buf[((i % n) + n) % n] += amp * Math.exp(-0.5 * (d / w) * (d / w));
  }
}

/** Add a short damped low tone whose pitch falls a little: a heart sound. */
function addThump(buf, sr, start, f0, f1, decay, amp) {
  const n = buf.length;
  const len = Math.ceil(6 * decay * sr);
  const first = Math.round(start * sr);
  let phase = 0;
  for (let k = 0; k < len; k++) {
    const t = k / sr;
    const f = f0 + (f1 - f0) * Math.min(1, t / (3 * decay));
    phase += (TAU * f) / sr;
    const env = (1 - Math.exp(-t / 0.006)) * Math.exp(-t / decay);
    const i = first + k;
    buf[((i % n) + n) % n] += amp * env * Math.sin(phase);
  }
}

/**
 * A run of heartbeats as two loops of equal length:
 *   env   - 0..1 control signal for the blood-flow "whoosh"
 *   thump - the two heart sounds of each beat, as audio
 * `variation` 0 is a metronome; 1 is a relaxed adult (about 5% beat-to-beat
 * change, plus the heart speeding up a little on each in-breath).
 */
export function heartTimeline({ bpm = 75, beats = 64, variation = 0.4, sampleRate = 8000, rng = Math.random } = {}) {
  const mean = 60 / bpm;
  let durs = [];
  let breath = rng() * TAU;
  for (let i = 0; i < beats; i++) {
    breath += (TAU * mean) / 3.6;
    const d = 1 + variation * (0.05 * gauss(rng) + 0.04 * Math.sin(breath));
    durs.push(clamp(d, 0.75, 1.3));
  }
  const total = durs.reduce((a, b) => a + b, 0);
  durs = durs.map((d) => (d * beats * mean) / total); // keep the average rate exact

  const n = Math.round(beats * mean * sampleRate);
  const env = new Float32Array(n);
  const thump = new Float32Array(n);
  const beatTimes = [];
  let t = 0;
  for (let i = 0; i < beats; i++) {
    beatTimes.push(t);
    const amp = clamp(1 + variation * 0.12 * gauss(rng), 0.7, 1.3);
    // Systole lasts about the same whatever the heart rate, so these offsets
    // are in seconds, not fractions of the beat.
    addThump(thump, sampleRate, t, 112, 88, 0.03, amp);
    addThump(thump, sampleRate, t + 0.31, 135, 110, 0.022, 0.6 * amp);
    addBump(env, sampleRate, t + 0.12, 0.045, 0.13, amp);
    addBump(env, sampleRate, t + 0.4, 0.04, 0.11, 0.45 * amp);
    t += durs[i];
  }
  scale(env, 1 / peakOf(env));
  scale(thump, 0.6 / peakOf(thump));
  return { env, thump, beatTimes, duration: n / sampleRate, sampleRate };
}

/** Slow breathing as a 0..1 control loop: rise on the in-breath, longer fall. */
export function breathTimeline({ rate = 16, breaths = 12, variation = 0.5, sampleRate = 8000, rng = Math.random } = {}) {
  const mean = 60 / rate;
  const parts = [];
  let total = 0;
  for (let i = 0; i < breaths; i++) {
    const len = Math.round(mean * clamp(1 + 0.12 * variation * gauss(rng), 0.7, 1.4) * sampleRate);
    const depth = clamp(1 - 0.2 * variation * Math.abs(gauss(rng)), 0.6, 1);
    parts.push({ len, depth });
    total += len;
  }
  const env = new Float32Array(total);
  let at = 0;
  for (const { len, depth } of parts) {
    const inhale = Math.round(len * 0.4);
    for (let i = 0; i < len; i++) {
      const x = i < inhale ? i / inhale : 1 - (i - inhale) / (len - inhale);
      env[at + i] = depth * (0.5 - 0.5 * Math.cos(Math.PI * x));
    }
    at += len;
  }
  return { env, duration: total / sampleRate, sampleRate };
}

/**
 * Tummy sounds: irregular clusters of low bubbles and the odd longer growl,
 * with quiet stretches between. Everything stays below about 210 Hz, well
 * under the pitch range the cry detector listens in.
 */
export function gutLoop({ seconds = 83, sampleRate = 8000, meanGap = 8, rng = Math.random } = {}) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);

  function bubble(start, dur, f0, f1, amp) {
    const len = Math.round(dur * sampleRate);
    const first = Math.round(start * sampleRate);
    let phase = 0;
    for (let k = 0; k < len && first + k < n; k++) {
      const x = k / len;
      phase += (TAU * (f0 + (f1 - f0) * x)) / sampleRate;
      const env = Math.sin(Math.PI * Math.pow(x, 0.6)) ** 2; // soft start, peak early
      out[first + k] += amp * env * Math.sin(phase);
    }
  }

  function growl(start, dur, amp) {
    const len = Math.round(dur * sampleRate);
    const first = Math.round(start * sampleRate);
    const f0 = 88 + rng() * 40;
    const drift = (rng() - 0.5) * 30;
    const flutter = 16 + rng() * 14;
    let phase = 0;
    for (let k = 0; k < len && first + k < n; k++) {
      const x = k / len;
      phase += (TAU * (f0 + drift * x)) / sampleRate;
      const env = Math.sin(Math.PI * Math.pow(x, 0.7)) ** 2;
      const trem = 0.55 + 0.45 * Math.sin((TAU * flutter * k) / sampleRate);
      out[first + k] += amp * env * trem * Math.sin(phase);
    }
  }

  let t = 2 + rng() * 3;
  while (t < seconds - 4) {
    if (rng() < 0.65) {
      const count = 2 + Math.floor(rng() * 6);
      let at = t;
      for (let i = 0; i < count; i++) {
        const f0 = 85 + rng() * 105;
        const f1 = clamp(f0 * (0.7 + rng() * 0.8), 80, 210);
        bubble(at, 0.07 + rng() * 0.16, f0, f1, 0.3 + rng() * 0.7);
        at += 0.06 + rng() * 0.22;
      }
    } else {
      growl(t, 0.6 + rng() * 1.0, 0.5 + rng() * 0.5);
    }
    t += 2.5 + -Math.log(1 - rng()) * (meanGap - 2.5);
  }
  const p = peakOf(out);
  if (p > 0) scale(out, 0.5 / p);
  return { samples: out, duration: seconds, sampleRate };
}
