// In-process undo manager.
// When an intent auto-executes, we register a handle keyed by an opaque token
// AND indexed by sender phone, with an expiry timer (default 30s). If the
// sender then sends "בטל" within the window, we consume the most recent
// non-expired handle for that phone and revert it.
//
// Trade-off: state is in memory only. On Render restart any in-flight undos
// are lost (the entity stays). We accept this — fail-closed is safer than
// fail-open for the user's data.

import { updateBotMessageStatus } from './bot-message-log.js';

const DEFAULT_TTL_MS = 30_000;

/**
 * @typedef {Object} UndoHandle
 * @property {string} token
 * @property {string} phone
 * @property {string} entityType         e.g. 'event', 'recurringTaskCompletion', 'todo'
 * @property {FirebaseFirestore.DocumentReference} entityRef
 * @property {string|null} botMessageId
 * @property {number} expiresAt          ms epoch
 * @property {string|null} entityTitle   optional, used in cancel reply
 * @property {NodeJS.Timeout} [timer]
 */

class UndoManager {
  constructor() {
    /** @type {Map<string, UndoHandle>} */
    this.byToken = new Map();
    /** @type {Map<string, string[]>} */ // phone -> token stack, oldest first
    this.byPhone = new Map();
  }

  /**
   * @param {Omit<UndoHandle, 'expiresAt'|'timer'> & { ttlMs?: number, expiresAt?: number }} opts
   */
  register(opts) {
    const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
    const expiresAt = opts.expiresAt ?? Date.now() + ttl;

    /** @type {UndoHandle} */
    const handle = {
      token: opts.token,
      phone: opts.phone,
      entityType: opts.entityType,
      entityRef: opts.entityRef,
      botMessageId: opts.botMessageId ?? null,
      entityTitle: opts.entityTitle ?? null,
      expiresAt,
    };
    this.byToken.set(handle.token, handle);
    if (!this.byPhone.has(handle.phone)) this.byPhone.set(handle.phone, []);
    this.byPhone.get(handle.phone).push(handle.token);

    handle.timer = setTimeout(() => {
      this._purge(handle.token);
    }, Math.max(0, expiresAt - Date.now()));
    return handle;
  }

  _purge(token) {
    const h = this.byToken.get(token);
    if (!h) return;
    if (h.timer) clearTimeout(h.timer);
    this.byToken.delete(token);
    const list = this.byPhone.get(h.phone);
    if (list) {
      const idx = list.indexOf(token);
      if (idx >= 0) list.splice(idx, 1);
      if (list.length === 0) this.byPhone.delete(h.phone);
    }
  }

  /**
   * Remove and return the most-recent non-expired handle for a phone, or null.
   * @param {string} phone
   * @returns {UndoHandle|null}
   */
  consume(phone) {
    const list = this.byPhone.get(phone);
    if (!list || list.length === 0) return null;
    while (list.length > 0) {
      const token = list[list.length - 1];
      const h = this.byToken.get(token);
      if (!h) {
        list.pop();
        continue;
      }
      if (h.expiresAt <= Date.now()) {
        this._purge(token);
        continue;
      }
      // pop it and return — caller will revert
      list.pop();
      this.byToken.delete(token);
      if (list.length === 0) this.byPhone.delete(phone);
      if (h.timer) clearTimeout(h.timer);
      return h;
    }
    return null;
  }

  /**
   * Delete the entity referenced by a handle and mark its bot message reverted.
   * @param {UndoHandle} handle
   */
  async revert(handle) {
    if (!handle) return;
    try {
      await handle.entityRef.delete();
    } catch (err) {
      console.error('[undo] failed to delete entity:', err.message);
      throw err;
    }
    if (handle.botMessageId) {
      try {
        await updateBotMessageStatus(handle.botMessageId, 'reverted');
      } catch (err) {
        console.error('[undo] failed to update bot message status:', err.message);
      }
    }
  }
}

export const undoManager = new UndoManager();

/** Generate a short, unique token. */
export function newUndoToken() {
  return (
    Date.now().toString(36) +
    '-' +
    Math.random().toString(36).slice(2, 10)
  );
}
