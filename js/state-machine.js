// Escalation logic as a pure reducer. No timers and no audio in here: the
// caller feeds events carrying a time in seconds and applies the effects.
// Driving it by elapsed time (not by counting timer ticks) keeps it correct
// when the browser throttles timers, and makes it easy to unit-test.

export const DEFAULT_TIMINGS = {
  windowSize: 5,          // look at the last N one-second detection windows
  windowsNeeded: 3,       // ...and call it crying when at least this many are cries
  escalateEverySec: 25,   // continued crying: one level up this often
  quietStepDownSec: 60,   // quiet this long: one level down
  giveUpAfterSec: 150,    // crying this long at the top level: hand over to the parent
  rearmQuietSec: 300,     // after giving up, start responding again after this much quiet
  pauseSec: 1200,         // length of a manual pause (feeds, changes)
  maxLevel: 4,
};

export function initialState() {
  return {
    mode: 'idle',         // idle | running | paused | needsYou
    level: 0,
    history: [],          // last windowSize booleans
    sustained: false,
    episode: false,       // true from the first escalation until back at baseline
    lastEscalationAt: null,
    quietSince: null,
    lastStepDownAt: null,
    topCrySec: 0,         // seconds of sustained crying spent at the top level
    lastWindowAt: null,
    pausedUntil: null,
  };
}

function fresh(mode, extra = {}) {
  return { ...initialState(), mode, ...extra };
}

function setLevel(state, effects, to, reason, t) {
  if (to === state.level) return state;
  effects.push({ type: 'level', from: state.level, to, reason, t });
  return { ...state, level: to };
}

/**
 * @param state  current state
 * @param event  { type: 'start'|'stop'|'window'|'tick'|'pause'|'resume'|'ack', t, crying? }
 * @param cfg    timings
 * @returns {{state: object, effects: Array}}
 */
export function step(state, event, cfg = DEFAULT_TIMINGS) {
  const t = event.t ?? 0;
  const effects = [];
  const note = (kind, extra = {}) => effects.push({ type: 'event', kind, t, ...extra });

  switch (event.type) {
    case 'start': {
      if (state.mode !== 'idle') return { state, effects };
      note('started');
      return { state: fresh('running'), effects };
    }
    case 'stop': {
      if (state.mode === 'idle') return { state, effects };
      let s = setLevel(state, effects, 0, 'stop', t);
      note('stopped');
      return { state: fresh('idle'), effects };
    }
    case 'pause': {
      if (state.mode === 'idle') return { state, effects };
      const s = setLevel(state, effects, 0, 'pause', t);
      const until = t + (event.seconds ?? cfg.pauseSec);
      note('paused', { until });
      return { state: fresh('paused', { level: s.level, pausedUntil: until }), effects };
    }
    case 'resume':
    case 'ack': {
      if (state.mode !== 'paused' && state.mode !== 'needsYou') return { state, effects };
      note(event.type === 'ack' ? 're-armed' : 'resumed', { manual: true });
      return { state: fresh('running'), effects };
    }
    case 'tick': {
      if (state.mode === 'paused' && t >= state.pausedUntil) {
        note('resumed', { manual: false });
        return { state: fresh('running'), effects };
      }
      return { state, effects };
    }
    case 'window':
      break;
    default:
      return { state, effects };
  }

  // ---- one detection window ----
  if (state.mode === 'idle') return { state, effects };

  if (state.mode === 'paused') {
    if (t >= state.pausedUntil) {
      note('resumed', { manual: false });
      state = fresh('running');
    } else {
      return { state, effects };
    }
  }

  const history = [...state.history, !!event.crying].slice(-cfg.windowSize);
  const cries = history.reduce((n, c) => n + (c ? 1 : 0), 0);
  const sustained = cries >= cfg.windowsNeeded;
  // Time since the previous window, clamped so a frozen tab cannot count a
  // long gap as minutes of crying.
  const dt = state.lastWindowAt == null ? 0 : Math.min(5, Math.max(0, t - state.lastWindowAt));
  let s = { ...state, history, sustained, lastWindowAt: t };

  if (s.mode === 'needsYou') {
    if (sustained) {
      s.quietSince = null;
    } else {
      if (s.quietSince == null) s.quietSince = t;
      if (t - s.quietSince >= cfg.rearmQuietSec) {
        note('re-armed', { manual: false });
        return { state: fresh('running', { history, lastWindowAt: t }), effects };
      }
    }
    return { state: s, effects };
  }

  // mode === 'running'
  if (sustained) {
    s.quietSince = null;
    s.lastStepDownAt = null;
    if (!s.episode) {
      s.episode = true;
      note('cry-start');
    }
    const due = s.lastEscalationAt == null || t - s.lastEscalationAt >= cfg.escalateEverySec;
    if (s.level < cfg.maxLevel && due) {
      s = setLevel(s, effects, s.level + 1, 'cry', t);
      s.lastEscalationAt = t;
      s.topCrySec = 0;
    } else if (s.level >= cfg.maxLevel) {
      s.topCrySec += dt;
      if (s.topCrySec >= cfg.giveUpAfterSec) {
        s = setLevel(s, effects, 0, 'give-up', t);
        note('needs-you');
        return {
          state: fresh('needsYou', { history, sustained, lastWindowAt: t }),
          effects,
        };
      }
    }
  } else {
    if (s.quietSince == null) s.quietSince = t;
    if (s.level > 0) {
      const since = Math.max(s.quietSince, s.lastStepDownAt ?? -Infinity);
      if (t - since >= cfg.quietStepDownSec) {
        s = setLevel(s, effects, s.level - 1, 'quiet', t);
        s.lastStepDownAt = t;
        s.topCrySec = 0;
        if (s.level === 0) {
          s.episode = false;
          s.lastEscalationAt = null;
          note('settled');
        }
      }
    } else if (s.episode) {
      s.episode = false;
      s.lastEscalationAt = null;
    }
  }
  return { state: s, effects };
}

export const LEVEL_NAMES = ['Baseline', 'Level 1', 'Level 2', 'Level 3', 'Level 4'];
