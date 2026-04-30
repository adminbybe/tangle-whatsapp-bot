// Intent handler: add-event.
// Mirrors createEvent() in app/src/lib/event-actions.ts exactly, with
// source='bot'. Returns the new event id, the Hebrew reply, and an undo token.

import { db, FieldValue, Timestamp } from '../firebase-admin.js';
import { dayjs, FAMILY_TZ, parseIsoToTz } from '../dates.js';
import { newUndoToken } from '../undo.js';
import { eventAddedReply } from '../reply-templates.js';

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
 * @returns {Promise<{eventId: string, replyText: string, undoToken: string, eventRef: any, eventTitle: string}>}
 */
export async function addEvent({ sender, payload }) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('add-event: missing payload');
  }
  const title = (payload.title || '').toString().trim();
  if (!title) throw new Error('add-event: missing title');

  const startIso = payload.startTime;
  if (!startIso) throw new Error('add-event: missing startTime');
  const startD = dayjs(startIso);
  if (!startD.isValid()) throw new Error('add-event: invalid startTime');

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

  const docPayload = {
    familyId: sender.familyId,
    title,
    description: null,
    startTime: Timestamp.fromDate(startD.toDate()),
    endTime: Timestamp.fromDate(endD.toDate()),
    isAllDay: false,
    location,
    attendeeMemberIds: [], // v1 does not resolve named attendees
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
    eventId: ref.id,
    eventRef: ref,
    eventTitle: title,
    replyText,
    undoToken,
  };
}
