// Cry detector: microphone -> one-second windows -> cry score.
// Primary scorer is the YAMNet audio classifier (MediaPipe Tasks, running
// on-device in WebAssembly). Until it has loaded, or if it cannot load, the
// acoustic heuristic in heuristic.js is used instead.
//
// Events:
//   'window' { score, crying, levelDb, engine, detail }   once per second
//   'meter'  { levelDb }                                   ten times a second
//   'engine' { engine, error? }                            when the scorer changes

import { createHeuristic } from './heuristic.js';
import { rms, toDb } from './dsp.js';

const CRY = 'Baby cry, infant cry';
const SOB = 'Crying, sobbing';
const WHIMPER = 'Whimper';

export const SENSITIVITY = {
  low: { model: 0.45, heuristic: 0.45 },
  medium: { model: 0.25, heuristic: 0.3 },
  high: { model: 0.12, heuristic: 0.2 },
};

export class CryDetector extends EventTarget {
  constructor({ sensitivity = 'medium', echoCancellation = true, useModel = true } = {}) {
    super();
    this.sensitivity = sensitivity;
    this.echoCancellation = echoCancellation;
    this.useModel = useModel;
    this.engine = 'none';
    this.classifier = null;
    this.stream = null;
    this.ctx = null;
    this.ownsCtx = false;
  }

  /** @param ctx optional AudioContext to share with the sound engine */
  async start(ctx) {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: this.echoCancellation,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    const track = this.stream.getAudioTracks()[0];
    this.trackSettings = track.getSettings ? track.getSettings() : {};
    track.addEventListener('ended', () => this._emit('micended', {}));
    track.addEventListener('mute', () => this._emit('micmute', { muted: true }));
    track.addEventListener('unmute', () => this._emit('micmute', { muted: false }));

    if (ctx) {
      this.ctx = ctx;
    } else {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.ownsCtx = true;
    }
    await this.ctx.audioWorklet.addModule(new URL('./worklets/capture-processor.js', import.meta.url));
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    // The node only runs while it leads to the output, so connect it through
    // a silent gain.
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.node);
    this.node.connect(this.sink);
    this.sink.connect(this.ctx.destination);

    this.heuristic = createHeuristic(this.ctx.sampleRate);
    this._setEngine('heuristic');
    this.node.port.onmessage = (ev) => this._onMessage(ev.data);
    if (this.useModel) this._loadModel();
  }

  async stop() {
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
      this.source.disconnect();
      this.sink.disconnect();
      this.node = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.classifier) {
      try { this.classifier.close(); } catch (_) { /* already closed */ }
      this.classifier = null;
    }
    if (this.ownsCtx && this.ctx) await this.ctx.close().catch(() => {});
    this.ctx = null;
    this.ownsCtx = false;
    this.engine = 'none';
  }

  setSensitivity(s) {
    if (SENSITIVITY[s]) this.sensitivity = s;
  }

  async _loadModel() {
    try {
      const mp = await import('../vendor/mediapipe/audio_bundle.mjs');
      const fileset = await mp.FilesetResolver.forAudioTasks(
        new URL('../vendor/mediapipe/wasm', import.meta.url).href,
      );
      const classifier = await mp.AudioClassifier.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: new URL('../models/yamnet.tflite', import.meta.url).href },
        categoryAllowlist: [CRY, SOB, WHIMPER],
        maxResults: 3,
      });
      if (!this.stream) {
        classifier.close();
        return;
      }
      this.classifier = classifier;
      this._setEngine('yamnet');
    } catch (err) {
      this._emit('engine', { engine: 'heuristic', error: String(err && err.message ? err.message : err) });
    }
  }

  _setEngine(engine) {
    this.engine = engine;
    this._emit('engine', { engine });
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _onMessage(msg) {
    if (msg.type === 'meter') {
      this._emit('meter', { levelDb: toDb(msg.rms) });
      return;
    }
    if (msg.type !== 'window') return;
    const samples = msg.samples;
    const levelDb = toDb(rms(samples));
    const thresholds = SENSITIVITY[this.sensitivity] || SENSITIVITY.medium;
    let score = 0, threshold = thresholds.heuristic, detail = {}, engine = this.engine;

    if (this.classifier) {
      try {
        const scores = { [CRY]: 0, [SOB]: 0, [WHIMPER]: 0 };
        for (const result of this.classifier.classify(samples, msg.sampleRate)) {
          for (const cat of result.classifications[0].categories) {
            if (cat.categoryName in scores && cat.score > scores[cat.categoryName]) {
              scores[cat.categoryName] = cat.score;
            }
          }
        }
        // "Baby cry" is the signal; generic crying and whimpering add a little.
        score = Math.min(1, scores[CRY] + 0.5 * scores[SOB] + 0.25 * scores[WHIMPER]);
        threshold = thresholds.model;
        detail = { cry: scores[CRY], sob: scores[SOB], whimper: scores[WHIMPER] };
      } catch (err) {
        // A classifier that starts throwing is dropped for the night.
        this.classifier = null;
        this._emit('engine', { engine: 'heuristic', error: String(err && err.message ? err.message : err) });
        this.engine = engine = 'heuristic';
      }
    }
    if (engine !== 'yamnet') {
      const h = this.heuristic.process(samples);
      score = h.score;
      threshold = thresholds.heuristic;
      detail = { pitchHz: h.pitchHz, floorDb: h.floorDb };
    } else {
      // Keep the heuristic's noise floor current in case it is needed later.
      this.heuristic.process(samples);
    }
    this._emit('window', { score, crying: score >= threshold, threshold, levelDb, engine, detail });
  }
}
