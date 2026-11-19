// Hushabye: wires the sound engine, the cry detector and the escalation
// state machine to the page.

import { step, initialState, LEVEL_NAMES } from './state-machine.js';
import { SoundEngine, capToDb } from './sound-engine.js';
import { CryDetector } from './detector.js';
import { WOMB_PRESETS, wombResponseDb } from './womb-filter.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);

// Shown at the bottom of the page. Keep in step with VERSION in sw.js.
const APP_VERSION = 4;

let settings = store.loadSettings();
const engine = new SoundEngine(settings.sound);
let detector = null;
let machine = initialState();
let running = false;
let preview = null;          // level being previewed while not running, or null
let simCrying = false;
let vt = 0;                  // the state machine's clock, in seconds
let lastReal = 0;
let lastWindowReal = 0;
let micOk = false;
let wakeLock = null;
let fallbackTimer = null;
let watchdogTimer = null;
let interrupted = false;
let stalled = false;
let outputsSnapshot = '';
let scoreBatch = null;
let lastScore = 0;
let lastThreshold = 0.25;
let detectorEngine = 'none';
let bannerHandler = null;
let recordingMuted = false;
let clockWarned = false;
let silentSince = 0;
let silentWarned = false;

// ---------------------------------------------------------------- helpers

const speed = () => (settings.fastTest ? 10 : 1);
const clock = (d = new Date()) =>
  d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], obj)[last] = value;
}

function currentVt() {
  return vt + ((performance.now() - lastReal) / 1000) * speed();
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

// -------------------------------------------------------------------- log

function addLogRow(text, kind, when = new Date()) {
  const list = $('log');
  const empty = list.querySelector('.empty');
  if (empty) empty.remove();
  const li = el('li', { class: kind === 'alert' ? 'alert' : '' }, [
    el('time', { text: clock(when).slice(0, 5) }),
    el('span', { text }),
  ]);
  list.prepend(li);
  while (list.children.length > 200) list.lastChild.remove();
}

function log(text, kind = 'info') {
  addLogRow(text, kind);
  store.logEvent({ text, kind, level: machine.level, mode: machine.mode, shadow: settings.shadowMode });
}

async function restoreLog() {
  try {
    const since = Date.now() - 14 * 3600 * 1000;
    const events = (await store.recentEvents(200)).filter((e) => e.at >= since && e.kind !== 'diag');
    for (const e of events) addLogRow(e.text, e.kind, new Date(e.at));
    store.pruneLog();
  } catch (_) { /* no IndexedDB: the log just starts empty */ }
}

// ---------------------------------------------------------- state machine

function dispatch(event) {
  const result = step(machine, event, settings.timings);
  machine = result.state;
  result.effects.forEach(applyEffect);
  render();
}

function applyEffect(e) {
  if (e.type === 'level') {
    // In shadow mode the sound never leaves the baseline.
    engine.setLevel(settings.shadowMode ? 0 : e.to);
    const would = settings.shadowMode ? 'Shadow: would go ' : '';
    if (e.reason === 'cry') log(`${would || 'Crying: '}up to ${LEVEL_NAMES[e.to]}`);
    else if (e.reason === 'quiet') log(`${would || 'Quiet: '}down to ${LEVEL_NAMES[e.to]}`);
    return;
  }
  switch (e.kind) {
    case 'started':
      log(settings.shadowMode ? 'Started in shadow mode' : 'Started');
      break;
    case 'stopped':
      log('Stopped');
      break;
    case 'cry-start':
      log('Crying detected');
      break;
    case 'settled':
      log('Settled: back at baseline');
      break;
    case 'needs-you':
      log(settings.shadowMode ? 'Shadow: would show "Baby needs you"' : 'Baby needs you: soothing did not settle the crying', 'alert');
      break;
    case 're-armed':
      log(e.manual ? 'Listening again' : 'Quiet for a while: listening again');
      break;
    case 'paused': {
      const until = new Date(Date.now() + ((e.until - e.t) / speed()) * 1000);
      log(`Paused until ${clock(until).slice(0, 5)}`);
      break;
    }
    case 'resumed':
      log(e.manual ? 'Pause ended by you: listening' : 'Pause over: listening');
      break;
  }
}

// ----------------------------------------------------------------- render

function render() {
  const mode = machine.mode;
  const shadow = settings.shadowMode;
  const status = document.querySelector('.status');

  let name = 'Stopped';
  let line = 'Ready when you are';
  if (!running && preview != null) {
    name = 'Preview';
    line = `Playing ${LEVEL_NAMES[preview]} so you can listen`;
  } else if (running) {
    if (mode === 'paused') {
      const left = Math.max(0, (machine.pausedUntil - currentVt()) / speed());
      name = 'Paused';
      line = `Listening again in ${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
    } else if (mode === 'needsYou') {
      name = 'Baseline';
      line = shadow ? 'Shadow: would be asking for you' : 'Waiting for you';
    } else {
      name = LEVEL_NAMES[shadow ? 0 : machine.level];
      if (shadow && machine.level > 0) line = `Shadow: would be at ${LEVEL_NAMES[machine.level]}`;
      else if (machine.sustained) line = 'Crying detected';
      else if (machine.level > 0) line = 'Calming down';
      else line = micOk ? 'Listening' : 'Playing (not listening)';
    }
  }
  $('levelName').textContent = name;
  $('stateLine').textContent = line;
  status.classList.toggle('crying', running && machine.sustained && mode === 'running');
  status.classList.toggle('shadow', shadow);

  const lit = running ? machine.level : preview != null ? preview : -1;
  [...$('pips').children].forEach((p, i) => p.classList.toggle('on', i <= lit));

  const btn = $('startStop');
  btn.textContent = running ? 'Stop' : 'Start';
  btn.classList.toggle('running', running);

  const pauseMin = Math.round(settings.timings.pauseSec / 60);
  $('pauseBtn').disabled = !running;
  $('pauseBtn').textContent = mode === 'paused' ? 'Listen again now' : `Pause ${pauseMin} min`;
  $('needsPause').textContent = `Pause ${pauseMin} min`;
  $('simBtn').disabled = !running;
  $('simBtn').setAttribute('aria-pressed', String(simCrying));
  $('simBtn').textContent = simCrying ? 'Stop simulated cry' : 'Simulate crying';

  $('chipShadow').hidden = !shadow;
  $('chipFast').hidden = !settings.fastTest;
  $('chipWake').hidden = !wakeLock;
  $('chipEngine').hidden = !running;
  $('chipEngine').textContent =
    detectorEngine === 'yamnet' ? 'Detector: YAMNet' : detectorEngine === 'heuristic' ? 'Detector: basic' : 'Mic off';

  $('needsYou').hidden = !(running && mode === 'needsYou' && !shadow);

  const dots = [...$('historyDots').children];
  const hist = running ? machine.history : [];
  dots.forEach((d, i) => d.classList.toggle('cry', !!hist[hist.length - dots.length + i]));

  $('scoreBar').style.width = `${Math.round((running ? lastScore : 0) * 100)}%`;
  $('scoreMark').style.left = `${Math.round(lastThreshold * 100)}%`;
  $('nightLevel').textContent = running ? `${name}${simCrying ? ' (test)' : ''}` : 'Stopped';
}

function showBanner(text, actionLabel, handler) {
  $('bannerText').textContent = text;
  $('bannerAction').textContent = actionLabel;
  bannerHandler = handler;
  $('banner').hidden = false;
}

function hideBanner() {
  $('banner').hidden = true;
  bannerHandler = null;
}

// ------------------------------------------------------------- start/stop

async function loadMedia() {
  try {
    const tracks = settings.tracksEnabled ? await store.listTracks() : [];
    engine.setTracks(tracks.map((r) => ({ id: r.id, name: r.name, blob: r.blob })));
    const voice = settings.voiceEnabled ? await store.getBlob('voice') : null;
    await engine.setVoice(voice ? voice.blob : null);
  } catch (err) {
    log('Could not load saved audio: ' + err.message, 'alert');
  }
}

async function start() {
  if (running) return;
  if (!settings.setupDone) {
    openSetup(0);
    return;
  }
  $('startStop').disabled = true;
  try {
    const wasPlaying = engine.running;
    preview = null;
    engine.setOptions(settings.sound);
    engine.level = 0;
    await engine.start(); // creates the AudioContext inside the tap
    engine.setLevel(0);
    if (!wasPlaying) await loadMedia();

    running = true;
    vt = 0;
    lastReal = lastWindowReal = performance.now();
    interrupted = stalled = false;
    lastScore = 0;
    clockWarned = silentWarned = false;
    silentSince = 0;
    scoreBatch = newBatch();
    dispatch({ type: 'start', t: 0 });

    await startDetector();
    acquireWakeLock();
    outputsSnapshot = await snapshotOutputs();
    recordDiagnostics();
    watchdogTimer = setInterval(watchdog, 5000);
    if ('mediaSession' in navigator && window.MediaMetadata) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: 'Hushabye', artist: 'Womb sound' });
    }
  } catch (err) {
    log('Could not start: ' + err.message, 'alert');
  } finally {
    $('startStop').disabled = false;
    render();
  }
}

async function stop() {
  if (!running) return;
  $('startStop').disabled = true;
  dispatch({ type: 'stop', t: currentVt() });
  running = false;
  simCrying = false;
  clearInterval(watchdogTimer);
  clearInterval(fallbackTimer);
  flushScores();
  if (detector) await detector.stop().catch(() => {});
  detector = null;
  detectorEngine = 'none';
  micOk = false;
  await engine.stop();
  engine.setSafetyMute(false);
  releaseWakeLock();
  hideBanner();
  $('micBar').style.width = '0%';
  $('startStop').disabled = false;
  render();
}

async function startDetector() {
  detector = new CryDetector({
    sensitivity: settings.sensitivity,
    echoCancellation: settings.echoCancellation,
    // "?model=off" forces the basic detector, to test the fallback path.
    useModel: new URLSearchParams(location.search).get('model') !== 'off',
  });
  detector.addEventListener('window', (e) => onWindow(e.detail));
  detector.addEventListener('meter', (e) => {
    const pct = Math.max(0, Math.min(100, ((e.detail.levelDb + 70) / 60) * 100));
    $('micBar').style.width = `${pct}%`;
  });
  detector.addEventListener('engine', (e) => {
    detectorEngine = e.detail.engine;
    if (e.detail.error) log('The cry model could not load, so the basic detector is in use', 'alert');
    render();
  });
  detector.addEventListener('micended', () => {
    if (!running) return;
    micOk = false;
    log('The microphone stopped', 'alert');
    showBanner('The microphone stopped, so crying is no longer detected. Stop and Start again to reconnect it.', 'OK', hideBanner);
  });
  try {
    await detector.start(engine.ctx);
    micOk = true;
  } catch (err) {
    detector = null;
    micOk = false;
    detectorEngine = 'none';
    log('Microphone unavailable (' + (err.name || err.message) + ')', 'alert');
    showBanner(`Crying cannot be detected. ${await micProblem(err)} The baseline sound keeps playing.`, 'Try again', retryMic);
    // Keep the clock ticking so pause, test mode and the log still work.
    fallbackTimer = setInterval(
      () => onWindow({ score: 0, crying: false, threshold: lastThreshold, levelDb: -120, engine: 'none' }),
      1000,
    );
  }
}

async function retryMic() {
  if (!running) return;
  clearInterval(fallbackTimer);
  hideBanner();
  await startDetector();
  if (micOk) log('Microphone connected');
  render();
}

// ------------------------------------------------- microphone permission

const MIC_BLOCKED =
  'Chrome is blocking the microphone for this site, so it cannot ask again. Open the Chrome menu (three dots), then Settings, Site settings, Microphone. Tap this site under "Blocked" and choose Allow. If the site is not listed there: Site settings, All sites, find this site and tap "Clear & reset".';
const MIC_IN_APP =
  "This page is open inside another app's built-in browser, which cannot use the microphone. Tap \"Open this page in Chrome\" below.";

let micDiagText = '';
const hasMicApi = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
const isAndroid = () => /Android/i.test(navigator.userAgent);
// Android WebViews carry a "wv" token; a few well-known in-app browsers name themselves.
const inAppBrowser = () => /\bwv\b|FBAN|FBAV|Instagram|Line\//.test(navigator.userAgent);

/** Everything needed to work out why the microphone will not open. */
async function micDiagnostics(err, ms) {
  let inputs = 'unknown';
  try {
    inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput').length;
  } catch (_) { /* no device list */ }
  let policy = 'unknown';
  try {
    policy = document.featurePolicy.allowsFeature('microphone');
  } catch (_) { /* older browser */ }
  let framed = true;
  try {
    framed = window.top !== window;
  } catch (_) { /* cross-origin parent */ }
  return [
    `app version: ${APP_VERSION}`,
    `result: ${err ? `${err.name}: ${err.message}` : 'microphone opened'}`,
    `answered after: ${ms} ms`,
    `permission state: ${await micPermission()}`,
    `secure page: ${window.isSecureContext}`,
    `microphone API present: ${hasMicApi()}`,
    `allowed by page policy: ${policy}`,
    `microphones found: ${inputs}`,
    `inside another app's browser: ${inAppBrowser()}`,
    `home-screen app: ${matchMedia('(display-mode: standalone)').matches}`,
    `inside a frame: ${framed}`,
    `browser: ${navigator.userAgent}`,
  ].join('\n');
}
const MIC_ANDROID =
  'Also check the phone\'s own Settings: Apps, Chrome, Permissions, Microphone, and choose "Allow only while using the app". With "Ask every time", Chrome never gets to ask.';

async function micPermission() {
  try {
    return (await navigator.permissions.query({ name: 'microphone' })).state;
  } catch (_) {
    return 'unknown';
  }
}

/** A plain-language reason for a failed microphone request, with the fix. */
async function micProblem(err) {
  if (inAppBrowser()) return MIC_IN_APP;
  if (!hasMicApi()) {
    return 'This page cannot use a microphone here. Open it in Chrome itself (not inside another app), at its https address.';
  }
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    const state = await micPermission();
    if (state === 'denied') return `${MIC_BLOCKED} ${MIC_ANDROID}`;
    return `The microphone was not allowed. Try again and choose Allow when Chrome asks. If no question appears: ${MIC_ANDROID}`;
  }
  if (name === 'NotFoundError') return 'No microphone was found on this device.';
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'Another app is using the microphone. Close any call, recorder or voice assistant, then try again.';
  }
  return `The microphone could not be opened${err && err.message ? ` (${err.message})` : ''}.`;
}

async function refreshMicStatus(problem) {
  const state = await micPermission();
  const status = $('micStatus');
  const btn = $('micAllow');
  const granted = state === 'granted' && !problem;
  btn.disabled = granted;
  btn.textContent = granted ? 'Microphone allowed' : 'Allow microphone';
  status.classList.toggle('ok', granted);
  if (granted) status.textContent = 'All set: the microphone is allowed.';
  else if (problem) status.textContent = problem;
  else if (state === 'denied') status.textContent = `${MIC_BLOCKED} ${MIC_ANDROID} Then come back and tap the button.`;
  else if (inAppBrowser()) status.textContent = MIC_IN_APP;
  else status.textContent = 'Tap the button, then choose Allow when Chrome asks.';

  // After a failure, or inside another app's browser, offer the way out.
  const failed = !granted && (!!problem || inAppBrowser() || !hasMicApi());
  const link = $('openChrome');
  link.hidden = !(failed && isAndroid());
  link.href = `intent://${location.host}${location.pathname}#Intent;scheme=https;package=com.android.chrome;end`;
  $('micDiag').textContent = micDiagText;
  $('micDiag').hidden = $('micCopy').hidden = !(failed && micDiagText);
}

async function requestMic() {
  const began = performance.now();
  let error = null;
  try {
    if (!hasMicApi()) throw new Error('This browser has no microphone API on this page');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch (err) {
    error = err;
  }
  micDiagText = await micDiagnostics(error, Math.round(performance.now() - began));
  await refreshMicStatus(error ? await micProblem(error) : undefined);
}

async function copyMicDetails() {
  try {
    await navigator.clipboard.writeText(micDiagText);
    $('micCopy').textContent = 'Copied';
  } catch (_) {
    const range = document.createRange();
    range.selectNodeContents($('micDiag'));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    $('micCopy').textContent = 'Selected: now copy';
  }
  setTimeout(() => ($('micCopy').textContent = 'Copy details'), 2500);
}

function onWindow(d) {
  if (!running) return;
  const now = performance.now();
  vt += ((now - lastReal) / 1000) * speed();
  lastReal = lastWindowReal = now;
  lastScore = simCrying ? 1 : d.score;
  lastThreshold = d.threshold;
  dispatch({ type: 'window', crying: simCrying || d.crying, t: vt });
  if (scoreBatch) {
    if (!scoreBatch.scores.length) scoreBatch.at = Date.now() - 1000;
    scoreBatch.scores.push(Math.round(d.score * 100) / 100);
    scoreBatch.levels.push(machine.level);
    scoreBatch.mic.push(Math.round(d.levelDb));          // room sound, dB below full scale
    scoreBatch.out.push(Math.round(Math.max(-120, engine.outputDb()))); // sound leaving the app
    scoreBatch.engine = d.engine;
    if (scoreBatch.scores.length >= 60) flushScores();
  }
}

function newBatch() {
  return { at: Date.now(), scores: [], levels: [], mic: [], out: [] };
}

function flushScores() {
  if (scoreBatch && scoreBatch.scores.length) {
    scoreBatch.spanMs = Date.now() - scoreBatch.at;
    store.logScores(scoreBatch);
    checkClock(scoreBatch);
  }
  scoreBatch = newBatch();
}

// Each window is one second of audio. If a minute of windows takes much more
// or less than a minute, the audio engine is not being driven by a real
// speaker at normal speed, which is worth knowing when there is no sound.
function checkClock(batch) {
  if (clockWarned || !micOk || batch.scores.length < 60) return;
  const rate = batch.scores.length / (batch.spanMs / 1000);
  if (Math.abs(rate - 1) > 0.08) {
    clockWarned = true;
    log(`Diagnostic: the audio clock is running ${Math.round(Math.abs(rate - 1) * 100)}% ${rate > 1 ? 'fast' : 'slow'}`);
  }
}

/** One record per Start with everything needed to debug sound and microphone. */
function recordDiagnostics() {
  const ctx = engine.ctx;
  store.logEvent({
    kind: 'diag',
    text: 'diagnostics',
    data: {
      appVersion: APP_VERSION,
      sampleRate: ctx && ctx.sampleRate,
      contextState: ctx && ctx.state,
      baseLatency: ctx && ctx.baseLatency,
      outputLatency: ctx && ctx.outputLatency,
      cap: settings.sound.cap,
      baselineDb: settings.sound.baselineDb,
      outputPath: settings.sound.outputPath,
      echoCancellationAsked: settings.echoCancellation,
      microphone: detector ? detector.trackSettings : null,
      detector: detectorEngine,
      outputs: outputsSnapshot ? outputsSnapshot.split('\n').map((o) => o.split('|')[1] || 'unnamed') : [],
      browser: navigator.userAgent,
    },
  });
}

// "Sound out" meter: what the app is sending to the speaker, after the cap.
function updateOutMeter() {
  const db = engine.running ? engine.outputDb() : -Infinity;
  const pct = Number.isFinite(db) ? Math.max(0, Math.min(100, ((db + 80) / 70) * 100)) : 0;
  $('outBar').style.width = `${pct}%`;
  $('calibOutBar').style.width = `${pct}%`;
  if (running && !engine.safetyMuted && !(db > -95)) {
    if (!silentSince) silentSince = Date.now();
    if (!silentWarned && Date.now() - silentSince > 10000) {
      silentWarned = true;
      log(settings.sound.cap <= 0 ? 'No sound: the volume cap is at zero' : 'No sound is leaving the app', 'alert');
    }
  } else {
    silentSince = 0;
  }
}
setInterval(updateOutMeter, 250);

function watchdog() {
  if (!running) return;
  if (engine.ctx && engine.ctx.state !== 'running') {
    if (!interrupted) {
      interrupted = true;
      log('Audio was interrupted: trying to resume', 'alert');
    }
    engine.resume();
  } else if (interrupted) {
    interrupted = false;
    log('Audio resumed');
  }
  const silentFor = performance.now() - lastWindowReal;
  if (micOk && silentFor > 15000 && !stalled) {
    stalled = true;
    log('Listening stalled: no microphone data for 15 seconds', 'alert');
  } else if (stalled && silentFor < 5000) {
    stalled = false;
    log('Listening again');
  }
  dispatch({ type: 'tick', t: currentVt() }); // ends a pause even if windows stall
}

// ------------------------------------------------- wake lock and speaker

async function acquireWakeLock() {
  if (!('wakeLock' in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
      render();
    });
  } catch (_) {
    wakeLock = null;
  }
  render();
}

function releaseWakeLock() {
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (!running) return;
  if (document.visibilityState === 'visible') {
    log('Back on screen');
    acquireWakeLock();
    engine.resume();
  } else {
    log('Screen off or app in the background');
  }
});

async function snapshotOutputs() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audiooutput')
      .map((d) => `${d.deviceId}|${d.label}`)
      .sort()
      .join('\n');
  } catch (_) {
    return '';
  }
}

async function onDeviceChange() {
  if (!running) return;
  const now = await snapshotOutputs();
  if (now === outputsSnapshot) return;
  outputsSnapshot = now;
  if (!settings.muteOnSpeakerChange) {
    log('The speaker connection changed', 'alert');
    return;
  }
  engine.setSafetyMute(true);
  log('The speaker connection changed: sound muted', 'alert');
  showBanner(
    'The speaker connection changed, so the sound is muted. If the Bluetooth speaker dropped, the phone itself would be playing right next to the baby. Check the speaker, then resume.',
    'Resume sound',
    () => {
      engine.setSafetyMute(false);
      log('Sound resumed by you');
      hideBanner();
    },
  );
}

if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
}

engine.addEventListener('warning', (e) => log(e.detail.message, 'alert'));

// ---------------------------------------------------------------- preview

async function setPreview(level) {
  if (running) return;
  if (level == null) {
    preview = null;
    await engine.stop();
  } else {
    const wasPlaying = engine.running;
    preview = level;
    engine.setOptions(settings.sound);
    await engine.start();
    engine.setLevel(level);
    if (!wasPlaying) await loadMedia();
  }
  syncPreviewButtons();
  render();
}

function syncPreviewButtons() {
  $('calibLoud').setAttribute('aria-pressed', String(preview === 4));
  $('calibBase').setAttribute('aria-pressed', String(preview === 0));
  $('calibLoud').disabled = $('calibBase').disabled = running;
  const pv = $('previewToggle');
  if (pv) {
    pv.setAttribute('aria-pressed', String(preview != null));
    pv.textContent = preview != null ? 'Stop preview' : 'Preview sound';
    pv.disabled = running;
  }
}

// ----------------------------------------------------------- setup guide

let setupStep = 0;
const SETUP_NEXT = ['I understand', 'Next', 'Next', 'The cap is set', 'Finish'];
const CALIB_STEP = 3;
const LAST_STEP = 4;

function openSetup(stepIndex) {
  setupStep = stepIndex;
  $('setup').hidden = false;
  renderSetup();
}

function renderSetup() {
  document.querySelectorAll('#setup .step').forEach((s) => {
    s.hidden = Number(s.dataset.step) !== setupStep;
  });
  [...$('setupDots').children].forEach((d, i) => d.classList.toggle('on', i <= setupStep));
  $('setupNext').textContent = SETUP_NEXT[setupStep];
  $('setupBack').textContent = setupStep === 0 ? 'Close' : 'Back';
  if (setupStep === 2) refreshMicStatus();
  $('calibCap').value = settings.sound.cap;
  $('calibCapOut').textContent = capLabel(settings.sound.cap);
  syncPreviewButtons();
  $('setup').scrollTop = 0;
}

async function leaveCalibration() {
  if (preview != null) await setPreview(null);
}

$('setupNext').addEventListener('click', async () => {
  if (setupStep === CALIB_STEP) await leaveCalibration();
  if (setupStep < LAST_STEP) {
    setupStep++;
    renderSetup();
    return;
  }
  settings.setupDone = true;
  store.saveSettings(settings);
  $('setup').hidden = true;
});

$('setupBack').addEventListener('click', async () => {
  if (setupStep === CALIB_STEP) await leaveCalibration();
  if (setupStep === 0) {
    $('setup').hidden = true;
    return;
  }
  setupStep--;
  renderSetup();
});

$('micAllow').addEventListener('click', requestMic);
$('micCopy').addEventListener('click', copyMicDetails);
$('calibLoud').addEventListener('click', () => setPreview(preview === 4 ? null : 4));
$('calibBase').addEventListener('click', () => setPreview(preview === 0 ? null : 0));
$('calibCap').addEventListener('input', (e) => {
  applySetting('sound.cap', Number(e.target.value));
  $('calibCapOut').textContent = capLabel(settings.sound.cap);
});

// --------------------------------------------------------------- settings

const capLabel = (v) => (v <= 0 ? 'Silent' : `${v}%  (${capToDb(v).toFixed(0)} dB)`);
const secLabel = (v) => (v >= 120 ? `${(v / 60).toFixed(v % 60 ? 1 : 0)} min` : `${v} s`);

const GROUPS = [
  {
    title: 'Volume',
    fields: [
      { path: 'sound.cap', label: 'Maximum volume cap', type: 'range', min: 0, max: 100, step: 1, fmt: capLabel,
        help: 'Nothing can play louder than this. Set it with a sound meter at the bassinet: 45 to 50 dBA at the loudest level, never more.' },
      { path: 'sound.baselineDb', label: 'Baseline loudness', type: 'range', min: -30, max: -6, step: 1,
        fmt: (v) => `${-v} dB below Level 4`, help: 'How much quieter the all-night baseline is than the loudest level.' },
      { custom: 'preview' },
    ],
  },
  {
    title: 'Womb sound',
    fields: [
      { path: 'sound.bpm', label: 'Heartbeat', type: 'range', min: 60, max: 90, step: 1, fmt: (v) => `${v} beats per minute` },
      { path: 'sound.whooshDepth', label: 'Pulse strength', type: 'range', min: 0, max: 0.8, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
      { path: 'sound.tone', label: 'Rumble tone', type: 'range', min: 300, max: 800, step: 10, fmt: (v) => `${v} Hz`, help: 'Lower is deeper and more muffled.' },
    ],
  },
  {
    title: 'Music through the womb filter',
    fields: [
      { path: 'tracksEnabled', label: 'Play my audio files', type: 'toggle', help: 'They loop softly under the rumble, filtered to sound as if heard from inside.' },
      { custom: 'tracks' },
      { path: 'sound.trackVolume', label: 'Music volume', type: 'range', min: 0, max: 100, step: 1, fmt: (v) => `${v}%` },
    ],
  },
  {
    title: 'Womb filter',
    fields: [
      { custom: 'presets' },
      { custom: 'curve' },
      { path: 'sound.womb.cutoff', label: 'Muffling starts at', type: 'range', min: 150, max: 1500, step: 10, fmt: (v) => `${v} Hz`,
        help: 'Sound below this passes through; sound above it fades.' },
      { path: 'sound.womb.slope', label: 'How fast it fades', type: 'select', numeric: true, options: [
        [6, 'Gentle, 6 dB/octave (most realistic)'],
        [12, 'Medium, 12 dB/octave'],
        [24, 'Steep, 24 dB/octave'],
      ] },
      { path: 'sound.womb.bodyBoostDb', label: 'Body warmth', type: 'range', min: 0, max: 6, step: 0.5, fmt: (v) => `+${v} dB below 250 Hz`,
        help: "A mother's own voice is slightly boosted at low frequencies on its way through her body." },
      { path: 'sound.wombBypass', label: 'Compare: filter off', type: 'toggle', help: 'Hear the original for comparison. Turn this back off before the night.' },
    ],
  },
  {
    title: "Mom's voice",
    fields: [
      { custom: 'voice' },
      { path: 'voiceEnabled', label: 'Play the voice clip', type: 'toggle', help: 'Loops softly through the womb filter.' },
      { path: 'sound.voiceVolume', label: 'Voice volume', type: 'range', min: 0, max: 100, step: 1, fmt: (v) => `${v}%` },
      { path: 'sound.voiceGapSec', label: 'Silence between repeats', type: 'range', min: 0, max: 60, step: 1, fmt: (v) => `${v} s` },
    ],
  },
  {
    title: 'Cry detection',
    fields: [
      { path: 'shadowMode', label: 'Shadow mode', type: 'toggle', help: 'Listen and log what would happen, but keep the sound at baseline. Use it for the first nights.' },
      { path: 'sensitivity', label: 'Sensitivity', type: 'select', options: [
        ['low', 'Low: clear, loud crying only'],
        ['medium', 'Medium'],
        ['high', 'High: quieter crying too'],
      ] },
      { path: 'timings.windowsNeeded', label: 'Seconds of crying needed', type: 'range', min: 1, max: 5, step: 1, fmt: (v) => `${v} of the last 5` },
      { path: 'echoCancellation', label: 'Echo cancellation', type: 'toggle', help: "Removes the app's own sound from the microphone, but on some phones it mutes or reroutes the speaker. Leave off unless the Phone test shows it is safe. Applies from the next Start." },
      { path: 'muteOnSpeakerChange', label: 'Mute if the speaker disconnects', type: 'toggle', help: 'Stops the phone itself from playing next to the baby if Bluetooth drops.' },
    ],
  },
  {
    title: 'Timings',
    fields: [
      { path: 'timings.escalateEverySec', label: 'Step up while crying continues', type: 'range', min: 10, max: 60, step: 5, fmt: (v) => `every ${v} s` },
      { path: 'timings.quietStepDownSec', label: 'Step down after quiet for', type: 'range', min: 20, max: 180, step: 10, fmt: secLabel },
      { path: 'timings.giveUpAfterSec', label: 'Give up at Level 4 after', type: 'range', min: 60, max: 300, step: 15, fmt: secLabel, help: 'Then the sound returns to baseline and "Baby needs you" is shown.' },
      { path: 'timings.rearmQuietSec', label: 'Listen again after quiet for', type: 'range', min: 60, max: 900, step: 30, fmt: secLabel },
      { path: 'timings.pauseSec', label: 'Length of a pause', type: 'range', min: 300, max: 3600, step: 300, fmt: secLabel },
    ],
  },
  {
    title: 'Testing',
    fields: [
      { path: 'fastTest', label: 'Fast test clock', type: 'toggle', help: 'Runs the timings about ten times faster, to watch a whole escalation with Simulate crying. Turn off for real use.' },
    ],
  },
  { title: 'Data', fields: [{ custom: 'data' }] },
];

function applySetting(path, value) {
  setPath(settings, path, value);
  store.saveSettings(settings);
  if (path.startsWith('sound.womb.')) {
    engine.setOptions({ womb: { [path.split('.')[2]]: value } });
    drawCurve();
  } else if (path.startsWith('sound.')) {
    engine.setOptions({ [path.split('.')[1]]: value });
  } else if (path === 'sensitivity') {
    if (detector) detector.setSensitivity(value);
  } else if (path === 'tracksEnabled' || path === 'voiceEnabled') {
    if (engine.running) loadMedia();
  } else if (path === 'shadowMode') {
    if (running) {
      engine.setLevel(value ? 0 : machine.level);
      log(value ? 'Shadow mode on' : 'Shadow mode off');
    }
  }
  render();
}

function buildField(f) {
  if (f.custom) return CUSTOM[f.custom]();
  const value = getPath(settings, f.path);
  const help = f.help ? el('small', { text: f.help }) : null;

  if (f.type === 'toggle') {
    const input = el('input', { type: 'checkbox', 'data-path': f.path });
    input.checked = !!value;
    input.addEventListener('change', () => applySetting(f.path, input.checked));
    return el('label', { class: 'field toggle' }, [el('span', {}, [el('span', { text: f.label }), help]), input]);
  }
  if (f.type === 'select') {
    const select = el('select', { 'data-path': f.path }, f.options.map(([v, label]) => el('option', { value: v, text: label })));
    select.value = String(value);
    select.addEventListener('change', () => applySetting(f.path, f.numeric ? Number(select.value) : select.value));
    return el('label', { class: 'field' }, [el('span', { text: f.label }), select, help]);
  }
  const out = el('output', { text: f.fmt ? f.fmt(value) : String(value) });
  const input = el('input', { type: 'range', min: f.min, max: f.max, step: f.step, 'data-path': f.path });
  input.value = value;
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = f.fmt ? f.fmt(v) : String(v);
    applySetting(f.path, v);
  });
  return el('label', { class: 'field' }, [
    el('span', { class: 'field-head' }, [el('span', { text: f.label }), out]),
    input,
    help,
  ]);
}

function buildSettings() {
  const form = $('settingsForm');
  form.replaceChildren(
    ...GROUPS.map((g) => el('section', { class: 'group' }, [el('h3', { text: g.title }), ...g.fields.map(buildField)])),
  );
  syncPreviewButtons();
  drawCurve();
  refreshTracks();
  refreshVoice();
}

// ---- custom settings widgets ----

let previewLevel = 0;
let recorder = null;
let recordTimer = null;

const CUSTOM = {
  preview() {
    const select = el('select', { 'aria-label': 'Level to preview' },
      LEVEL_NAMES.map((n, i) => el('option', { value: i, text: n })));
    select.value = String(previewLevel);
    select.addEventListener('change', () => {
      previewLevel = Number(select.value);
      if (preview != null) setPreview(previewLevel);
    });
    const btn = el('button', { type: 'button', id: 'previewToggle', text: 'Preview sound' });
    btn.addEventListener('click', () => setPreview(preview != null ? null : previewLevel));
    return el('div', { class: 'field' }, [
      el('div', { class: 'row' }, [select, btn]),
      el('small', { text: 'Listen to any level, with your music and voice clip, while Hushabye is stopped.' }),
    ]);
  },

  tracks() {
    const input = el('input', { type: 'file', accept: 'audio/*', multiple: true, 'aria-label': 'Choose audio files' });
    input.addEventListener('change', async () => {
      const files = [...input.files];
      for (let i = 0; i < files.length; i++) {
        await store.putBlob(`track:${Date.now()}-${i}`, files[i], files[i].name);
      }
      input.value = '';
      if (files.length && !settings.tracksEnabled) {
        applySetting('tracksEnabled', true);
        const box = document.querySelector('[data-path="tracksEnabled"]');
        if (box) box.checked = true;
      } else if (engine.running) {
        loadMedia();
      }
      refreshTracks();
    });
    return el('div', { class: 'field' }, [
      el('ul', { class: 'tracks', id: 'trackList' }),
      el('span', { class: 'file-btn' }, [el('button', { type: 'button', text: 'Choose audio files', tabindex: '-1' }), input]),
      el('small', { text: 'Files are copied into this browser and stay on this phone.' }),
    ]);
  },

  presets() {
    return el('div', { class: 'row' }, Object.entries(WOMB_PRESETS).map(([key, p]) =>
      el('button', { type: 'button', text: p.label, onclick: () => {
        applySetting('sound.womb.cutoff', p.cutoff);
        applySetting('sound.womb.slope', p.slope);
        applySetting('sound.womb.bodyBoostDb', p.bodyBoostDb);
        const y = $('settings').scrollTop;
        buildSettings();
        $('settings').scrollTop = y;
      } })));
  },

  curve() {
    return el('div', { class: 'field' }, [
      el('canvas', { class: 'curve', id: 'wombCurve', width: 600, height: 240, role: 'img', 'aria-label': 'Womb filter frequency response' }),
      el('small', { text: 'What gets through: bass on the left, treble on the right. Speech consonants live around 2 to 4 kHz.' }),
    ]);
  },

  voice() {
    const status = el('span', { id: 'voiceStatus', class: 'hint', text: '' });
    const rec = el('button', { type: 'button', id: 'voiceRecord', text: 'Record a clip' });
    const del = el('button', { type: 'button', id: 'voiceDelete', text: 'Delete clip' });
    rec.addEventListener('click', toggleRecording);
    del.addEventListener('click', async () => {
      await store.deleteBlob('voice');
      if (engine.running) loadMedia();
      refreshVoice();
    });
    return el('div', { class: 'field' }, [
      el('div', { class: 'row' }, [rec, del]),
      status,
      el('small', { text: 'Talk, read or hum for up to a minute, somewhere quiet. Low, slow and sing-song works best: melody survives the filter, words do not.' }),
    ]);
  },

  data() {
    return el('div', { class: 'field' }, [
      el('div', { class: 'row' }, [
        el('button', { type: 'button', text: 'Export night log', onclick: exportLog }),
        el('button', { type: 'button', text: 'Clear log', onclick: async () => {
          await store.clearLog();
          $('log').replaceChildren(el('li', { class: 'empty', text: 'Nothing yet.' }));
        } }),
      ]),
      el('small', { text: 'The log holds events and one cry score per second for the last 7 nights. No audio is ever stored or sent anywhere.' }),
    ]);
  },
};

async function refreshTracks() {
  const list = $('trackList');
  if (!list) return;
  let tracks = [];
  try {
    tracks = await store.listTracks();
  } catch (_) { /* no IndexedDB */ }
  list.replaceChildren(...(tracks.length
    ? tracks.map((t) => el('li', {}, [
        el('span', { text: t.name }),
        el('button', { type: 'button', text: 'Remove', onclick: async () => {
          await store.deleteBlob(t.id);
          if (engine.running) loadMedia();
          refreshTracks();
        } }),
      ]))
    : [el('li', { class: 'hint', text: 'No files chosen yet.' })]));
}

async function refreshVoice() {
  const status = $('voiceStatus');
  if (!status) return;
  let has = false;
  try {
    has = !!(await store.getBlob('voice'));
  } catch (_) { /* no IndexedDB */ }
  if (!recorder) status.textContent = has ? 'A clip is saved.' : 'No clip recorded yet.';
  $('voiceDelete').disabled = !has || !!recorder;
  $('voiceRecord').textContent = recorder ? 'Stop recording' : has ? 'Record again' : 'Record a clip';
  $('voiceRecord').setAttribute('aria-pressed', String(!!recorder));
}

async function toggleRecording() {
  if (recorder) {
    recorder.stop();
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch (err) {
    $('voiceStatus').textContent = await micProblem(err);
    return;
  }
  // Silence our own output so it does not end up in the recording.
  recordingMuted = !engine.safetyMuted;
  if (recordingMuted) engine.setSafetyMute(true);
  const chunks = [];
  const started = Date.now();
  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = async () => {
    clearInterval(recordTimer);
    stream.getTracks().forEach((t) => t.stop());
    const type = recorder.mimeType;
    recorder = null;
    if (recordingMuted) engine.setSafetyMute(false);
    if (chunks.length) {
      await store.putBlob('voice', new Blob(chunks, { type }), 'voice');
      if (!settings.voiceEnabled) {
        applySetting('voiceEnabled', true);
        const box = document.querySelector('[data-path="voiceEnabled"]');
        if (box) box.checked = true;
      } else if (engine.running) {
        loadMedia();
      }
    }
    refreshVoice();
  };
  recorder.start();
  recordTimer = setInterval(() => {
    const s = Math.floor((Date.now() - started) / 1000);
    if ($('voiceStatus')) $('voiceStatus').textContent = `Recording 0:${String(s).padStart(2, '0')}`;
    if (s >= 60 && recorder) recorder.stop();
  }, 250);
  refreshVoice();
}

function drawCurve() {
  const canvas = $('wombCurve');
  if (!canvas) return;
  const g = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const css = getComputedStyle(document.documentElement);
  const fMin = 30, fMax = 8000, dbMin = -42, dbMax = 9;
  const x = (f) => (Math.log(f / fMin) / Math.log(fMax / fMin)) * W;
  const y = (db) => ((dbMax - db) / (dbMax - dbMin)) * H;
  g.clearRect(0, 0, W, H);
  g.font = '20px system-ui, sans-serif';
  g.lineWidth = 1;
  g.strokeStyle = css.getPropertyValue('--line');
  g.fillStyle = css.getPropertyValue('--dim');
  for (const f of [100, 300, 1000, 3000]) {
    g.beginPath();
    g.moveTo(x(f), 0);
    g.lineTo(x(f), H);
    g.stroke();
    g.fillText(f >= 1000 ? `${f / 1000} kHz` : `${f} Hz`, x(f) + 5, H - 8);
  }
  for (const db of [0, -20, -40]) {
    g.beginPath();
    g.moveTo(0, y(db));
    g.lineTo(W, y(db));
    g.stroke();
    g.fillText(`${db} dB`, 6, y(db) - 5);
  }
  const freqs = [];
  for (let i = 0; i <= 200; i++) freqs.push(fMin * Math.pow(fMax / fMin, i / 200));
  const flat = settings.sound.wombBypass;
  const resp = wombResponseDb(settings.sound.womb, freqs);
  g.beginPath();
  freqs.forEach((f, i) => {
    const py = y(Math.max(dbMin, flat ? 0 : resp[i]));
    if (i === 0) g.moveTo(x(f), py);
    else g.lineTo(x(f), py);
  });
  g.lineWidth = 4;
  g.strokeStyle = css.getPropertyValue('--accent');
  g.stroke();
}

async function exportLog() {
  const data = await store.exportLog({ appVersion: APP_VERSION, settings });
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  const a = el('a', { href: url, download: `hushabye-log-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ----------------------------------------------------------- night screen

let nightTimer = null;
let lastTap = 0;

function openNight() {
  $('night').hidden = false;
  const tick = () => {
    $('nightClock').textContent = clock().slice(0, 5);
    // Move the text now and then so it never burns into the screen.
    if (Math.floor(Date.now() / 1000) % 60 === 0 || !$('nightText').dataset.placed) {
      $('nightText').dataset.placed = '1';
      $('nightText').style.left = `${8 + Math.random() * 50}%`;
      $('nightText').style.top = `${10 + Math.random() * 65}%`;
    }
  };
  tick();
  nightTimer = setInterval(tick, 1000);
  if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
}

function closeNight() {
  $('night').hidden = true;
  clearInterval(nightTimer);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

$('night').addEventListener('pointerup', () => {
  const now = Date.now();
  if (now - lastTap < 450) closeNight();
  lastTap = now;
});

// ------------------------------------------------------------- main page

$('startStop').addEventListener('click', () => (running ? stop() : start()));
$('pauseBtn').addEventListener('click', () => {
  if (!running) return;
  dispatch({ type: machine.mode === 'paused' ? 'resume' : 'pause', t: currentVt() });
});
$('simBtn').addEventListener('click', () => {
  if (!running) return;
  simCrying = !simCrying;
  log(simCrying ? 'Test: simulated crying started' : 'Test: simulated crying stopped');
  render();
});
$('nightBtn').addEventListener('click', openNight);
$('needsPause').addEventListener('click', () => dispatch({ type: 'pause', t: currentVt() }));
$('needsResume').addEventListener('click', () => dispatch({ type: 'ack', t: currentVt() }));
$('bannerAction').addEventListener('click', () => (bannerHandler ? bannerHandler() : hideBanner()));
$('setupBtn').addEventListener('click', () => openSetup(0));
$('settingsBtn').addEventListener('click', () => {
  buildSettings();
  $('settings').hidden = false;
  $('settings').scrollTop = 0;
});
$('settingsClose').addEventListener('click', async () => {
  if (recorder) recorder.stop();
  if (preview != null) await setPreview(null);
  $('settings').hidden = true;
});

$('version').textContent = `Version ${APP_VERSION}`;
restoreLog();
render();
if (!settings.setupDone) openSetup(0);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// For the automated tests and for poking around in the console.
window.__hush = {
  engine,
  get machine() { return machine; },
  get settings() { return settings; },
  get detector() { return detector; },
  get vt() { return vt; },
  applySetting,
  dispatch,
};
