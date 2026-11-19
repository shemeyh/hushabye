// Sound engine: generated womb rumble + heartbeat "whoosh", five loudness
// levels, optional womb-filtered music and voice, and a hard volume cap.
//
// Signal flow:
//
//   brown noise --> tone low-pass --> rumble gain --+
//   band noise  ------------------->  shush gain  --+--> whoosh (heartbeat AM) --+
//   <audio> files --> womb chain --> leveler --> track gain ----------------------+
//   voice clip    --> womb chain ------------> voice gain -----------------------+
//                                                                                |
//        speakers <-- safety mute <-- CAP <-- fade <-- hard clip <-- limiter <---+
//
// The cap is applied after a limiter and a hard clipper, so nothing upstream
// (levels, music, voice, any combination) can push the output above it.

import { createWombChain, DEFAULT_WOMB } from './womb-filter.js';
import { biquadCoeffs, biquadInPlace, clamp, fromDb, makeSeamless, normaliseRms } from './dsp.js';

export const DEFAULT_SOUND = {
  cap: 75,             // 0-100; every 2 points is 1 dB; 100 = full scale
  baselineDb: -12,     // how far below the loudest level the baseline sits
  bpm: 75,             // heartbeat rate of the whoosh
  whooshDepth: 0.35,   // 0 = steady, 1 = fully pulsing
  tone: 500,           // rumble low-pass, Hz
  trackVolume: 50,     // 0-100
  voiceVolume: 40,     // 0-100
  voiceGapSec: 8,      // silence between repeats of the voice clip
  womb: { ...DEFAULT_WOMB },
  wombBypass: false,
  outputPath: 'direct', // 'direct' | 'element' (through an <audio> element)
};

const MAX_LEVEL = 4;
const NOISE_RMS = 0.16;
const SHUSH_MIX_AT_TOP = 0.45;
const TRACK_TARGET_RMS = 0.1;
const LEVEL_TC = 1.2;      // seconds; time constant of level changes
const ENV_BPM = 75;

export function capToGain(cap) {
  if (cap <= 0) return 0;
  return fromDb((clamp(cap, 0, 100) - 100) / 2);
}

export function capToDb(cap) {
  return (clamp(cap, 0, 100) - 100) / 2;
}

/** Gains for a level: overall loudness and how much mid-range "shush". */
export function levelGains(level, baselineDb) {
  const frac = clamp(level, 0, MAX_LEVEL) / MAX_LEVEL;
  const gain = fromDb(baselineDb * (1 - frac));
  return { rumble: gain, shush: gain * SHUSH_MIX_AT_TOP * frac };
}

function volumeToGain(v) {
  const x = clamp(v, 0, 100) / 100;
  return x * x;
}

function brownNoise(sr, seconds) {
  const fade = Math.floor(sr * 0.5);
  const x = new Float32Array(Math.floor(sr * seconds) + fade);
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    y = 0.995 * y + (Math.random() * 2 - 1) * 0.1;
    x[i] = y;
  }
  // Remove what a small speaker cannot reproduce; it only eats headroom.
  biquadInPlace(x, biquadCoeffs('highpass', 45, sr));
  return normaliseRms(makeSeamless(x, fade), NOISE_RMS);
}

function shushNoise(sr, seconds) {
  const fade = Math.floor(sr * 0.5);
  const x = new Float32Array(Math.floor(sr * seconds) + fade);
  for (let i = 0; i < x.length; i++) x[i] = Math.random() * 2 - 1;
  biquadInPlace(x, biquadCoeffs('highpass', 700, sr));
  biquadInPlace(x, biquadCoeffs('lowpass', 3500, sr));
  return normaliseRms(makeSeamless(x, fade), NOISE_RMS);
}

/** One heartbeat of the whoosh envelope, 0..1: a strong surge and a softer echo. */
export function heartbeatEnvelope(n) {
  const bump = (p, centre, rise, fall) => {
    const d = p - centre;
    const w = d < 0 ? rise : fall;
    return Math.exp(-0.5 * (d / w) * (d / w));
  };
  const e = new Float32Array(n);
  let max = 0;
  for (let i = 0; i < n; i++) {
    const p = i / n;
    e[i] = bump(p, 0.16, 0.06, 0.16) + 0.45 * bump(p, 0.5, 0.05, 0.14);
    if (e[i] > max) max = e[i];
  }
  for (let i = 0; i < n; i++) e[i] /= max;
  return e;
}

function toBuffer(ctx, data) {
  const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
  buf.copyToChannel(data, 0);
  return buf;
}

function loopSource(ctx, buffer) {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  return src;
}

export class SoundEngine extends EventTarget {
  constructor(options = {}) {
    super();
    this.options = { ...DEFAULT_SOUND, ...options, womb: { ...DEFAULT_WOMB, ...(options.womb || {}) } };
    this.ctx = null;
    this.level = 0;
    this.tracks = [];
    this.trackIndex = 0;
    this.voiceBlob = null;
    this.safetyMuted = false;
  }

  get running() {
    return !!this.ctx;
  }

  async start() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC({ latencyHint: 'playback' });
    this.ctx = ctx;
    const sr = ctx.sampleRate;
    const o = this.options;

    // ---- master section ----
    this.mix = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.1;
    this.clipper = ctx.createWaveShaper();
    this.clipper.curve = new Float32Array([-1, 1]); // linear inside ±1, clamps outside
    this.fade = ctx.createGain();
    this.fade.gain.value = 0;
    this.capGain = ctx.createGain();
    this.capGain.gain.value = capToGain(o.cap);
    this.safety = ctx.createGain();
    this.safety.gain.value = this.safetyMuted ? 0 : 1;
    this.outAnalyser = ctx.createAnalyser();
    this.outAnalyser.fftSize = 2048;

    this.mix.connect(this.limiter);
    this.limiter.connect(this.clipper);
    this.clipper.connect(this.fade);
    this.fade.connect(this.capGain);
    this.capGain.connect(this.safety);
    this.safety.connect(this.outAnalyser);

    if (o.outputPath === 'element') {
      this.streamDest = ctx.createMediaStreamDestination();
      this.safety.connect(this.streamDest);
      this.outEl = new Audio();
      this.outEl.srcObject = this.streamDest.stream;
      this.outEl.play().catch((err) => this._emit('warning', { message: 'Output element could not play: ' + err.message }));
    } else {
      this.safety.connect(ctx.destination);
    }

    // ---- generated womb sound ----
    this.rumbleSrc = loopSource(ctx, toBuffer(ctx, brownNoise(sr, 29)));
    this.shushSrc = loopSource(ctx, toBuffer(ctx, shushNoise(sr, 23)));
    this.rumbleLP = ctx.createBiquadFilter();
    this.rumbleLP.type = 'lowpass';
    this.rumbleLP.frequency.value = o.tone;
    this.rumbleLP.Q.value = 0.7;
    this.rumbleGain = ctx.createGain();
    this.shushGain = ctx.createGain();
    this.whoosh = ctx.createGain();

    this.rumbleSrc.connect(this.rumbleLP);
    this.rumbleLP.connect(this.rumbleGain);
    this.shushSrc.connect(this.shushGain);
    this.rumbleGain.connect(this.whoosh);
    this.shushGain.connect(this.whoosh);
    this.whoosh.connect(this.mix);

    // Heartbeat envelope, played as a looping control signal.
    const envLen = Math.round((sr * 60) / ENV_BPM);
    this.envSrc = loopSource(ctx, toBuffer(ctx, heartbeatEnvelope(envLen)));
    this.envToWhoosh = ctx.createGain();
    this.envToTone = ctx.createGain();
    this.envToPulse = ctx.createGain();
    this.envSrc.connect(this.envToWhoosh);
    this.envSrc.connect(this.envToTone);
    this.envSrc.connect(this.envToPulse);
    this.envToWhoosh.connect(this.whoosh.gain);
    this.envToTone.connect(this.rumbleLP.frequency); // each surge is a little brighter

    // ---- womb-filtered music and voice ----
    this.trackChain = createWombChain(ctx, o.womb);
    this.trackChain.setBypass(o.wombBypass);
    this.trackAnalyser = ctx.createAnalyser();
    this.trackAnalyser.fftSize = 2048;
    this.trackLeveler = ctx.createGain();
    this.trackGain = ctx.createGain();
    this.trackChain.output.connect(this.trackAnalyser);
    this.trackChain.output.connect(this.trackLeveler);
    this.trackLeveler.connect(this.trackGain);
    this.trackGain.connect(this.mix);

    this.voiceChain = createWombChain(ctx, o.womb);
    this.voiceGain = ctx.createGain();
    this.voiceChain.output.connect(this.voiceGain);
    this.voiceGain.connect(this.mix);

    // A light heartbeat pulse on music and voice glues them to the rumble.
    this.trackChain.pulse.gain.value = 0.88;
    this.voiceChain.pulse.gain.value = 0.88;
    this.envToPulse.gain.value = 0.12;
    this.envToPulse.connect(this.trackChain.pulse.gain);
    this.envToPulse.connect(this.voiceChain.pulse.gain);

    this._applyOptions(true);
    this.setLevel(this.level, { immediate: true });

    const now = ctx.currentTime;
    this.rumbleSrc.start(now);
    this.shushSrc.start(now);
    this.envSrc.start(now);
    this.fade.gain.setValueAtTime(0, now);
    this.fade.gain.linearRampToValueAtTime(1, now + 3);

    ctx.onstatechange = () => this._emit('contextstate', { state: ctx.state });
    this._levelerTimer = setInterval(() => this._levelTracks(), 500);
    this._trackRms = 0;

    if (this.tracks.length) this._startTracks();
    if (this.voiceBlob) await this._startVoice();
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
  }

  async stop() {
    const ctx = this.ctx;
    if (!ctx) return;
    this.ctx = null;
    clearInterval(this._levelerTimer);
    try {
      const now = ctx.currentTime;
      this.fade.gain.cancelScheduledValues(now);
      this.fade.gain.setValueAtTime(this.fade.gain.value, now);
      this.fade.gain.linearRampToValueAtTime(0, now + 0.6);
      await new Promise((r) => setTimeout(r, 700));
    } catch (_) { /* context already gone */ }
    this._stopTracks();
    if (this.outEl) {
      this.outEl.pause();
      this.outEl.srcObject = null;
      this.outEl = null;
    }
    ctx.onstatechange = null;
    await ctx.close().catch(() => {});
  }

  /** Try to get a suspended or interrupted context going again. */
  async resume() {
    if (this.ctx && this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});
    if (this.outEl && this.outEl.paused) await this.outEl.play().catch(() => {});
    return this.ctx ? this.ctx.state : 'closed';
  }

  setLevel(level, { immediate = false } = {}) {
    this.level = clamp(Math.round(level), 0, MAX_LEVEL);
    if (!this.ctx) return;
    const g = levelGains(this.level, this.options.baselineDb);
    this._ramp(this.rumbleGain.gain, g.rumble, immediate ? 0.05 : LEVEL_TC);
    this._ramp(this.shushGain.gain, g.shush, immediate ? 0.05 : LEVEL_TC);
  }

  setOptions(partial) {
    const womb = partial.womb ? { ...this.options.womb, ...partial.womb } : this.options.womb;
    this.options = { ...this.options, ...partial, womb };
    if (this.ctx) this._applyOptions(false, partial);
  }

  /** Mute everything at once (used when the speaker connection changes). */
  setSafetyMute(on) {
    this.safetyMuted = !!on;
    if (this.ctx) this._ramp(this.safety.gain, on ? 0 : 1, on ? 0.02 : 0.5);
  }

  /** tracks: [{ id, name, blob }] */
  setTracks(tracks) {
    this.tracks = tracks || [];
    this.trackIndex = 0;
    if (this.ctx) {
      this._stopTracks();
      if (this.tracks.length) this._startTracks();
    }
  }

  async setVoice(blob) {
    this.voiceBlob = blob || null;
    if (this.ctx) await this._startVoice();
  }

  /** Output level after the cap, in dB relative to full scale. */
  outputDb() {
    if (!this.ctx) return -Infinity;
    const buf = new Float32Array(this.outAnalyser.fftSize);
    this.outAnalyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return 10 * Math.log10(Math.max(sum / buf.length, 1e-12));
  }

  // ---- internals ----

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _ramp(param, value, tc) {
    const now = this.ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setTargetAtTime(value, now, Math.max(0.01, tc / 3));
  }

  _applyOptions(initial, changed = this.options) {
    const o = this.options;
    const has = (k) => initial || Object.prototype.hasOwnProperty.call(changed, k);
    if (has('cap')) this._ramp(this.capGain.gain, capToGain(o.cap), initial ? 0.01 : 0.15);
    if (has('baselineDb') && !initial) this.setLevel(this.level);
    if (has('bpm')) this.envSrc.playbackRate.value = clamp(o.bpm, 40, 120) / ENV_BPM;
    if (has('whooshDepth')) {
      const d = clamp(o.whooshDepth, 0, 0.9);
      this.whoosh.gain.value = 1 - d;
      this.envToWhoosh.gain.value = d;
    }
    if (has('tone')) {
      this.rumbleLP.frequency.value = o.tone;
      this.envToTone.gain.value = o.tone * 0.4;
    }
    if (has('trackVolume')) this._ramp(this.trackGain.gain, volumeToGain(o.trackVolume), 0.2);
    if (has('voiceVolume')) this._ramp(this.voiceGain.gain, volumeToGain(o.voiceVolume), 0.2);
    if (has('womb')) {
      this.trackChain.set(o.womb);
      this.voiceChain.set(o.womb);
    }
    if (has('wombBypass')) {
      this.trackChain.setBypass(o.wombBypass);
      this.voiceChain.setBypass(o.wombBypass);
    }
    if (has('voiceGapSec') && !initial && this.voiceBlob) this._startVoice();
  }

  _startTracks() {
    const ctx = this.ctx;
    const el = new Audio();
    el.preload = 'auto';
    this.trackEl = el;
    this.trackSrc = ctx.createMediaElementSource(el);
    this.trackSrc.connect(this.trackChain.input);
    this._trackErrors = 0;
    el.addEventListener('ended', () => this._nextTrack());
    el.addEventListener('error', () => {
      const failed = this.tracks[this.trackIndex];
      this._emit('warning', { message: 'Could not play "' + (failed ? failed.name : 'track') + '".' });
      if (++this._trackErrors < this.tracks.length) this._nextTrack();
    });
    this._playTrack(this.trackIndex);
  }

  _playTrack(index) {
    if (!this.trackEl || !this.tracks.length) return;
    this.trackIndex = ((index % this.tracks.length) + this.tracks.length) % this.tracks.length;
    if (this._trackUrl) URL.revokeObjectURL(this._trackUrl);
    this._trackUrl = URL.createObjectURL(this.tracks[this.trackIndex].blob);
    this.trackEl.src = this._trackUrl;
    this.trackEl.play().then(() => { this._trackErrors = 0; }).catch(() => {});
    this._emit('track', { index: this.trackIndex, name: this.tracks[this.trackIndex].name });
  }

  _nextTrack() {
    this._playTrack(this.trackIndex + 1);
  }

  _stopTracks() {
    if (this.trackEl) {
      this.trackEl.pause();
      this.trackEl.removeAttribute('src');
      this.trackEl = null;
    }
    if (this.trackSrc) {
      try { this.trackSrc.disconnect(); } catch (_) { /* context closed */ }
      this.trackSrc = null;
    }
    if (this._trackUrl) {
      URL.revokeObjectURL(this._trackUrl);
      this._trackUrl = null;
    }
  }

  // Slow automatic gain so a quiet recording and a loud one end up similar.
  _levelTracks() {
    if (!this.ctx || !this.trackEl) return;
    const buf = new Float32Array(this.trackAnalyser.fftSize);
    this.trackAnalyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const r = Math.sqrt(sum / buf.length);
    if (r < 0.001) return; // silence between tracks: leave the gain alone
    this._trackRms = this._trackRms ? this._trackRms * 0.9 + r * 0.1 : r;
    const g = clamp(TRACK_TARGET_RMS / this._trackRms, 0.25, 4);
    this.trackLeveler.gain.setTargetAtTime(g, this.ctx.currentTime, 2);
  }

  async _startVoice() {
    const ctx = this.ctx;
    if (this.voiceSrc) {
      try { this.voiceSrc.stop(); } catch (_) { /* not started */ }
      this.voiceSrc.disconnect();
      this.voiceSrc = null;
    }
    if (!ctx || !this.voiceBlob) return;
    let decoded;
    try {
      decoded = await ctx.decodeAudioData(await this.voiceBlob.arrayBuffer());
    } catch (err) {
      this._emit('warning', { message: 'Could not decode the voice recording.' });
      return;
    }
    if (this.ctx !== ctx) return;
    const sr = decoded.sampleRate;
    const gap = Math.floor(sr * clamp(this.options.voiceGapSec, 0, 120));
    const data = new Float32Array(decoded.length + gap);
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      const src = decoded.getChannelData(ch);
      for (let i = 0; i < src.length; i++) data[i] += src[i] / decoded.numberOfChannels;
    }
    const fade = Math.min(Math.floor(sr * 0.08), Math.floor(decoded.length / 2));
    for (let i = 0; i < fade; i++) {
      const g = i / fade;
      data[i] *= g;
      data[decoded.length - 1 - i] *= g;
    }
    normaliseRms(data.subarray(0, decoded.length), TRACK_TARGET_RMS);
    const buf = ctx.createBuffer(1, data.length, sr);
    buf.copyToChannel(data, 0);
    this.voiceSrc = loopSource(ctx, buf);
    this.voiceSrc.connect(this.voiceChain.input);
    this.voiceSrc.start();
  }
}
