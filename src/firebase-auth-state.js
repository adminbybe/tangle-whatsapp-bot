// Persists Baileys WhatsApp session credentials in Firebase Realtime DB so the
// bot can survive Render restarts without re-scanning the QR. Uses raw HTTP
// fetch (Node 20+) — keeps compatibility with the original implementation.

import * as baileys from '@whiskeysockets/baileys';
import pino from 'pino';
const { initAuthCreds, BufferJSON, makeCacheableSignalKeyStore } = baileys;
const silentLogger = pino({ level: 'silent' });
import { REALTIME_DB_URL } from './firebase-admin.js';

const FIREBASE_DB = REALTIME_DB_URL;

async function fbGet(path) {
  try {
    const res = await fetch(`${FIREBASE_DB}/${path}.json`);
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function fbSet(path, data) {
  try {
    await fetch(`${FIREBASE_DB}/${path}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  } catch (e) {
    /* noop */
  }
}

async function fbDel(path) {
  try {
    await fetch(`${FIREBASE_DB}/${path}.json`, { method: 'DELETE' });
  } catch (e) {
    /* noop */
  }
}

// Sanitize keys so they are valid Firebase Realtime DB paths (no .#$[])
function sanitizeKey(key) {
  return key.replace(/[.#$[\]]/g, '_');
}

export async function useFirebaseAuthState() {
  async function readData(key) {
    const safe = sanitizeKey(key);
    const data = await fbGet(`tangleBotAuth/${safe}`);
    if (!data) return null;
    try {
      return JSON.parse(data, BufferJSON.reviver);
    } catch (e) {
      return data;
    }
  }

  async function writeData(key, value) {
    const safe = sanitizeKey(key);
    await fbSet(`tangleBotAuth/${safe}`, JSON.stringify(value, BufferJSON.replacer));
  }

  async function removeData(key) {
    const safe = sanitizeKey(key);
    await fbDel(`tangleBotAuth/${safe}`);
  }

  const creds = (await readData('creds')) || initAuthCreds();

  const rawKeys = {
    get: async (type, ids) => {
      const data = {};
      for (const id of ids) {
        const val = await readData(`keys_${type}_${id}`);
        if (val) data[id] = val;
      }
      return data;
    },
    set: async (data) => {
      for (const [type, typeData] of Object.entries(data)) {
        for (const [id, val] of Object.entries(typeData || {})) {
          if (val) {
            await writeData(`keys_${type}_${id}`, val);
          } else {
            await removeData(`keys_${type}_${id}`);
          }
        }
      }
    },
  };

  const state = {
    creds,
    keys: makeCacheableSignalKeyStore(rawKeys, silentLogger),
  };

  const saveCreds = async () => {
    await writeData('creds', state.creds);
  };

  return { state, saveCreds };
}

export async function clearAuthState() {
  await fbDel('tangleBotAuth');
}
