// Fallback cry detector, used while the YAMNet model is loading or if it
// fails to load. It looks for what makes a cry a cry acoustically:
//   - clearly louder than the room's own noise floor (which it tracks),
//   - a strong, steady pitch in the infant range (about 250-650 Hz),
//   - and that pitch being the real fundamental, not a harmonic of a
//     lower adult voice.
// The score is the fraction of the second that looked like that. The rhythm
// requirement (crying keeps coming back) is handled by the "3 of the last 5
// windows" rule in the state machine.

import { biquadCoeffs, biquadInPlace, toDb } from './dsp.js';

const MARGIN_DB = 10;      // how far above the noise floor a frame must be
const MIN_LEVEL_DB = -58;  // absolute floor, dB relative to full scale
const MIN_CLARITY = 0.6;   // normalised autocorrelation at the pitch lag

export function createHeuristic(sampleRate) {
  const dec = Math.max(1, Math.round(sampleRate / 8000));
  const fs = sampleRate / dec;
  const frame = Math.round(fs * 0.064);
  const hop = Math.round(fs * 0.032);
  const minLag = Math.floor(fs / 650);
  const maxLag = Math.ceil(fs / 250);
  const hp = biquadCoeffs('highpass', 300, fs); // drops the app's own rumble
  let floorDb = null;

  function corr(x, start, lag, n) {
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < n; i++) {
      const a = x[start + i];
      const b = x[start + i + lag];
      ab += a * b;
      aa += a * a;
      bb += b * b;
    }
    return ab / Math.sqrt(aa * bb + 1e-12);
  }

  return {
    get floorDb() {
      return floorDb;
    },
    /** @param samples Float32Array, about one second at `sampleRate` */
    process(samples) {
      const n = Math.floor(samples.length / dec);
      const x = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let k = 0; k < dec; k++) s += samples[i * dec + k];
        x[i] = s / dec;
      }
      biquadInPlace(x, hp);

      const span = frame - 2 * maxLag; // samples compared at each lag
      let frames = 0, cryFrames = 0, pitchSum = 0, loudest = -120;
      for (let start = 0; start + frame <= n; start += hop) {
        frames++;
        let e = 0;
        for (let i = 0; i < frame; i++) e += x[start + i] * x[start + i];
        const eDb = toDb(Math.sqrt(e / frame));
        if (eDb > loudest) loudest = eDb;

        const above = floorDb != null && eDb > floorDb + MARGIN_DB && eDb > MIN_LEVEL_DB;
        // Follow the floor down quickly and up slowly.
        if (floorDb == null) floorDb = eDb;
        else floorDb += (eDb < floorDb ? 0.3 : 0.002) * (eDb - floorDb);
        if (!above) continue;

        let best = 0, bestLag = 0;
        for (let lag = minLag; lag <= maxLag; lag++) {
          const r = corr(x, start, lag, span);
          if (r > best) {
            best = r;
            bestLag = lag;
          }
        }
        if (best < MIN_CLARITY) continue;
        // If twice the period matches clearly better, the real pitch is an
        // octave lower (an adult voice): not a cry.
        if (corr(x, start, bestLag * 2, span) > best + 0.15) continue;
        cryFrames++;
        pitchSum += fs / bestLag;
      }
      const score = frames ? cryFrames / frames : 0;
      return {
        score,
        pitchHz: cryFrames ? pitchSum / cryFrames : 0,
        levelDb: loudest,
        floorDb,
      };
    },
  };
}
