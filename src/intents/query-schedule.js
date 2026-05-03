// Intent handler: query-schedule (read-only).
// Returns a Hebrew bullet list of events in the requested window.
// Optional `forMembers` filter narrows results to specific people / pets.
// Pet care (vaccinations, vet visits) is merged into any human-targeted
// or unfiltered query so a parent never misses a pet's appointment just
// because it lives in a separate Firestore collection.

import { db, Timestamp } from '../firebase-admin.js';
import { dayjs, FAMILY_TZ, nowInTz } from '../dates.js';
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

// ── Icons ─────────────────────────────────────────────────────────────────
// Per-attendee icon at the start of each schedule line gives the user a
// glance-able read of who an item belongs to. We prefer an explicit
// gender / iconKey set on the member; otherwise fall back to a role-based
// generic icon. Pets resolve by species.
function iconForMember(member) {
  if (!member) return '👤';
  const g = String(member.gender || member.iconKey || '').toLowerCase();
  if (g === 'male' || g === 'man' || g === 'm') return '👨';
  if (g === 'female' || g === 'woman' || g === 'f' || g === 'w') return '👩';
  if (g === 'boy') return '👦';
  if (g === 'girl') return '👧';
  if (member.role === 'child') return '🧒';
  return '👤';
}

function iconForPet(pet) {
  if (!pet) return '🐾';
  const s = String(pet.species || '').toLowerCase();
  if (s === 'cat') return '🐈';
  if (s === 'dog') return '🐕';
  return '🐾';
}

// Compose the icon prefix from each tagged attendee — one icon per person
// per pet, in attendee order. So an event with Jordan+Mazal renders 👨👩,
// a vet visit on the dog renders 🐕, an untagged "family-wide" event
// renders the concatenation of every family member + every pet (👨👩🐕).
// Capped at 6 icons so an event with a huge guest list doesn't overflow
// a phone-sized screen.
function iconForEvent(event, membersById, petsById, allMembers, allPets) {
  const attendees = Array.isArray(event.attendeeMemberIds) ? event.attendeeMemberIds : [];
  const eventPets = Array.isArray(event.petIds) ? event.petIds : [];

  if (attendees.length === 0 && eventPets.length === 0) {
    // Truly untagged → represent the human family. Pets are deliberately
    // excluded here: a "family dinner" or a household errand is for the
    // people, and crowding the icon with the dog adds noise.
    const composite = allMembers.map((m) => iconForMember(m)).slice(0, 6).join('');
    return composite || '🏠';
  }

  const icons = [];
  for (const id of attendees) icons.push(iconForMember(membersById.get(id)));
  for (const id of eventPets) icons.push(iconForPet(petsById.get(id)));
  const composite = icons.slice(0, 6).join('');
  return composite || '🏠';
}

// ── Firestore fetchers ────────────────────────────────────────────────────
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

async function fetchVaccinationsInWindow({ familyId, start, end, petIdsFilter }) {
  try {
    const snap = await db
      .collection('vaccinations')
      .where('familyId', '==', familyId)
      .get();
    const startMs = start.valueOf();
    const endMs = end.valueOf();
    return snap.docs
      .map((d) => d.data())
      .filter((v) => !v.archivedAt && v.nextDueAt?.toMillis)
      .filter((v) => {
        if (petIdsFilter && !petIdsFilter.has(v.petId)) return false;
        const ms = v.nextDueAt.toMillis();
        return ms >= startMs && ms < endMs;
      });
  } catch (err) {
    console.warn('[query-schedule] vaccinations fetch failed:', err.message);
    return [];
  }
}

async function fetchVetVisitsInWindow({ familyId, start, end, petIdsFilter }) {
  try {
    const snap = await db
      .collection('vetVisits')
      .where('familyId', '==', familyId)
      .get();
    const startMs = start.valueOf();
    const endMs = end.valueOf();
    return snap.docs
      .map((d) => d.data())
      .filter((v) => !v.archivedAt && v.visitedAt?.toMillis)
      .filter((v) => {
        if (petIdsFilter && !petIdsFilter.has(v.petId)) return false;
        const ms = v.visitedAt.toMillis();
        return ms >= startMs && ms < endMs;
      });
  } catch (err) {
    console.warn('[query-schedule] vet visits fetch failed:', err.message);
    return [];
  }
}

async function loadFamilyRosterMaps(familyId) {
  try {
    const [memberSnap, petSnap] = await Promise.all([
      db.collection('familyMembers').where('familyId', '==', familyId).get(),
      db.collection('pets').where('familyId', '==', familyId).get(),
    ]);
    const membersById = new Map();
    memberSnap.docs.forEach((d) => membersById.set(d.id, { id: d.id, ...d.data() }));
    const petsById = new Map();
    petSnap.docs.forEach((d) => petsById.set(d.id, { id: d.id, ...d.data() }));
    return { membersById, petsById };
  } catch (err) {
    console.warn('[query-schedule] roster load failed:', err.message);
    return { membersById: new Map(), petsById: new Map() };
  }
}

/**
 * @param {object} args
 * @param {{familyId: string, memberId?: string, role?: string}} args.sender
 * @param {object} args.payload   { window, forMembers?, strict? }
 * @returns {Promise<{replyText: string}>}
 */
export async function querySchedule({ sender, payload }) {
  const window = payload?.window && KNOWN_WINDOWS.has(payload.window)
    ? payload.window
    : 'today';
  const { start, end } = rangeFor(window);

  // Accept both the array form (forMembers) and the legacy singular
  // forMember string so a stale Gemini cached emission doesn't break us.
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

  const memberIds = new Set();
  const petIds = new Set();
  for (const r of resolutions) {
    if (r.kind === 'self' || r.kind === 'member') memberIds.add(r.id);
    else if (r.kind === 'pet') petIds.add(r.id);
  }
  const strict = payload?.strict === true;
  const hasFilter = memberIds.size > 0 || petIds.size > 0;
  const hasHumanTarget = memberIds.size > 0;
  const petOnly = memberIds.size === 0 && petIds.size > 0;

  // Load everything we need in parallel: events + roster + (when relevant)
  // pet care collections.
  const [allEvents, { membersById, petsById }] = await Promise.all([
    fetchEvents({ familyId: sender.familyId, start, end }),
    loadFamilyRosterMaps(sender.familyId),
  ]);

  // Decide pet care fetch scope:
  //   - Pet-only query → only the requested pets.
  //   - Human / unfiltered query → ALL family pets, so a parent's "מה יש לי?"
  //     surfaces vaccinations and vet visits across every pet.
  let vaccs = [];
  let visits = [];
  if (petOnly) {
    [vaccs, visits] = await Promise.all([
      fetchVaccinationsInWindow({
        familyId: sender.familyId,
        start,
        end,
        petIdsFilter: petIds,
      }),
      fetchVetVisitsInWindow({
        familyId: sender.familyId,
        start,
        end,
        petIdsFilter: petIds,
      }),
    ]);
  } else if (!hasFilter || hasHumanTarget) {
    [vaccs, visits] = await Promise.all([
      fetchVaccinationsInWindow({ familyId: sender.familyId, start, end }),
      fetchVetVisitsInWindow({ familyId: sender.familyId, start, end }),
    ]);
  }

  // Decide which events to include in the result.
  function eventMatches(e) {
    if (!hasFilter) return true;
    const attendees = Array.isArray(e.attendeeMemberIds) ? e.attendeeMemberIds : [];
    const eventPetIds = Array.isArray(e.petIds) ? e.petIds : [];
    const petHit = [...petIds].some((pid) => eventPetIds.includes(pid));

    if (strict) {
      const memberHit = attendees.length === 1 && memberIds.has(attendees[0]);
      return memberHit || petHit;
    }
    const memberHit = [...memberIds].some((mid) => attendees.includes(mid));
    // Family-wide events (no human attendees) and pet-only events count as
    // "visible to anyone in the family", so a human-target query gets
    // them too. We only suppress events tagged exclusively to other
    // humans.
    const noHumansTagged = memberIds.size > 0 && attendees.length === 0;
    return memberHit || petHit || noHumansTagged;
  }

  // Build a unified, time-sorted list of items with icons.
  // Stable orderings for the "untagged" composite icon: family creator
  // first (createdAt asc), pets in name order. Falls back to map order
  // if timestamps are missing.
  const allMembersOrdered = Array.from(membersById.values())
    .filter((m) => !m.archivedAt)
    .sort((a, b) => {
      const ax = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
      const bx = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
      return ax - bx;
    });
  const allPetsOrdered = Array.from(petsById.values())
    .filter((p) => !p.archivedAt)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

  const items = [];
  for (const e of allEvents) {
    if (!eventMatches(e)) continue;
    const ts = e.startTime?.toDate?.();
    if (!ts) continue;
    items.push({
      at: ts,
      icon: iconForEvent(e, membersById, petsById, allMembersOrdered, allPetsOrdered),
      label: e.title || 'אירוע',
    });
  }
  for (const v of vaccs) {
    const ts = v.nextDueAt?.toDate?.();
    if (!ts) continue;
    const pet = petsById.get(v.petId);
    items.push({
      at: ts,
      icon: iconForPet(pet),
      label: pet
        ? `חיסון ${pet.name}${v.type ? ` · ${v.type}` : ''}`
        : `חיסון${v.type ? ' · ' + v.type : ''}`,
    });
  }
  for (const v of visits) {
    const ts = v.visitedAt?.toDate?.();
    if (!ts) continue;
    const pet = petsById.get(v.petId);
    items.push({
      at: ts,
      icon: iconForPet(pet),
      label: pet
        ? `וטרינר ${pet.name}${v.reason ? ` · ${v.reason}` : ''}`
        : `וטרינר${v.reason ? ' · ' + v.reason : ''}`,
    });
  }
  items.sort((a, b) => a.at.getTime() - b.at.getTime());

  const lines = items.map((it) => {
    const local = dayjs(it.at).tz(FAMILY_TZ);
    return `${it.icon} ${formatPrefix(local, window)} ${it.label}`;
  });

  return { replyText: scheduleReply(window, lines) };
}
