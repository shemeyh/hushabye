// Runs on the audio thread. Collects microphone samples into one-second
// windows for the classifier, and posts a level reading ten times a second
// for the on-screen meter.

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.windowLen = sampleRate; // one second
    this.window = new Float32Array(this.windowLen);
    this.fill = 0;
    this.meterLen = Math.floor(sampleRate / 10);
    this.meterSum = 0;
    this.meterCount = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      this.window[this.fill++] = v;
      this.meterSum += v * v;
      if (++this.meterCount >= this.meterLen) {
        this.port.postMessage({ type: 'meter', rms: Math.sqrt(this.meterSum / this.meterCount) });
        this.meterSum = 0;
        this.meterCount = 0;
      }
      if (this.fill >= this.windowLen) {
        const out = this.window;
        this.port.postMessage({ type: 'window', samples: out, sampleRate }, [out.buffer]);
        this.window = new Float32Array(this.windowLen);
        this.fill = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
