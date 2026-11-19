// Persistence. Small settings live in localStorage; audio blobs and the
// night log live in IndexedDB. Everything stays on this device.

import { DEFAULT_TIMINGS } from './state-machine.js';
import { DEFAULT_SOUND } from './sound-engine.js';

const SETTINGS_KEY = 'hushabye.settings.v1';
const DB_NAME = 'hushabye';
const DB_VERSION = 1;
const KEEP_NIGHTS_MS = 7 * 24 * 3600 * 1000;

export const DEFAULT_SETTINGS = {
  version: 2,
  setupDone: false,
  sound: { ...DEFAULT_SOUND },
  timings: { ...DEFAULT_TIMINGS },
  sensitivity: 'medium',
  echoCancellation: false,   // on some phones it reroutes or mutes playback
  shadowMode: true,          // first nights: detect and log only
  muteOnSpeakerChange: true,
  tracksEnabled: false,
  voiceEnabled: false,
  fastTest: false,
};

export function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {};
  } catch (_) {
    saved = {};
  }
  if ((saved.version || 1) < 2) {
    // Version 1 shipped a cap and baseline too quiet to hear on most
    // speakers, and echo cancellation on. Values still at those old
    // defaults move to the new ones; anything the user changed is kept.
    if (saved.sound && saved.sound.cap === 40) delete saved.sound.cap;
    if (saved.sound && saved.sound.baselineDb === -16) delete saved.sound.baselineDb;
    delete saved.echoCancellation;
    saved.version = 2;
  }
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    sound: { ...DEFAULT_SETTINGS.sound, ...(saved.sound || {}), womb: { ...DEFAULT_SOUND.womb, ...((saved.sound || {}).womb || {}) } },
    timings: { ...DEFAULT_SETTINGS.timings, ...(saved.timings || {}) },
  };
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (_) {
    /* private mode or full storage: settings just will not persist */
  }
}

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { autoIncrement: true });
        if (!db.objectStoreNames.contains('scores')) db.createObjectStore('scores', { autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// ---- audio blobs: music tracks ('track:<n>') and the voice clip ('voice') ----

export async function putBlob(id, blob, name) {
  return tx('blobs', 'readwrite', (s) => s.put({ id, blob, name, added: Date.now() }));
}

export async function getBlob(id) {
  return tx('blobs', 'readonly', (s) => s.get(id));
}

export async function deleteBlob(id) {
  return tx('blobs', 'readwrite', (s) => s.delete(id));
}

export async function listTracks() {
  const all = await tx('blobs', 'readonly', (s) => s.getAll());
  return (all || []).filter((r) => r.id.startsWith('track:')).sort((a, b) => a.added - b.added);
}

// ---- night log ----

export async function logEvent(event) {
  return tx('events', 'readwrite', (s) => s.add({ ...event, at: Date.now() })).catch(() => {});
}

/** One row per minute: { at, engine, scores: [...], levels: [...] } */
export async function logScores(row) {
  return tx('scores', 'readwrite', (s) => s.add(row)).catch(() => {});
}

export async function exportLog(extra = {}) {
  const [events, scores] = await Promise.all([
    tx('events', 'readonly', (s) => s.getAll()),
    tx('scores', 'readonly', (s) => s.getAll()),
  ]);
  return { exportedAt: new Date().toISOString(), ...extra, events: events || [], scores: scores || [] };
}

export async function recentEvents(limit = 100) {
  const all = (await tx('events', 'readonly', (s) => s.getAll())) || [];
  return all.slice(-limit);
}

export async function pruneLog() {
  const cutoff = Date.now() - KEEP_NIGHTS_MS;
  for (const store of ['events', 'scores']) {
    await tx(store, 'readwrite', (s) => {
      const req = s.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        if ((cur.value.at || 0) < cutoff) {
          cur.delete();
          cur.continue();
        }
      };
    }).catch(() => {});
  }
}

export async function clearLog() {
  await tx('events', 'readwrite', (s) => s.clear());
  await tx('scores', 'readwrite', (s) => s.clear());
}
