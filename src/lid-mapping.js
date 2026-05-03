// Cache + Firestore lookup for `lidMappings` — the per-LID record the bot
// writes once a user has self-identified by typing their auth code into the
// WhatsApp chat.
//
// Doc ID equals the LID JID (e.g. `12345678901234@lid`), so lookups are a
// single-doc get. We cache hits in-process for 5 minutes — same TTL as the
// phone-based sender-resolver — so back-to-back messages from the same LID
// don't hit Firestore on every turn.

import { db, FieldValue } from './firebase-admin.js';

const COLLECTION = 'lidMappings';
const CACHE_TTL_MS = 5 * 60 * 1000;

const cache = new Map(); // lid -> { value, expiresAt }

/**
 * @typedef {Object} LidMapping
 * @property {string} lid
 * @property {string} memberId
 * @property {string} familyId
 * @property {string|null} phone   cached phone for the linked member, may be null
 */

/**
 * Look up the mapping for a LID JID. Returns null if the bot has not seen this
 * LID before.
 *
 * @param {string} lid
 * @returns {Promise<LidMapping|null>}
 */
export async function lookupLidMapping(lid) {
  if (!lid) return null;
  const cached = cache.get(lid);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const snap = await db.collection(COLLECTION).doc(lid).get();
  if (!snap.exists) {
    cache.set(lid, { value: null, expiresAt: Date.now() + CACHE_TTL_MS });
    return null;
  }
  const data = snap.data() || {};
  const value = {
    lid,
    memberId: data.memberId,
    familyId: data.familyId,
    phone: data.phone ?? null,
  };
  cache.set(lid, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/**
 * Persist a fresh mapping. Overwrites any prior mapping for the same LID
 * (rare but possible: same phone re-claimed by a new member after being
 * removed and re-added).
 *
 * @param {Object} args
 * @param {string} args.lid
 * @param {string} args.memberId
 * @param {string} args.familyId
 * @param {string|null} [args.phone]
 */
export async function storeLidMapping({ lid, memberId, familyId, phone = null }) {
  if (!lid || !memberId || !familyId) {
    throw new Error('storeLidMapping requires lid, memberId, familyId');
  }
  await db.collection(COLLECTION).doc(lid).set(
    {
      lid,
      memberId,
      familyId,
      phone,
      linkedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  // Refresh cache immediately so the very next message routes via the new mapping.
  cache.set(
    lid,
    {
      value: { lid, memberId, familyId, phone },
      expiresAt: Date.now() + CACHE_TTL_MS,
    }
  );
}

/**
 * Drop the cached entry for a LID. Used when a mapping is invalidated (e.g.
 * a future admin tool that unlinks a LID).
 *
 * @param {string} lid
 */
export function invalidateLidCache(lid) {
  if (lid) cache.delete(lid);
}
