// Intent handler: query-schedule (read-only).
// Returns a Hebrew bullet list of events in [today | tomorrow | this-week].

import { db, Timestamp } from '../firebase-admin.js';
import { dayjs, FAMILY_TZ, nowInTz, parseIsoToTz } from '../dates.js';
import { scheduleReply } from '../reply-templates.js';

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
 * @param {object} args
 * @param {{familyId: string}} args.sender
 * @param {object} args.payload   { window: 'today'|'tomorrow'|'this-week' }
 * @returns {Promise<{replyText: string}>}
 */
export async function querySchedule({ sender, payload }) {
  const window = payload?.window && KNOWN_WINDOWS.has(payload.window)
    ? payload.window
    : 'today';
  const { start, end } = rangeFor(window);

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

  return { replyText: scheduleReply(window, lines) };
}
