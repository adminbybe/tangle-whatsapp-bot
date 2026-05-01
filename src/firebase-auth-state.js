// Persists Baileys WhatsApp session credentials in Firebase Realtime DB so the
// bot can survive Render restarts without re-scanning the QR. Uses the Admin
// SDK (authenticated) — anonymous HTTP gets Permission Denied on RTDB rules.

import * as baileys from '@whiskeysockets/baileys';
import pino from 'pino';
import { rtdb } from './firebase-admin.js';

const { initAuthCreds, BufferJSON, makeCacheableSignalKeyStore } = baileys;
const silentLogger = pino({ level: 'silent' });

async function fbGet(path) {
  try {
    const snap = await rtdb.ref(path).once('value');
    return snap.val();
  } catch (e) {
    console.error('[auth-state] fbGet failed', path, e.message);
    return null;
  }
}

async function fbSet(path, data) {
  try {
    await rtdb.ref(path).set(data);
  } catch (e) {
    console.error('[auth-state] fbSet failed', path, e.message);
  }
}

async function fbDel(path) {
  try {
    await rtdb.ref(path).remove();
  } catch (e) {
    console.error('[auth-state] fbDel failed', path, e.message);
  }
}

// Sanitize keys so they are valid Firebase Realtime DB paths (no .#$[])
function sanitizeKey(key) {
  return key.replace(/[.#$[\]/]/g, '_');
}

export async function useFirebaseAuthState() {
  async function readData(key) {
    const safe = sanitizeKey(key);
    const data = await fbGet(`tangleBotAuth/${safe}`);
    if (!data || typeof data !== 'string') return null;
    try {
      return JSON.parse(data, BufferJSON.reviver);
    } catch {
      return null;
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
