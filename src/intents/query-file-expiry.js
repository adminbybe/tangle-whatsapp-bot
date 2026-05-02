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

export async function queryFileExpiry({ sender, payload }) {
  const query = (payload?.searchQuery || '').trim();
  if (!query) {
    return { replyText: fileExpiryNotFoundReply(null) };
  }

  const snap = await db
    .collection('files')
    .where('familyId', '==', sender.familyId)
    .get();

  const tokens = tokenize(query);
  // If the user gave only stop-words, fall back to literal substring match.
  const fallbackTokens = tokens.length > 0 ? tokens : [query.toLowerCase()];

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
