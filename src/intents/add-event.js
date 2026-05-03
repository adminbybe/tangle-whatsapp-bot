// Intent handler: add-event.
// Mirrors createEvent() in app/src/lib/event-actions.ts exactly, with
// source='bot'. Returns the new event id, the Hebrew reply, and an undo token.
//
// On incomplete payloads it does NOT throw. Instead it returns a structured
// "needs-clarification" / "cannot-understand" status so the orchestrator can
// produce a friendly Hebrew reply rather than a scary internal-error reply.

import { db, FieldValue, Timestamp } from '../firebase-admin.js';
import { dayjs, FAMILY_TZ, parseIsoToTz } from '../dates.js';
import { newUndoToken } from '../undo.js';
import { eventAddedReply, clarifyTimeReply, unknownIntentReply } from '../reply-templates.js';
import { resolveEntities } from '../entity-resolver.js';

const VALID_CATEGORIES = ['work', 'personal', 'school', 'family', 'medical', 'other'];

export class UnlinkedMemberError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnlinkedMemberError';
  }
}

/**
 * @param {object} args
 * @param {{familyId: string, memberId: string, linkedUserId: string|null, displayName: string}} args.sender
 * @param {object} args.payload
 * @returns {Promise<
 *   | {status: 'created', eventId: string, replyText: string, undoToken: string, eventRef: any, eventTitle: string}
 *   | {status: 'needs-clarification', missing: 'startTime', title: string, replyText: string, partialPayload: object}
 *   | {status: 'cannot-understand', reason: string, replyText: string}
 * >}
 */
export async function addEvent({ sender, payload }) {
  if (!payload || typeof payload !== 'object') {
    return {
      status: 'cannot-understand',
      reason: 'missing-payload',
      replyText: unknownIntentReply(),
    };
  }
  const title = (payload.title || '').toString().trim();
  if (!title) {
    return {
      status: 'cannot-understand',
      reason: 'missing-title',
      replyText: unknownIntentReply(),
    };
  }

  const startIso = payload.startTime;
  if (!startIso) {
    return {
      status: 'needs-clarification',
      missing: 'startTime',
      title,
      replyText: clarifyTimeReply(title),
      partialPayload: { ...payload, title },
    };
  }
  const startD = dayjs(startIso);
  if (!startD.isValid()) {
    return {
      status: 'needs-clarification',
      missing: 'startTime',
      title,
      replyText: clarifyTimeReply(title),
      partialPayload: { ...payload, title, startTime: undefined },
    };
  }

  let endD;
  if (payload.endTime) {
    endD = dayjs(payload.endTime);
    if (!endD.isValid() || !endD.isAfter(startD)) {
      endD = startD.add(60, 'minute');
    }
  } else {
    endD = startD.add(60, 'minute');
  }

  if (!sender.linkedUserId) {
    throw new UnlinkedMemberError(
      'sender member is not linked to an auth user; cannot create event'
    );
  }

  const category = VALID_CATEGORIES.includes(payload.category)
    ? payload.category
    : 'family';

  const location = payload.location ? String(payload.location).trim() || null : null;

  // Resolve every name the NLU pulled from the message (attendees + an
  // optional dedicated `pets` list for clarity) into Tangle entities.
  // The speaker is always tagged in attendeeMemberIds — that's what makes
  // "מה יש רק לי?" work later. Mentioned family members go in too;
  // mentioned pets go into petIds.
  const attendeeMemberIds = sender.memberId ? [sender.memberId] : [];
  const petIds = [];
  const namesFromPayload = [
    ...(Array.isArray(payload.attendees) ? payload.attendees : []),
    ...(Array.isArray(payload.pets) ? payload.pets : []),
  ].map((s) => String(s || '').trim()).filter(Boolean);

  if (namesFromPayload.length) {
    try {
      const resolutions = await resolveEntities({
        familyId: sender.familyId,
        sender,
        names: namesFromPayload,
      });
      for (const r of resolutions) {
        if (r.kind === 'member' && r.id && !attendeeMemberIds.includes(r.id)) {
          attendeeMemberIds.push(r.id);
        } else if (r.kind === 'self' && r.id && !attendeeMemberIds.includes(r.id)) {
          attendeeMemberIds.push(r.id);
        } else if (r.kind === 'pet' && r.id && !petIds.includes(r.id)) {
          petIds.push(r.id);
        }
        // 'unknown' / 'ambiguous' → skip silently. The event still gets
        // created with whatever we did resolve, and the user can edit
        // attendees in the app afterwards.
      }
    } catch (err) {
      console.warn('[add-event] entity resolution failed:', err.message);
      // Non-fatal: keep the event with sender as the only attendee.
    }
  }

  const docPayload = {
    familyId: sender.familyId,
    title,
    description: null,
    startTime: Timestamp.fromDate(startD.toDate()),
    endTime: Timestamp.fromDate(endD.toDate()),
    isAllDay: false,
    location,
    attendeeMemberIds,
    petIds,
    isPrivate: false,
    category,
    recurrence: 'none',
    recurrenceUntil: null,
    reminderMinutesBefore: [],
    status: 'confirmed',
    source: 'bot',
    fileIds: [],
    createdAt: FieldValue.serverTimestamp(),
    createdBy: sender.linkedUserId,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: sender.linkedUserId,
    archivedAt: null,
    archivedBy: null,
  };

  const ref = await db.collection('events').add(docPayload);

  const replyText = eventAddedReply(title, parseIsoToTz(startD.toISOString()));
  const undoToken = newUndoToken();

  return {
    status: 'created',
    eventId: ref.id,
    eventRef: ref,
    eventTitle: title,
    replyText,
    undoToken,
  };
}
