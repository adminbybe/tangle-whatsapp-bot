// Phone number normalization for the Tangle bot.
// Mirrors `app/src/lib/family-member-actions.ts` normalizePhone exactly so the
// bot's lookups always match the strings the frontend writes to Firestore.

/**
 * Normalize a raw phone number to Israeli E.164. Strips spaces/dashes/parens.
 * Replaces a leading 0 with +972. Returns null for empty or whitespace-only.
 *
 * Pure and deterministic.
 *
 * @param {string | null | undefined} raw
 * @returns {string | null}
 */
export function normalizePhone(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[\s\-()]/g, '');
  if (!cleaned) return null;
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('0')) return '+972' + cleaned.substring(1);
  // Catch the case where the number starts with the country code without +.
  if (cleaned.startsWith('972')) return '+' + cleaned;
  return cleaned;
}

/**
 * Extract an E.164 phone number from a Baileys JID.
 * Baileys 1:1 JIDs look like `972541234567@s.whatsapp.net`.
 * Group JIDs end with `@g.us` — we return null so the caller can skip them.
 *
 * @param {string | null | undefined} jid
 * @returns {string | null}
 */
export function extractE164FromJid(jid) {
  if (!jid || typeof jid !== 'string') return null;
  if (jid.endsWith('@g.us')) return null;
  if (!jid.includes('@s.whatsapp.net')) return null;
  const digits = jid.split('@')[0]?.replace(/\D/g, '') || '';
  if (!digits) return null;
  return '+' + digits;
}
