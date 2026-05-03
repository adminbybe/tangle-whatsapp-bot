// Intent handler: query-schedule (read-only).
// Returns a Hebrew bullet list of events in the requested window.
// Optionally filters to events tagged with a specific family member when
// the user says "רק לי" / "של מזל" / "של אשתי".

import { db, Timestamp } from '../firebase-admin.js';
import { dayjs, FAMILY_TZ, nowInTz, parseIsoToTz } from '../dates.js';
import { scheduleReply } from '../reply-templates.js';

// Hebrew relational tokens used by the bot to figure out who "אשתי" /
// "הבן" / etc map to. Mirrors the same set as query-file-expiry's
// alias logic so phrasing stays consistent across the bot.
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
const SELF_TERMS = new Set(['self', 'לי', 'אני', 'עצמי']);

const KNOWN_WINDOWS = new Set([
  'today',
  'tomorrow',
  'this-week',
  'next-week',
  'this-month',
  'next-month',
]);

function rangeFor(window) {
  const now = nowInTz();
  if (window === 'tomorrow') {
    const start = now.add(1, 'day').startOf('day');
    const end = start.add(1, 'day');
    return { start, end };
  }
  if (window === 'this-week') {
    // Israeli week: Sun..Sat (Sat = dow 6 = last day). When today already IS
    // Saturday the user almost certainly means "the upcoming week" rather than
    // "just the rest of today" — extend to end of next Saturday in that case.
    const dow = now.day(); // 0=Sun ... 6=Sat
    if (dow === 6) {
      const end = now.add(7, 'day').endOf('day').add(1, 'millisecond');
      return { start: now, end };
    }
    const start = now;
    const daysUntilSat = 6 - dow;
    const end = now.add(daysUntilSat, 'day').endOf('day').add(1, 'millisecond');
    return { start, end };
  }
  if (window === 'next-week') {
    // From start of the upcoming Sunday through end of the following Saturday.
    const dow = now.day(); // 0=Sun ... 6=Sat
    const daysUntilNextSunday = ((7 - dow) % 7) || 7;
    const start = now.add(daysUntilNextSunday, 'day').startOf('day');
    const end = start.add(7, 'day');
    return { start, end };
  }
  if (window === 'this-month') {
    // From now through end of the current calendar month (inclusive).
    const start = now;
    const end = now.endOf('month').add(1, 'millisecond');
    return { start, end };
  }
  if (window === 'next-month') {
    // The full following calendar month.
    const start = now.add(1, 'month').startOf('month');
    const end = start.endOf('month').add(1, 'millisecond');
    return { start, end };
  }
  // default 'today'
  const start = now.startOf('day');
  const end = start.add(1, 'day');
  return { start, end };
}

/**
 * Resolve the user's `forMember` filter (e.g. "self", "מזל", "אשתי") into
 * a concrete familyMember doc id, using the speaker's perspective for
 * relational terms.
 *
 * Returns:
 *   { kind: 'self' | 'member', memberId }   — filter to this member,
 *   { kind: 'unknown', input }               — name didn't match anyone,
 *   null                                     — no filter requested.
 */
async function resolveForMember(sender, rawInput) {
  if (!rawInput) return null;
  const input = String(rawInput).trim().toLowerCase();
  if (!input) return null;

  if (SELF_TERMS.has(input)) {
    return sender?.memberId
      ? { kind: 'self', memberId: sender.memberId }
      : null;
  }

  // Pull all family members once. Tiny dataset; no need to cache.
  let allMembers = [];
  try {
    const snap = await db
      .collection('familyMembers')
      .where('familyId', '==', sender.familyId)
      .get();
    allMembers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error('[query-schedule] family members fetch failed:', err.message);
    return { kind: 'unknown', input };
  }

  // Direct name match (firstName or nickname, case-insensitive).
  for (const m of allMembers) {
    const names = [m.firstName, m.nickname]
      .filter(Boolean)
      .map((s) => String(s).trim().toLowerCase());
    if (names.includes(input)) {
      return { kind: 'member', memberId: m.id };
    }
  }

  // Relational term resolution from the speaker's perspective.
  const others = allMembers.filter((m) => m.id !== sender?.memberId);
  if (SPOUSE_TERMS.has(input) && sender?.role === 'parent') {
    const otherParent = others.find((m) => m.role === 'parent');
    if (otherParent) return { kind: 'member', memberId: otherParent.id };
  }
  if (CHILD_TERMS.has(input)) {
    const child = others.find((m) => m.role === 'child');
    if (child) return { kind: 'member', memberId: child.id };
  }
  if (PARENT_TERMS.has(input) && sender?.role === 'child') {
    const parent = others.find((m) => m.role === 'parent');
    if (parent) return { kind: 'member', memberId: parent.id };
  }

  return { kind: 'unknown', input };
}

/**
 * @param {object} args
 * @param {{familyId: string, memberId?: string, role?: string}} args.sender
 * @param {object} args.payload   { window, forMember? }
 * @returns {Promise<{replyText: string}>}
 */
export async function querySchedule({ sender, payload }) {
  const window = payload?.window && KNOWN_WINDOWS.has(payload.window)
    ? payload.window
    : 'today';
  const { start, end } = rangeFor(window);

  const filter = await resolveForMember(sender, payload?.forMember);
  const filterMemberId = filter?.kind === 'self' || filter?.kind === 'member'
    ? filter.memberId
    : null;

  const snap = await db
    .collection('events')
    .where('familyId', '==', sender.familyId)
    .where('startTime', '>=', Timestamp.fromDate(start.toDate()))
    .where('startTime', '<', Timestamp.fromDate(end.toDate()))
    .orderBy('startTime', 'asc')
    .get();

  const lines = [];
  for (const docSnap of snap.docs) {
    const e = docSnap.data();
    if (e.archivedAt) continue;
    if (filterMemberId) {
      const attendees = Array.isArray(e.attendeeMemberIds) ? e.attendeeMemberIds : [];
      if (!attendees.includes(filterMemberId)) continue;
    }
    const startTs = e.startTime?.toDate ? e.startTime.toDate() : null;
    if (!startTs) continue;
    const local = dayjs(startTs).tz(FAMILY_TZ);
    let prefix;
    if (window === 'this-month' || window === 'next-month') {
      // Multi-day list spanning a month: include date so different occurrences
      // of the same weekday don't blur together.
      prefix = local.locale('he').format('dddd D/M HH:mm');
    } else if (window === 'this-week' || window === 'next-week') {
      // Multi-day list within a week: day name + time is enough.
      prefix = local.locale('he').format('dddd HH:mm');
    } else {
      prefix = local.format('HH:mm');
    }
    lines.push(`${prefix} ${e.title}`);
  }

  // If the user asked for a specific person but we couldn't resolve who,
  // tell them rather than silently returning "no events".
  if (filter?.kind === 'unknown') {
    return {
      replyText: `לא הצלחתי לזהות את "${filter.input}" בבני המשפחה. נסה/י שם אחר או נסח/י אחרת.`,
    };
  }

  return { replyText: scheduleReply(window, lines) };
}
