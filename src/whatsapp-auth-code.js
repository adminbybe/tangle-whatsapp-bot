// Validates and consumes the 6-digit `whatsappAuthCodes` doc that a user
// types into WhatsApp on first contact with the bot. The doc ID IS the code,
// so the bot's full lookup is a single Firestore get.
//
// The claim runs as a transaction: read code → check expiry/usage → mark used
// → write the lidMappings row. If two messages with the same code arrive at
// once (e.g. the user retried), the second transaction sees `usedAt` set and
// returns a "code already used" error.

import { db, FieldValue, Timestamp } from './firebase-admin.js';
import { storeLidMapping } from './lid-mapping.js';

const CODES_COLLECTION = 'whatsappAuthCodes';
const MAPPINGS_COLLECTION = 'lidMappings';

// Match exactly: optional whitespace, the Hebrew word "קוד", whitespace,
// 6 digits, optional whitespace. Anything else (incl. extra text after the
// code) is treated as a free-form message rather than a claim attempt — we
// want a strict pattern so the user can't accidentally trigger a claim by
// quoting the bot's onboarding message back at it.
const CODE_PATTERN = /^\s*קוד\s+(\d{6})\s*$/;

/**
 * Extract a 6-digit code from a Hebrew "קוד NNNNNN" message. Returns null if
 * the text is anything else.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function extractAuthCode(text) {
  if (!text) return null;
  const m = String(text).match(CODE_PATTERN);
  return m ? m[1] : null;
}

/**
 * Result of a claim attempt — caller uses this to pick the right Hebrew
 * reply and decide whether to continue normal message processing.
 *
 * @typedef {Object} ClaimResult
 * @property {boolean} ok
 * @property {string} [memberId]
 * @property {string} [familyId]
 * @property {string} [phone]            phone of the linked member (may be null)
 * @property {'unknown'|'expired'|'used'|'no-member'|'internal'} [errorKind]
 */

/**
 * Validate a code and bind it to a LID. On success, writes the `lidMappings`
 * row inside the same transaction that marks the code used, so a crash
 * between the two writes can't leave a code consumed without a mapping.
 *
 * Caller must already have verified the LID has no existing mapping; we
 * still run the claim atomically so concurrent attempts can't both win.
 *
 * @param {Object} args
 * @param {string} args.lid          full JID with the @lid suffix
 * @param {string} args.code         6-digit code the user typed
 * @returns {Promise<ClaimResult>}
 */
export async function claimAuthCode({ lid, code }) {
  if (!lid || !code) return { ok: false, errorKind: 'internal' };

  const codeRef = db.collection(CODES_COLLECTION).doc(code);
  const mappingRef = db.collection(MAPPINGS_COLLECTION).doc(lid);

  try {
    const claimed = await db.runTransaction(async (tx) => {
      const codeSnap = await tx.get(codeRef);
      if (!codeSnap.exists) {
        return { ok: false, errorKind: 'unknown' };
      }
      const codeData = codeSnap.data();
      if (codeData.usedAt) {
        return { ok: false, errorKind: 'used' };
      }
      const expiresAt = codeData.expiresAt;
      const expiresMs =
        expiresAt instanceof Timestamp
          ? expiresAt.toMillis()
          : typeof expiresAt?.toMillis === 'function'
            ? expiresAt.toMillis()
            : 0;
      if (!expiresMs || expiresMs < Date.now()) {
        return { ok: false, errorKind: 'expired' };
      }

      // Pull the linked member so the bot can echo the right family/phone
      // back to the caller (and so we cache the phone in the mapping doc).
      const memberRef = db.collection('familyMembers').doc(codeData.forMemberId);
      const memberSnap = await tx.get(memberRef);
      if (!memberSnap.exists) {
        return { ok: false, errorKind: 'no-member' };
      }
      const memberData = memberSnap.data() || {};
      // Sanity: code's familyId should match the member's familyId. If they
      // diverge it means the member was moved — refuse rather than bind to
      // a stale family.
      if (codeData.familyId && memberData.familyId && codeData.familyId !== memberData.familyId) {
        return { ok: false, errorKind: 'no-member' };
      }

      tx.update(codeRef, {
        usedAt: FieldValue.serverTimestamp(),
        usedByLid: lid,
        updatedAt: FieldValue.serverTimestamp(),
      });

      tx.set(
        mappingRef,
        {
          lid,
          memberId: codeData.forMemberId,
          familyId: codeData.familyId,
          phone: memberData.phone ?? null,
          linkedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return {
        ok: true,
        memberId: codeData.forMemberId,
        familyId: codeData.familyId,
        phone: memberData.phone ?? null,
      };
    });

    if (claimed.ok) {
      // Refresh in-process cache so the next message from this LID routes
      // through the new mapping without an extra Firestore read.
      await storeLidMapping({
        lid,
        memberId: claimed.memberId,
        familyId: claimed.familyId,
        phone: claimed.phone,
      }).catch(() => { /* mapping already set inside the txn — best effort cache refresh */ });
    }

    return claimed;
  } catch (err) {
    console.error('[auth-code] claim failed:', err.message);
    return { ok: false, errorKind: 'internal' };
  }
}
