// Intent handler: query-schedule (read-only).
// Returns a Hebrew bullet list of events in the requested window.
// Optional `forMember` filter narrows results to a specific person OR pet.
// When the filter is a pet, vaccinations and vet visits in the same window
// are merged in too — that's what the user expects from "מה יש לברי?".

import { db, Timestamp } from '../firebase-admin.js';
import { dayjs, FAMILY_TZ, nowInTz, parseIsoToTz } from '../dates.js';
import { scheduleReply } from '../reply-templates.js';
import { resolveEntity } from '../entity-resolver.js';

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
    const dow = now.day();
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
    const dow = now.day();
    const daysUntilNextSunday = ((7 - dow) % 7) || 7;
    const start = now.add(daysUntilNextSunday, 'day').startOf('day');
    const end = start.add(7, 'day');
    return { start, end };
  }
  if (window === 'this-month') {
    const start = now;
    const end = now.endOf('month').add(1, 'millisecond');
    return { start, end };
  }
  if (window === 'next-month') {
    const start = now.add(1, 'month').startOf('month');
    const end = start.endOf('month').add(1, 'millisecond');
    return { start, end };
  }
  const start = now.startOf('day');
  const end = start.add(1, 'day');
  return { start, end };
}

function formatPrefix(local, window) {
  if (window === 'this-month' || window === 'next-month') {
    return local.locale('he').format('dddd D/M HH:mm');
  }
  if (window === 'this-week' || window === 'next-week') {
    return local.locale('he').format('dddd HH:mm');
  }
  return local.format('HH:mm');
}

/**
 * Pull every events doc in [start,end). Filtering by attendee/pet is done
 * in-memory because Firestore's array-contains can't combine with the
 * range query on startTime in a single index.
 */
async function fetchEvents({ familyId, start, end }) {
  const snap = await db
    .collection('events')
    .where('familyId', '==', familyId)
    .where('startTime', '>=', Timestamp.fromDate(start.toDate()))
    .where('startTime', '<', Timestamp.fromDate(end.toDate()))
    .orderBy('startTime', 'asc')
    .get();
  return snap.docs.map((d) => d.data()).filter((e) => !e.archivedAt);
}

async function fetchVaccinationsForPet({ familyId, petId, start, end }) {
  try {
    const snap = await db
      .collection('vaccinations')
      .where('familyId', '==', familyId)
      .where('petId', '==', petId)
      .get();
    const startMs = start.valueOf();
    const endMs = end.valueOf();
    return snap.docs
      .map((d) => d.data())
      .filter((v) => !v.archivedAt && v.nextDueAt?.toMillis)
      .filter((v) => {
        const ms = v.nextDueAt.toMillis();
        return ms >= startMs && ms < endMs;
      });
  } catch (err) {
    console.warn('[query-schedule] vaccinations fetch failed:', err.message);
    return [];
  }
}

async function fetchVetVisitsForPet({ familyId, petId, start, end }) {
  try {
    const snap = await db
      .collection('vetVisits')
      .where('familyId', '==', familyId)
      .where('petId', '==', petId)
      .get();
    const startMs = start.valueOf();
    const endMs = end.valueOf();
    return snap.docs
      .map((d) => d.data())
      .filter((v) => !v.archivedAt && v.visitedAt?.toMillis)
      .filter((v) => {
        const ms = v.visitedAt.toMillis();
        return ms >= startMs && ms < endMs;
      });
  } catch (err) {
    console.warn('[query-schedule] vet visits fetch failed:', err.message);
    return [];
  }
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

  // Resolve the optional forMember filter into a member or a pet.
  let resolved = null;
  if (payload?.forMember) {
    resolved = await resolveEntity({
      familyId: sender.familyId,
      sender,
      name: payload.forMember,
    });
    if (resolved.kind === 'unknown') {
      return {
        replyText: `לא הצלחתי לזהות את "${resolved.input}" בבני המשפחה או בחיות. נסה/י שם אחר.`,
      };
    }
    if (resolved.kind === 'ambiguous') {
      const labels = (resolved.candidates || [])
        .map((c) => `${c.kind === 'pet' ? 'חיית מחמד' : 'בן/ת משפחה'} בשם ${c.displayName}`)
        .join(' או ');
      return {
        replyText: `התכוונת ל${labels}? נסה/י לציין בבירור.`,
      };
    }
  }

  const allEvents = await fetchEvents({ familyId: sender.familyId, start, end });

  // ── Pet path ────────────────────────────────────────────────────────────
  if (resolved && resolved.kind === 'pet') {
    const petId = resolved.id;
    const eventsForPet = allEvents.filter(
      (e) => Array.isArray(e.petIds) && e.petIds.includes(petId)
    );

    const [vaccs, visits] = await Promise.all([
      fetchVaccinationsForPet({ familyId: sender.familyId, petId, start, end }),
      fetchVetVisitsForPet({ familyId: sender.familyId, petId, start, end }),
    ]);

    // Build a unified, time-sorted line list.
    const items = [];
    for (const e of eventsForPet) {
      const ts = e.startTime?.toDate?.();
      if (!ts) continue;
      items.push({ at: ts, label: e.title || 'אירוע' });
    }
    for (const v of vaccs) {
      const ts = v.nextDueAt?.toDate?.();
      if (!ts) continue;
      items.push({ at: ts, label: `חיסון: ${v.type || ''}`.trim() });
    }
    for (const v of visits) {
      const ts = v.visitedAt?.toDate?.();
      if (!ts) continue;
      items.push({ at: ts, label: `וטרינר: ${v.reason || ''}`.trim() });
    }
    items.sort((a, b) => a.at.getTime() - b.at.getTime());

    const lines = items.map((it) => {
      const local = dayjs(it.at).tz(FAMILY_TZ);
      return `${formatPrefix(local, window)} ${it.label}`;
    });
    return { replyText: scheduleReply(window, lines) };
  }

  // ── Member-filter / unfiltered path ─────────────────────────────────────
  const filterMemberId =
    resolved && (resolved.kind === 'self' || resolved.kind === 'member')
      ? resolved.id
      : null;
  const strict = payload?.strict === true;

  const lines = [];
  for (const e of allEvents) {
    if (filterMemberId) {
      const attendees = Array.isArray(e.attendeeMemberIds) ? e.attendeeMemberIds : [];
      if (strict) {
        // "רק לי" / "רק <name>" — only events where target is the SOLE attendee.
        if (attendees.length !== 1 || attendees[0] !== filterMemberId) continue;
      } else {
        // Default "מה יש לי" / "מה יש למזל" — include events where target
        // appears in attendees, plus untagged events (visible to the whole
        // family). Exclude events tagged exclusively to other people.
        const targetTagged = attendees.includes(filterMemberId);
        const untagged = attendees.length === 0;
        if (!targetTagged && !untagged) continue;
      }
    }
    const startTs = e.startTime?.toDate?.();
    if (!startTs) continue;
    const local = dayjs(startTs).tz(FAMILY_TZ);
    lines.push(`${formatPrefix(local, window)} ${e.title}`);
  }

  return { replyText: scheduleReply(window, lines) };
}
