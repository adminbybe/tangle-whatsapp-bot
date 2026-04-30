// Resolves a WhatsApp sender (E.164 phone) to their Tangle family + member.
// Caches results in-process for 5 minutes so back-to-back messages from the
// same sender don't hit Firestore on every turn.

import { db } from './firebase-admin.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // phone -> { value, expiresAt }

/**
 * @typedef {Object} ResolvedSender
 * @property {string} familyId
 * @property {string} memberId
 * @property {string|null} linkedUserId
 * @property {string} displayName
 * @property {string} phone
 */

/**
 * Look up a Tangle family member by their phone number.
 * @param {string} e164
 * @returns {Promise<ResolvedSender|null>}
 */
export async function resolveSender(e164) {
  if (!e164) return null;

  const cached = cache.get(e164);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const snap = await db
    .collection('familyMembers')
    .where('phone', '==', e164)
    .limit(1)
    .get();

  if (snap.empty) {
    cache.set(e164, { value: null, expiresAt: Date.now() + CACHE_TTL_MS });
    return null;
  }

  const doc = snap.docs[0];
  const data = doc.data();
  const value = {
    familyId: data.familyId,
    memberId: doc.id,
    linkedUserId: data.linkedUserId ?? null,
    displayName: data.firstName || 'משתמש',
    phone: e164,
  };
  cache.set(e164, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/**
 * Drop the cached entry for a phone (used when membership changes — currently
 * not wired up, but useful in the future).
 * @param {string} e164
 */
export function invalidateSenderCache(e164) {
  if (e164) cache.delete(e164);
}
