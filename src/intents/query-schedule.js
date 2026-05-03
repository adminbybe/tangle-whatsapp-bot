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

  // Normalize forMembers — accept both the new array form and the legacy
  // singular `forMember` string, so an in-flight Gemini caching weirdness
  // doesn't break the bot.
  const rawTargets = (() => {
    if (Array.isArray(payload?.forMembers)) return payload.forMembers;
    if (payload?.forMember) return [payload.forMember];
    return [];
  })();

  const resolutions = [];
  for (const name of rawTargets) {
    const r = await resolveEntity({ familyId: sender.familyId, sender, name });
    if (r.kind === 'unknown') {
      return {
        replyText: `לא הצלחתי לזהות את "${r.input}" בבני המשפחה או בחיות. נסה/י שם אחר.`,
      };
    }
    if (r.kind === 'ambiguous') {
      const labels = (r.candidates || [])
        .map((c) => `${c.kind === 'pet' ? 'חיית מחמד' : 'בן/ת משפחה'} בשם ${c.displayName}`)
        .join(' או ');
      return { replyText: `התכוונת ל${labels}? נסה/י לציין בבירור.` };
    }
    resolutions.push(r);
  }

  const allEvents = await fetchEvents({ familyId: sender.familyId, start, end });

  // Partition resolved targets into member ids and pet ids.
  const memberIds = new Set();
  const petIds = new Set();
  for (const r of resolutions) {
    if (r.kind === 'self' || r.kind === 'member') memberIds.add(r.id);
    else if (r.kind === 'pet') petIds.add(r.id);
  }
  const strict = payload?.strict === true;

  // ── Pet-only path: when the user asked exclusively about pet(s),
  //    augment with vaccinations + vet visits inside the window.
  const petOnly = memberIds.size === 0 && petIds.size > 0;
  let petExtras = [];
  if (petOnly) {
    const fetched = await Promise.all(
      [...petIds].map(async (pid) => {
        const [vaccs, visits] = await Promise.all([
          fetchVaccinationsForPet({ familyId: sender.familyId, petId: pid, start, end }),
          fetchVetVisitsForPet({ familyId: sender.familyId, petId: pid, start, end }),
        ]);
        return { vaccs, visits };
      })
    );
    petExtras = fetched.flatMap(({ vaccs, visits }) => {
      const xs = [];
      for (const v of vaccs) {
        const ts = v.nextDueAt?.toDate?.();
        if (ts) xs.push({ at: ts, label: `חיסון: ${v.type || ''}`.trim() });
      }
      for (const v of visits) {
        const ts = v.visitedAt?.toDate?.();
        if (ts) xs.push({ at: ts, label: `וטרינר: ${v.reason || ''}`.trim() });
      }
      return xs;
    });
  }

  // Decide which events to include.
  function eventMatches(e) {
    // No filter at all → include everything (legacy behaviour).
    if (memberIds.size === 0 && petIds.size === 0) return true;

    const attendees = Array.isArray(e.attendeeMemberIds) ? e.attendeeMemberIds : [];
    const eventPetIds = Array.isArray(e.petIds) ? e.petIds : [];

    // Pet hit: the event tags any pet target.
    const petHit = [...petIds].some((pid) => eventPetIds.includes(pid));

    if (strict) {
      // Sole-attendee semantics applied per individual member target —
      // mostly used with one target ("רק לי"); for multi-target we still
      // require the attendee set to be exactly one of the requested members.
      const memberHit =
        attendees.length === 1 && memberIds.has(attendees[0]);
      return memberHit || petHit;
    }

    // Soft semantics: any target in attendees, OR untagged event (when at
    // least one member target is in scope — "shared family events"
    // shouldn't piggy-back on a pet-only query).
    const memberHit = [...memberIds].some((mid) => attendees.includes(mid));
    const untaggedAndMemberInScope =
      memberIds.size > 0 && attendees.length === 0 && eventPetIds.length === 0;
    return memberHit || petHit || untaggedAndMemberInScope;
  }

  const items = [];
  for (const e of allEvents) {
    if (!eventMatches(e)) continue;
    const ts = e.startTime?.toDate?.();
    if (!ts) continue;
    items.push({ at: ts, label: e.title || 'אירוע' });
  }
  for (const x of petExtras) items.push(x);
  items.sort((a, b) => a.at.getTime() - b.at.getTime());

  const lines = items.map((it) => {
    const local = dayjs(it.at).tz(FAMILY_TZ);
    return `${formatPrefix(local, window)} ${it.label}`;
  });

  return { replyText: scheduleReply(window, lines) };
}
