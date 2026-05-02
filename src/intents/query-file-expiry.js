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

// Pull family members and build a name-alias map so that querying by
// firstName also matches nickname and vice versa (e.g. user says "מזל"
// but the file is described under the legal name "אלם").
async function buildFamilyAliasMap(familyId) {
  try {
    const snap = await db
      .collection('familyMembers')
      .where('familyId', '==', familyId)
      .get();
    const map = new Map();
    for (const doc of snap.docs) {
      const m = doc.data();
      const names = [m.firstName, m.nickname]
        .filter(Boolean)
        .map((s) => String(s).trim().toLowerCase())
        .filter((s) => s.length >= 2);
      if (names.length < 2) continue;
      for (const n of names) {
        const existing = map.get(n) || new Set();
        for (const other of names) existing.add(other);
        map.set(n, existing);
      }
    }
    return map;
  } catch (err) {
    console.error('[query-file-expiry] alias map failed:', err.message);
    return new Map();
  }
}

function expandTokens(tokens, aliasMap) {
  const expanded = new Set();
  for (const t of tokens) {
    expanded.add(t);
    const aliases = aliasMap.get(t);
    if (aliases) for (const a of aliases) expanded.add(a);
    for (const group of SYNONYM_GROUPS) {
      if (group.includes(t)) for (const s of group) expanded.add(s);
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
    buildFamilyAliasMap(sender.familyId),
  ]);

  const baseTokens = tokenize(query);
  // If the user gave only stop-words, fall back to literal substring match.
  const seedTokens = baseTokens.length > 0 ? baseTokens : [query.toLowerCase()];
  const fallbackTokens = expandTokens(seedTokens, aliasMap);

  const candidates = [];
  for (const docSnap of snap.docs) {
    const f = docSnap.data();
    if (!f.expiresAt) continue;
    if (f.archivedAt) continue;
    const haystack = fileHaystack(f);
    let score = 0;
    for (const t of fallbackTokens) {
      if (haystack.includes(t)) score++;
    }
    if (score > 0) candidates.push({ score, file: f });
  }

  if (candidates.length === 0) {
    return { replyText: fileExpiryNotFoundReply(query) };
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
