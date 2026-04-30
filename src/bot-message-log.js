// Persists every bot interaction to the `botMessages` collection.
// Doc shape mirrors `app/src/types/bot.ts` BotMessage exactly.

import { db, FieldValue, Timestamp } from './firebase-admin.js';

/**
 * @param {object} args
 * @param {object|null} args.sender       resolved sender object or null
 * @param {string} args.fromPhone         the raw E.164 we extracted from the JID
 * @param {string} args.rawText
 * @param {string} args.intent            BotIntent string
 * @param {number} args.confidence
 * @param {object} args.payload           parsed payload from Gemini
 * @param {string} args.actionStatus      BotActionStatus string
 * @param {string|null} args.resultingEntityType
 * @param {string|null} args.resultingEntityId
 * @param {string|null} args.botReply
 * @param {Date|null} args.undoExpiresAt
 * @returns {Promise<string>} botMessage doc id
 */
export async function logBotMessage(args) {
  if (!args.sender) throw new Error('logBotMessage requires a resolved sender');
  const {
    sender,
    fromPhone,
    rawText,
    intent,
    confidence,
    payload,
    actionStatus,
    resultingEntityType,
    resultingEntityId,
    botReply,
    undoExpiresAt,
  } = args;

  const familyId = sender.familyId;
  const userId = sender.linkedUserId ?? sender.memberId;

  const doc = {
    familyId,
    fromPhone,
    fromMemberId: sender.memberId,
    rawText: rawText ?? '',
    receivedAt: FieldValue.serverTimestamp(),
    detectedIntent: intent,
    intentConfidence: confidence,
    parsedPayload: payload ?? {},
    actionStatus,
    resultingEntityType: resultingEntityType ?? null,
    resultingEntityId: resultingEntityId ?? null,
    botReply: botReply ?? null,
    undoExpiresAt: undoExpiresAt ? Timestamp.fromDate(undoExpiresAt) : null,
    createdAt: FieldValue.serverTimestamp(),
    createdBy: userId,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: userId,
    archivedAt: null,
    archivedBy: null,
  };

  const ref = await db.collection('botMessages').add(doc);
  return ref.id;
}

/**
 * Update the actionStatus on an existing botMessage (e.g. after revert).
 * @param {string} botMessageId
 * @param {string} newStatus  BotActionStatus
 */
export async function updateBotMessageStatus(botMessageId, newStatus) {
  if (!botMessageId) return;
  await db.collection('botMessages').doc(botMessageId).update({
    actionStatus: newStatus,
    updatedAt: FieldValue.serverTimestamp(),
  });
}
