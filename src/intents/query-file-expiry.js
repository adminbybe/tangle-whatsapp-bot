// Intent handler: query-file-expiry (read-only).
// Searches the family's `files` collection for documents whose description /
// originalName best match the user's keywords, and reports the expiry date of
// the top match. Used for vehicle tests, license / insurance / vaccination
// expirations — anything the family stored as a date-bound file.

import { db } from '../firebase-admin.js';
import { dayjs, FAMILY_TZ } from '../dates.js';
import { fileExpiryReply, fileExpiryNotFoundReply } from '../reply-templates.js';

// Common Hebrew stop-words to ignore in the search query so single meaningful
// keywords carry the full match score.
const STOP_WORDS = new Set([
  'של', 'את', 'על', 'אל', 'מן', 'עם', 'גם', 'אבל', 'או', 'אז',
  'מתי', 'מה', 'איפה', 'איך', 'למה', 'איזה', 'איזו', 'כמה', 'מי',
  'הוא', 'היא', 'הם', 'הן', 'אני', 'אתה', 'את', 'אנחנו',
  'בכלל', 'עוד', 'שלי', 'שלך', 'שלו', 'שלה', 'שלנו',
]);

// Hebrew synonym groups for common time-bound document categories. When the
// user mentions any token in a group, we expand the search to all members of
// that group so that — for example — "טסט" also matches files described as
// "רישיון רכב", and "ביטוח" matches "פוליסה".
const SYNONYM_GROUPS = [
  ['טסט', 'רישיון', 'רישוי'],
  ['ביטוח', 'פוליסה'],
  ['חיסון', 'חיסונים', 'זריקה', 'תרכיב'],
  ['דרכון', 'פספורט'],
  ['חוזה', 'הסכם'],
];

// Hebrew relational terms keyed by who they refer to from the speaker's
// perspective. We expand each term to the family member(s) that match the
// relationship at search time, so "אשתי"/"בעלי" finds the actual person.
const SPOUSE_TERMS = [
  'אשתי', 'בעלי', 'זוגתי', 'זוגי', 'בעל', 'אישה', 'אשתו', 'בעלה',
  'הבעל', 'האישה', 'האשה',
];
const CHILD_TERMS = [
  'בני', 'בתי', 'הבן', 'הבת', 'הילד', 'הילדה', 'בן', 'בת',
];
const PARENT_TERMS = ['אבא', 'אמא', 'אבי', 'אמי', 'הורה', 'ההורים', 'הורי'];

function tokenize(query) {
  return String(query)
    .split(/\s+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 2 && !STOP_WORDS.has(s));
}

function fileHaystack(f) {
  return [f.description, f.originalName, f.category]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function bestNameFor(f) {
  return f.description || f.originalName || 'המסמך';
}

// Returns all forms of a member's name (firstName + nickname) lowercased.
function memberNames(m) {
  return [m.firstName, m.nickname]
    .filter(Boolean)
    .map((s) => String(s).trim().toLowerCase())
    .filter((s) => s.length >= 2);
}

// Pull family members and build a name-alias map so that querying by
// firstName also matches nickname (e.g. user says "מזל" but the file is
// described under the legal name "אלם"), AND so that relational terms
// ("אשתי"/"בעלי"/"הבן"/"אמא") resolve to the right person from the
// speaker's perspective.
async function buildFamilyAliasMap(familyId, sender) {
  try {
    const snap = await db
      .collection('familyMembers')
      .where('familyId', '==', familyId)
      .get();
    const allMembers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const map = new Map();

    // 1) Standard firstName ↔ nickname aliases for every member.
    for (const m of allMembers) {
      const names = memberNames(m);
      if (names.length < 2) continue;
      for (const n of names) {
        const set = map.get(n) || new Set();
        for (const o of names) set.add(o);
        map.set(n, set);
      }
    }

    // 2) Relational terms that depend on the speaker's role.
    if (sender) {
      const senderRole = sender.role;
      const senderId = sender.memberId;
      const otherMembers = allMembers.filter((m) => m.id !== senderId);

      // Spouse: when speaker is a parent, "אשתי"/"בעלי"/etc map to the
      // OTHER parents in the family (most families have exactly one).
      if (senderRole === 'parent') {
        const spouseNames = otherMembers
          .filter((m) => m.role === 'parent')
          .flatMap(memberNames);
        if (spouseNames.length) {
          for (const term of SPOUSE_TERMS) {
            const set = map.get(term) || new Set();
            for (const n of spouseNames) set.add(n);
            map.set(term, set);
          }
        }
      }

      // Child: any speaker can ask about "הבן/הבת/הילד/הילדה".
      const childNames = otherMembers
        .filter((m) => m.role === 'child')
        .flatMap(memberNames);
      if (childNames.length) {
        for (const term of CHILD_TERMS) {
          const set = map.get(term) || new Set();
          for (const n of childNames) set.add(n);
          map.set(term, set);
        }
      }

      // Parent: when speaker is a child, "אבא"/"אמא"/etc map to parents.
      if (senderRole === 'child') {
        const parentNames = otherMembers
          .filter((m) => m.role === 'parent')
          .flatMap(memberNames);
        if (parentNames.length) {
          for (const term of PARENT_TERMS) {
            const set = map.get(term) || new Set();
            for (const n of parentNames) set.add(n);
            map.set(term, set);
          }
        }
      }
    }

    return map;
  } catch (err) {
    console.error('[query-file-expiry] alias map failed:', err.message);
    return new Map();
  }
}

// Strip the Hebrew definite-article ה when it's a prefix on a 4+ letter
// token. Lets "הטסט"/"הרישיון" match the same haystack as "טסט"/"רישיון".
// Conservative — only strips ה (the most common prefix) and only when it
// leaves a meaningful word behind.
function stripHebrewPrefix(token) {
  if (token.length >= 4 && token.startsWith('ה')) return token.slice(1);
  return token;
}

function expandTokens(tokens, aliasMap) {
  const expanded = new Set();
  for (const raw of tokens) {
    const variants = new Set([raw]);
    const stripped = stripHebrewPrefix(raw);
    if (stripped !== raw) variants.add(stripped);
    for (const t of variants) {
      expanded.add(t);
      const aliases = aliasMap.get(t);
      if (aliases) for (const a of aliases) expanded.add(a);
      for (const group of SYNONYM_GROUPS) {
        if (group.includes(t)) for (const s of group) expanded.add(s);
      }
    }
  }
  return Array.from(expanded);
}

export async function queryFileExpiry({ sender, payload }) {
  const query = (payload?.searchQuery || '').trim();
  if (!query) {
    return { replyText: fileExpiryNotFoundReply(null) };
  }

  const [snap, aliasMap] = await Promise.all([
    db.collection('files').where('familyId', '==', sender.familyId).get(),
    buildFamilyAliasMap(sender.familyId, sender),
  ]);

  const baseTokens = tokenize(query);
  // If the user gave only stop-words, fall back to literal substring match.
  const seedTokens = baseTokens.length > 0 ? baseTokens : [query.toLowerCase()];
  const fallbackTokens = expandTokens(seedTokens, aliasMap);

  const filesWithExpiry = [];
  const candidates = [];
  for (const docSnap of snap.docs) {
    const f = docSnap.data();
    if (!f.expiresAt) continue;
    if (f.archivedAt) continue;
    filesWithExpiry.push(f);
    const haystack = fileHaystack(f);
    let score = 0;
    for (const t of fallbackTokens) {
      if (haystack.includes(t)) score++;
    }
    if (score > 0) candidates.push({ score, file: f });
  }

  console.log('[query-file-expiry]', JSON.stringify({
    query,
    baseTokens,
    expanded: fallbackTokens,
    aliasMapSize: aliasMap.size,
    filesScanned: snap.size,
    filesWithExpiry: filesWithExpiry.length,
    candidates: candidates.length,
  }));

  if (candidates.length === 0) {
    const knownNames = filesWithExpiry
      .sort((a, b) => {
        const ax = a.expiresAt?.toMillis ? a.expiresAt.toMillis() : 0;
        const bx = b.expiresAt?.toMillis ? b.expiresAt.toMillis() : 0;
        return ax - bx;
      })
      .map((f) => bestNameFor(f));
    return { replyText: fileExpiryNotFoundReply(query, knownNames) };
  }

  // Higher score wins; ties broken by earliest upcoming expiry.
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ax = a.file.expiresAt?.toMillis ? a.file.expiresAt.toMillis() : 0;
    const bx = b.file.expiresAt?.toMillis ? b.file.expiresAt.toMillis() : 0;
    return ax - bx;
  });

  const best = candidates[0].file;
  const ts = best.expiresAt.toDate ? best.expiresAt.toDate() : best.expiresAt;
  const exp = dayjs(ts).tz(FAMILY_TZ);
  const now = dayjs().tz(FAMILY_TZ);
  const daysUntil = Math.floor(exp.diff(now, 'day', true));
  const dateText = exp.locale('he').format('dddd D בMMMM YYYY');

  return {
    replyText: fileExpiryReply({
      name: bestNameFor(best),
      dateText,
      daysUntil,
    }),
  };
}
