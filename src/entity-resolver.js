// Resolve a Hebrew name / nickname / relational term to either a family
// member or a pet, scoped to a single family. Used by add-event,
// query-schedule, and query-file-expiry so all three intents share one
// definition of "who/what does this name refer to".
//
// The resolver normalizes inputs (strips common Hebrew prepositions like
// ל/ב/מ/ה/ש), then tries — in order:
//   1. SELF terms ("self" / "לי" / "אני" / "עצמי")          → speaker
//   2. exact name match against familyMembers (firstName + nickname)
//   3. exact name match against pets (name)
//   4. relational terms (אשתי/בעלי/הבן/הבת/אבא/אמא) given speaker role
//
// Match attempts are case-insensitive. If both a member and a pet match
// the same input we surface that ambiguity to the caller rather than
// guessing.

import { db } from './firebase-admin.js';

const SPOUSE_TERMS = new Set([
  'אשתי', 'בעלי', 'זוגתי', 'זוגי', 'בעל', 'אישה', 'אשתו', 'בעלה',
  'הבעל', 'האישה', 'האשה',
]);
const CHILD_TERMS = new Set([
  'בני', 'בתי', 'הבן', 'הבת', 'הילד', 'הילדה', 'בן', 'בת',
]);
const PARENT_TERMS = new Set([
  'אבא', 'אמא', 'אבי', 'אמי', 'הורה', 'ההורים', 'הורי',
]);
const SELF_TERMS = new Set(['self', 'לי', 'אני', 'עצמי', 'שלי']);

// Strip a single Hebrew prefix letter when removing it leaves a
// meaningful word (≥3 letters). Handles inputs like "לברי" → "ברי",
// "במזל" → "מזל", "הילד" stays as "הילד" because relational terms
// keep their leading ה.
const STRIPPABLE_PREFIXES = ['ל', 'ב', 'מ', 'ש', 'כ'];

function normalize(input) {
  if (!input) return '';
  return String(input).trim().toLowerCase();
}

function variantsOf(token) {
  const variants = new Set([token]);
  if (token.length >= 4 && STRIPPABLE_PREFIXES.includes(token[0])) {
    variants.add(token.slice(1));
  }
  return Array.from(variants);
}

function memberMatchesName(member, target) {
  const candidates = [member.firstName, member.nickname]
    .filter(Boolean)
    .map((s) => normalize(s));
  return candidates.includes(target);
}

function petMatchesName(pet, target) {
  const candidates = [pet.name].filter(Boolean).map((s) => normalize(s));
  return candidates.includes(target);
}

/**
 * @typedef {Object} ResolvedEntity
 * @property {'member'|'pet'} kind
 * @property {string} id
 * @property {string} displayName
 * @property {object} raw   underlying Firestore data (for callers that need more)
 */

/**
 * @typedef {Object} EntityResolution
 * @property {'self'|'member'|'pet'|'ambiguous'|'unknown'} kind
 * @property {string} [id]                 set when kind is self/member/pet
 * @property {string} [displayName]
 * @property {object} [raw]
 * @property {ResolvedEntity[]} [candidates]   set when kind is 'ambiguous'
 * @property {string} [input]              set when kind is 'unknown'
 */

/**
 * Load every familyMember + pet in one round-trip. Cached briefly so
 * back-to-back resolutions in the same handler don't double-fetch.
 */
const familyCache = new Map(); // familyId -> { members, pets, expiresAt }
const FAMILY_CACHE_TTL_MS = 60 * 1000;

async function loadFamily(familyId) {
  const cached = familyCache.get(familyId);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const [memberSnap, petSnap] = await Promise.all([
    db.collection('familyMembers').where('familyId', '==', familyId).get(),
    db.collection('pets').where('familyId', '==', familyId).get(),
  ]);
  const members = memberSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const pets = petSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const value = { members, pets, expiresAt: Date.now() + FAMILY_CACHE_TTL_MS };
  familyCache.set(familyId, value);
  return value;
}

/**
 * Resolve a single name/term to a member, pet, the speaker themselves,
 * or report ambiguity / unknown.
 *
 * @param {Object} args
 * @param {string} args.familyId
 * @param {{memberId?: string, role?: string}|null} args.sender
 * @param {string} args.name
 * @returns {Promise<EntityResolution>}
 */
export async function resolveEntity({ familyId, sender, name }) {
  const raw = normalize(name);
  if (!raw) return { kind: 'unknown', input: '' };
  if (SELF_TERMS.has(raw)) {
    return sender?.memberId
      ? { kind: 'self', id: sender.memberId }
      : { kind: 'unknown', input: raw };
  }

  const { members, pets } = await loadFamily(familyId).catch(() => ({
    members: [],
    pets: [],
  }));

  // Try the input as-is, then with one Hebrew prefix stripped.
  const tries = variantsOf(raw);

  // Direct name matches.
  let memberHit = null;
  let petHit = null;
  for (const t of tries) {
    if (!memberHit) memberHit = members.find((m) => memberMatchesName(m, t)) || null;
    if (!petHit) petHit = pets.find((p) => petMatchesName(p, t)) || null;
    if (memberHit || petHit) break;
  }

  if (memberHit && petHit) {
    return {
      kind: 'ambiguous',
      candidates: [
        { kind: 'member', id: memberHit.id, displayName: memberHit.firstName, raw: memberHit },
        { kind: 'pet', id: petHit.id, displayName: petHit.name, raw: petHit },
      ],
    };
  }
  if (memberHit) {
    return { kind: 'member', id: memberHit.id, displayName: memberHit.firstName, raw: memberHit };
  }
  if (petHit) {
    return { kind: 'pet', id: petHit.id, displayName: petHit.name, raw: petHit };
  }

  // Relational fallbacks (only applicable when input matched nothing direct).
  const others = members.filter((m) => m.id !== sender?.memberId);
  for (const t of tries) {
    if (SPOUSE_TERMS.has(t) && sender?.role === 'parent') {
      const otherParent = others.find((m) => m.role === 'parent');
      if (otherParent) {
        return {
          kind: 'member',
          id: otherParent.id,
          displayName: otherParent.firstName,
          raw: otherParent,
        };
      }
    }
    if (CHILD_TERMS.has(t)) {
      const child = others.find((m) => m.role === 'child');
      if (child) {
        return { kind: 'member', id: child.id, displayName: child.firstName, raw: child };
      }
    }
    if (PARENT_TERMS.has(t) && sender?.role === 'child') {
      const parent = others.find((m) => m.role === 'parent');
      if (parent) {
        return { kind: 'member', id: parent.id, displayName: parent.firstName, raw: parent };
      }
    }
  }

  return { kind: 'unknown', input: raw };
}

/**
 * Same as resolveEntity but accepts a list of names and returns parallel
 * results. Convenience for the add-event handler when payload.attendees
 * has multiple names.
 */
export async function resolveEntities({ familyId, sender, names }) {
  if (!Array.isArray(names) || names.length === 0) return [];
  return Promise.all(
    names.map((n) => resolveEntity({ familyId, sender, name: n }))
  );
}

/**
 * Drop the cached family roster so a follow-up resolveEntity call hits
 * Firestore again. Used after we mutate familyMembers or pets.
 */
export function invalidateFamilyCache(familyId) {
  if (familyId) familyCache.delete(familyId);
}
