// Resolves a WhatsApp sender (E.164 phone) to their Tangle family + member.
// Caches results in-process for 5 minutes so back-to-back messages from the
// same sender don't hit Firestore on every turn.

import { db } from './firebase-admin.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // phone -> { value, expiresAt }
const memberCache = new Map(); // memberId -> { value, expiresAt }

/**
 * @typedef {Object} ResolvedSender
 * @property {string} familyId
 * @property {string} memberId
 * @property {string|null} linkedUserId
 * @property {string} displayName
 * @property {string|null} nickname
 * @property {'parent'|'child'|'other'|null} role
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
    nickname: data.nickname ?? null,
    role: data.role ?? null,
    phone: e164,
  };
  cache.set(e164, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/**
 * Same shape as `resolveSender`, but keyed by familyMember doc ID. Used by
 * the LID-mapping flow once the bot already knows which Tangle member a
 * given WhatsApp `@lid` sender corresponds to — we skip the phone lookup
 * entirely. `phone` on the returned object may be null if the member doesn't
 * have a phone field set in Firestore.
 *
 * @param {string} memberId
 * @returns {Promise<ResolvedSender|null>}
 */
export async function resolveSenderByMemberId(memberId) {
  if (!memberId) return null;

  const cached = memberCache.get(memberId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const snap = await db.collection('familyMembers').doc(memberId).get();
  if (!snap.exists) {
    memberCache.set(memberId, { value: null, expiresAt: Date.now() + CACHE_TTL_MS });
    return null;
  }

  const data = snap.data() || {};
  const value = {
    familyId: data.familyId,
    memberId: snap.id,
    linkedUserId: data.linkedUserId ?? null,
    displayName: data.firstName || 'משתמש',
    nickname: data.nickname ?? null,
    role: data.role ?? null,
    phone: data.phone ?? null,
  };
  memberCache.set(memberId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  // Also seed the phone-keyed cache so a follow-up phone-based path hits
  // the same value without an extra read.
  if (value.phone) {
    cache.set(value.phone, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }
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

/**
 * Drop the cached entry for a memberId (mirror of invalidateSenderCache).
 * @param {string} memberId
 */
export function invalidateSenderCacheByMemberId(memberId) {
  if (memberId) memberCache.delete(memberId);
}
