// Firestore lookup for `lidMappings` — the per-LID record the bot writes
// once a user has self-identified by typing their auth code into the
// WhatsApp chat. Doc ID equals the LID JID (e.g. `12345678901234@lid`),
// so lookups are a single-doc get.
//
// We deliberately do NOT cache results in process. The app lets users
// disconnect themselves (deleting their lidMappings row); a stale cache
// would make the bot keep recognizing a disconnected user for the cache
// TTL, which surprises the user. At our scale (handful of messages per
// minute across the whole family), one Firestore read per incoming
// message is well under any free-tier quota.

import { db, FieldValue } from './firebase-admin.js';

const COLLECTION = 'lidMappings';

/**
 * @typedef {Object} LidMapping
 * @property {string} lid
 * @property {string} memberId
 * @property {string} familyId
 * @property {string|null} phone   cached phone for the linked member, may be null
 */

/**
 * Look up the mapping for a LID JID. Returns null if the bot has not seen
 * this LID before, or if the user has disconnected since.
 *
 * @param {string} lid
 * @returns {Promise<LidMapping|null>}
 */
export async function lookupLidMapping(lid) {
  if (!lid) return null;
  const snap = await db.collection(COLLECTION).doc(lid).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  return {
    lid,
    memberId: data.memberId,
    familyId: data.familyId,
    phone: data.phone ?? null,
  };
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
}

/**
 * Kept for API compatibility — the in-process cache was removed so this is
 * a no-op now. Safe to call.
 *
 * @param {string} _lid
 */
export function invalidateLidCache(_lid) {
  /* no-op: no cache to invalidate */
}
