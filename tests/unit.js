// Unit tests. Open tests/unit.html in a browser, or run tests/run_tests.py.

import { step, initialState, DEFAULT_TIMINGS } from '../js/state-machine.js';
import { wombResponseDb, WOMB_PRESETS } from '../js/womb-filter.js';
import { levelGains, capToGain, heartbeatEnvelope } from '../js/sound-engine.js';
import { createHeuristic } from '../js/heuristic.js';
import { heartTimeline, breathTimeline, gutLoop, mulberry32 } from '../js/womb-sounds.js';
import { biquadCoeffs, biquadInPlace, makeSeamless, rms } from '../js/dsp.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function assert(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed');
}
function equal(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message || 'not equal'}: expected ${expected}, got ${actual}`);
}
function near(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message || 'not near'}: expected ${expected} ± ${tolerance}, got ${actual.toFixed(3)}`);
  }
}

// ------------------------------------------------- state machine harness

/** Drives the machine with one detection window per second. */
class Sim {
  constructor(cfg = {}) {
    this.cfg = { ...DEFAULT_TIMINGS, ...cfg };
    this.state = initialState();
    this.t = 0;
    this.effects = [];
    this.send({ type: 'start' });
  }
  send(event) {
    const r = step(this.state, { ...event, t: this.t }, this.cfg);
    this.state = r.state;
    this.effects.push(...r.effects);
    return r.effects;
  }
  /** `seconds` windows of crying (true) or quiet (false). */
  run(seconds, crying) {
    for (let i = 0; i < seconds; i++) {
      this.t += 1;
      this.send({ type: 'window', crying });
    }
    return this;
  }
  kinds() {
    return this.effects.filter((e) => e.type === 'event').map((e) => e.kind);
  }
  get level() { return this.state.level; }
  get mode() { return this.state.mode; }
}

test('starts at baseline, running', () => {
  const s = new Sim();
  equal(s.mode, 'running');
  equal(s.level, 0);
});

test('one or two cry windows do not escalate', () => {
  const s = new Sim();
  s.run(1, true).run(10, false);
  equal(s.level, 0, 'single window');
  s.run(2, true).run(10, false);
  equal(s.level, 0, 'two windows');
  assert(!s.kinds().includes('cry-start'), 'no cry event');
});

test('three of five windows crying goes to level 1', () => {
  const s = new Sim();
  s.run(1, true).run(1, false).run(1, true).run(1, false);
  equal(s.level, 0, 'two of four');
  s.run(1, true);
  equal(s.level, 1, 'three of five');
  assert(s.kinds().includes('cry-start'));
});

test('continued crying steps up one level every 25 seconds', () => {
  const s = new Sim();
  s.run(3, true);
  equal(s.level, 1);
  s.run(24, true);
  equal(s.level, 1, 'not yet');
  s.run(1, true);
  equal(s.level, 2, 'after 25 s');
  s.run(25, true);
  equal(s.level, 3);
  s.run(25, true);
  equal(s.level, 4);
});

test('never goes above the top level', () => {
  const s = new Sim({ giveUpAfterSec: 100000 });
  s.run(600, true);
  equal(s.level, 4);
  assert(s.effects.every((e) => e.type !== 'level' || e.to <= 4), 'no level above 4');
});

test('gives up after 150 seconds of crying at the top level', () => {
  const s = new Sim();
  s.run(3 + 75, true); // reaches level 4 at t = 78
  equal(s.level, 4);
  s.run(149, true);
  equal(s.mode, 'running', 'still trying');
  s.run(2, true);
  equal(s.mode, 'needsYou');
  equal(s.level, 0, 'back at baseline');
  assert(s.kinds().includes('needs-you'));
});

test('after giving up, more crying does not escalate again', () => {
  const s = new Sim();
  s.run(400, true);
  equal(s.mode, 'needsYou');
  equal(s.level, 0);
  assert(s.effects.filter((e) => e.type === 'event' && e.kind === 'needs-you').length === 1, 'gives up once');
});

test('needs-you state re-arms after 5 minutes of quiet', () => {
  const s = new Sim();
  s.run(300, true);
  equal(s.mode, 'needsYou');
  s.run(290, false);
  equal(s.mode, 'needsYou', 'not yet');
  s.run(15, false);
  equal(s.mode, 'running');
  s.run(3, true);
  equal(s.level, 1, 'responds again');
});

test('needs-you state can be acknowledged by hand', () => {
  const s = new Sim();
  s.run(300, true);
  s.send({ type: 'ack' });
  equal(s.mode, 'running');
  equal(s.level, 0);
});

test('quiet steps down one level per minute, back to baseline', () => {
  const s = new Sim();
  s.run(3 + 50, true);
  equal(s.level, 3);
  s.run(3, false); // the "3 of 5" memory takes a few seconds to clear
  s.run(59, false);
  equal(s.level, 3, 'not yet');
  s.run(2, false);
  equal(s.level, 2);
  s.run(60, false);
  equal(s.level, 1);
  s.run(60, false);
  equal(s.level, 0);
  assert(s.kinds().includes('settled'));
});

test('crying that returns while calming down escalates at once', () => {
  const s = new Sim();
  s.run(3 + 25, true);
  equal(s.level, 2);
  s.run(70, false);
  equal(s.level, 1);
  s.run(3, true);
  equal(s.level, 2, 'back up without waiting');
});

test('short breaks in crying at the top level do not reset the give-up clock', () => {
  const s = new Sim();
  s.run(78, true);
  equal(s.level, 4);
  for (let i = 0; i < 20; i++) s.run(8, true).run(2, false);
  equal(s.mode, 'needsYou');
});

test('pause ignores crying and ends by itself', () => {
  const s = new Sim();
  s.run(30, true);
  equal(s.level, 2);
  s.send({ type: 'pause' });
  equal(s.mode, 'paused');
  equal(s.level, 0, 'baseline while paused');
  s.run(1199, true);
  equal(s.mode, 'paused');
  equal(s.level, 0);
  s.run(2, false);
  equal(s.mode, 'running');
  s.run(3, true);
  equal(s.level, 1, 'responds after the pause');
});

test('pause can be ended by hand, and by a tick with no windows', () => {
  const s = new Sim();
  s.send({ type: 'pause' });
  s.send({ type: 'resume' });
  equal(s.mode, 'running');
  s.send({ type: 'pause' });
  s.t += 1300;
  s.send({ type: 'tick' });
  equal(s.mode, 'running');
});

test('a frozen tab does not count as minutes of crying', () => {
  const s = new Sim();
  s.run(78, true);
  equal(s.level, 4);
  s.t += 3600; // an hour with no windows
  s.send({ type: 'window', crying: true });
  equal(s.mode, 'running', 'one window is not 150 s of crying');
});

test('custom timings are respected', () => {
  const s = new Sim({ escalateEverySec: 10, quietStepDownSec: 20, windowsNeeded: 2 });
  s.run(2, true);
  equal(s.level, 1);
  s.run(10, true);
  equal(s.level, 2);
  s.run(4, false).run(21, false);
  equal(s.level, 1);
});

test('stop returns to idle and ignores windows', () => {
  const s = new Sim();
  s.run(30, true);
  s.send({ type: 'stop' });
  equal(s.mode, 'idle');
  equal(s.level, 0);
  s.run(10, true);
  equal(s.level, 0);
});

// ------------------------------------------------------------ womb filter

test('womb filter, gentle: about -3 dB at the cutoff, 6 dB per octave above', () => {
  const [at300, at2400, at4800] = wombResponseDb({ cutoff: 300, slope: 6, bodyBoostDb: 0 }, [300, 2400, 4800]);
  near(at300, -3, 0.8, 'at cutoff');
  near(at2400, -18, 1.5, 'three octaves up');
  near(at2400 - at4800, 6, 1.2, 'slope per octave');
});

test('womb filter, medium and steep slopes', () => {
  const [m] = wombResponseDb({ cutoff: 400, slope: 12, bodyBoostDb: 0 }, [1600]);
  near(m, -24, 1.5, '12 dB per octave, two octaves up');
  const [d] = wombResponseDb({ cutoff: 400, slope: 24, bodyBoostDb: 0 }, [1600]);
  near(d, -48, 2.5, '24 dB per octave, two octaves up');
});

test('womb filter passes the low end and removes sub-bass', () => {
  const [at30, at150] = wombResponseDb({ cutoff: 300, slope: 6, bodyBoostDb: 3 }, [30, 150]);
  assert(at30 < -9, 'sub-bass is cut: ' + at30.toFixed(1));
  assert(at150 > -1 && at150 < 4, 'low end passes with a little warmth: ' + at150.toFixed(1));
});

test('womb filter response falls steadily above the cutoff for every preset', () => {
  const freqs = [500, 1000, 2000, 4000, 8000];
  for (const [name, preset] of Object.entries(WOMB_PRESETS)) {
    const r = wombResponseDb(preset, freqs);
    for (let i = 1; i < r.length; i++) assert(r[i] < r[i - 1] - 3, `${name} keeps falling at ${freqs[i]} Hz`);
    assert(r[3] < -15, `${name} removes consonant range (${r[3].toFixed(1)} dB at 4 kHz)`);
  }
});

// ------------------------------------------------------------ sound maths

test('levels get louder and add shush; level 4 is full scale', () => {
  let prev = levelGains(0, -16);
  near(prev.rumble, Math.pow(10, -16 / 20), 1e-6, 'baseline gain');
  equal(prev.shush, 0, 'no shush at baseline');
  for (let l = 1; l <= 4; l++) {
    const g = levelGains(l, -16);
    assert(g.rumble > prev.rumble && g.shush > prev.shush, `level ${l} is louder`);
    prev = g;
  }
  near(prev.rumble, 1, 1e-9, 'level 4');
});

test('volume cap maps 2 points to 1 dB and reaches silence', () => {
  equal(capToGain(0), 0);
  near(capToGain(100), 1, 1e-9);
  near(20 * Math.log10(capToGain(88)), -6, 1e-6);
  assert(capToGain(40) < capToGain(41));
});

test('heartbeat envelope stays within 0..1 and has two beats', () => {
  const e = heartbeatEnvelope(1000);
  let max = 0, min = 1;
  e.forEach((v) => { max = Math.max(max, v); min = Math.min(min, v); });
  near(max, 1, 1e-6);
  assert(min >= 0);
  assert(e[160] > 0.95 && e[500] > 0.4 && e[500] < 0.6 && e[900] < 0.05, 'surge, echo, rest');
});

test('seamless loop: the end of the buffer flows into its start', () => {
  const n = 48000, fade = 4800;
  const x = new Float32Array(n + fade);
  let y = 0;
  for (let i = 0; i < x.length; i++) { y = 0.995 * y + (Math.random() - 0.5) * 0.1; x[i] = y; }
  const out = makeSeamless(x, fade);
  equal(out.length, n);
  const typical = rms(out) * 0.2;
  assert(Math.abs(out[0] - out[n - 1]) < typical, 'no jump at the loop point');
});

// ------------------------------------------------- heart, breath, tummy

/** Rough pitch of a stretch of audio, from how often it crosses zero. */
function zeroCrossRate(x, sr, from = 0, to = x.length) {
  let n = 0;
  for (let i = from + 1; i < to; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) n++;
  return (n / 2) / ((to - from) / sr);
}

test('heartbeat: average rate is exact and variation 0 is a metronome', () => {
  const steady = heartTimeline({ bpm: 75, beats: 64, variation: 0, rng: mulberry32(1) });
  near(steady.duration, 64 * 0.8, 0.001, 'loop length');
  for (let i = 1; i < steady.beatTimes.length; i++) {
    near(steady.beatTimes[i] - steady.beatTimes[i - 1], 0.8, 1e-9, 'even beats');
  }
  const loose = heartTimeline({ bpm: 60, beats: 64, variation: 1, rng: mulberry32(1) });
  near(loose.duration, 64, 0.001, 'average rate kept with variation');
});

test('heartbeat: variation makes beats uneven, within a healthy range', () => {
  const t = heartTimeline({ bpm: 75, beats: 64, variation: 1, rng: mulberry32(7) });
  const gaps = t.beatTimes.slice(1).map((b, i) => b - t.beatTimes[i]);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
  assert(sd / mean > 0.02 && sd / mean < 0.1, 'spread ' + (100 * sd / mean).toFixed(1) + '%');
  assert(Math.min(...gaps) > 0.55 && Math.max(...gaps) < 1.1, 'no absurd beats');
});

test('heartbeat: whoosh stays within 0..1, thump is low and bounded', () => {
  const t = heartTimeline({ bpm: 75, variation: 0.4, rng: mulberry32(3) });
  let lo = 1, hi = 0, peak = 0;
  for (let i = 0; i < t.env.length; i++) {
    lo = Math.min(lo, t.env[i]);
    hi = Math.max(hi, t.env[i]);
    peak = Math.max(peak, Math.abs(t.thump[i]));
  }
  assert(lo >= 0, 'envelope never negative');
  near(hi, 1, 1e-6, 'envelope peak');
  near(peak, 0.6, 1e-6, 'thump peak');
  equal(t.env.length, t.thump.length, 'both loops the same length');
  const first = Math.round(t.beatTimes[5] * t.sampleRate);
  const pitch = zeroCrossRate(t.thump, t.sampleRate, first, first + Math.round(0.08 * t.sampleRate));
  assert(pitch > 70 && pitch < 150, 'thump pitch ' + pitch.toFixed(0) + ' Hz');
});

test('heartbeat: the same seed gives the same timeline', () => {
  const a = heartTimeline({ rng: mulberry32(42) });
  const b = heartTimeline({ rng: mulberry32(42) });
  assert(a.env.every((v, i) => v === b.env[i]), 'identical envelopes');
});

test('breathing: one smooth swell per breath, loops without a jump', () => {
  const t = breathTimeline({ rate: 16, breaths: 12, rng: mulberry32(5) });
  near(t.duration, 12 * 3.75, 6, 'about 12 breaths long');
  let peaks = 0, hi = 0, lo = 1;
  for (let i = 1; i < t.env.length - 1; i++) {
    if (t.env[i - 1] < 0.3 && t.env[i] >= 0.3) peaks++; // one upward crossing per breath
    hi = Math.max(hi, t.env[i]);
    lo = Math.min(lo, t.env[i]);
  }
  equal(peaks, 12, 'peaks');
  assert(lo >= 0 && hi <= 1, 'within 0..1');
  assert(t.env[0] < 0.01 && t.env[t.env.length - 1] < 0.01, 'starts and ends at rest');
});

test('breathing: the rate asked for is the rate you get', () => {
  for (const rate of [10, 16, 24]) {
    const breaths = Math.round(rate * 0.75);
    const t = breathTimeline({ rate, breaths, variation: 1, rng: mulberry32(rate) });
    near(t.duration, (breaths * 60) / rate, 0.01, rate + ' a minute');
    let swells = 0;
    for (let i = 1; i < t.env.length; i++) if (t.env[i - 1] < 0.3 && t.env[i] >= 0.3) swells++;
    equal(swells, breaths, 'swells at ' + rate + ' a minute');
  }
});

test('tummy sounds: sparse, low, bounded, and silent at the loop point', () => {
  const t = gutLoop({ seconds: 83, rng: mulberry32(9) });
  const sr = t.sampleRate, x = t.samples;
  let peak = 0, active = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    peak = Math.max(peak, a);
    if (a > 0.01) active++;
  }
  near(peak, 0.5, 1e-6, 'peak');
  const share = active / x.length;
  assert(share > 0.02 && share < 0.4, 'sounding ' + (100 * share).toFixed(0) + '% of the time');
  assert(rms(x, 0, 1.9 * sr) === 0, 'silent at the start');
  assert(rms(x, x.length - sr, x.length) === 0, 'silent at the end');
  // No sound up in the cry detector's pitch range (250 Hz and above).
  let loudest = 0, at = 0;
  for (let i = 0; i + 400 < x.length; i += 400) {
    const r = rms(x, i, i + 400);
    if (r > loudest) { loudest = r; at = i; }
  }
  const pitch = zeroCrossRate(x, sr, at, at + 400);
  assert(pitch < 230, 'loudest moment is at ' + pitch.toFixed(0) + ' Hz');
});

// -------------------------------------------------------- cry heuristic

const SR = 48000;

function noise(seconds, level) {
  const x = new Float32Array(SR * seconds);
  for (let i = 0; i < x.length; i++) x[i] = (Math.random() * 2 - 1) * level;
  return x;
}

/** A harmonic voice with vibrato: f0 450 Hz reads as a cry, 130 Hz as an adult. */
function voice(f0, level, seconds = 1) {
  const x = new Float32Array(SR * seconds);
  let phase = 0;
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    const f = f0 * (1 + 0.04 * Math.sin(2 * Math.PI * 6 * t));
    phase += (2 * Math.PI * f) / SR;
    const burst = t % 1 < 0.8 ? Math.min(1, (t % 1) / 0.05, (0.8 - (t % 1)) / 0.05) : 0;
    let v = 0;
    for (let h = 1; h <= 6; h++) v += Math.sin(h * phase) / h;
    x[i] = v * level * burst + (Math.random() * 2 - 1) * 0.002;
  }
  return x;
}

function rumble(seconds, level) {
  const x = new Float32Array(SR * seconds);
  let y = 0;
  for (let i = 0; i < x.length; i++) { y = 0.995 * y + (Math.random() * 2 - 1) * 0.1; x[i] = y; }
  biquadInPlace(x, biquadCoeffs('lowpass', 500, SR));
  const g = level / rms(x);
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}

function settle(h) {
  for (let i = 0; i < 5; i++) h.process(noise(1, 0.002));
}

test('heuristic: a quiet room scores zero', () => {
  const h = createHeuristic(SR);
  settle(h);
  equal(h.process(noise(1, 0.002)).score, 0);
});

test('heuristic: an infant-pitched cry scores high', () => {
  const h = createHeuristic(SR);
  settle(h);
  const r = h.process(voice(450, 0.1));
  assert(r.score > 0.45, 'score ' + r.score.toFixed(2));
  near(r.pitchHz, 450, 40, 'pitch');
});

test('heuristic: a low adult voice does not count as a cry', () => {
  const h = createHeuristic(SR);
  settle(h);
  const r = h.process(voice(130, 0.1));
  assert(r.score < 0.2, 'score ' + r.score.toFixed(2));
});

test("heuristic: the app's own rumble does not count as a cry", () => {
  const h = createHeuristic(SR);
  settle(h);
  let worst = 0;
  for (let i = 0; i < 5; i++) worst = Math.max(worst, h.process(rumble(1, 0.1)).score);
  assert(worst < 0.2, 'score ' + worst.toFixed(2));
});

test('heuristic: a cry is still found on top of the rumble', () => {
  const h = createHeuristic(SR);
  for (let i = 0; i < 5; i++) h.process(rumble(1, 0.05));
  const mix = rumble(1, 0.05);
  const cry = voice(450, 0.08);
  for (let i = 0; i < mix.length; i++) mix[i] += cry[i];
  const r = h.process(mix);
  assert(r.score > 0.3, 'score ' + r.score.toFixed(2));
});

// ----------------------------------------------------------------- runner

const out = document.getElementById('out');
let passed = 0;
const failures = [];
for (const t of tests) {
  const row = document.createElement('div');
  try {
    t.fn();
    passed++;
    row.className = 'pass';
    row.textContent = '✓ ' + t.name;
  } catch (err) {
    failures.push({ name: t.name, error: err.message });
    row.className = 'fail';
    row.textContent = '✗ ' + t.name;
    const pre = document.createElement('pre');
    pre.textContent = err.message;
    row.append(pre);
  }
  out.append(row);
}
document.getElementById('summary').textContent = `${passed} of ${tests.length} passed`;
window.__results = { total: tests.length, passed, failures };
