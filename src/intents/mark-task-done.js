// Intent handler: mark-task-done.
// First tries to match an existing recurringTask in the family by fuzzy title
// (lowercase + Hebrew gershayim normalization, includes substring). If matched
// → write a recurringTaskCompletion. Otherwise → write a completed Todo.

import { db, FieldValue } from '../firebase-admin.js';
import { todayIsoDate } from '../dates.js';
import { newUndoToken } from '../undo.js';
import { taskDoneReply } from '../reply-templates.js';
import { UnlinkedMemberError } from './add-event.js';

function normalizeTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[״"׳']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {object} args
 * @param {{familyId: string, memberId: string, linkedUserId: string|null, displayName: string}} args.sender
 * @param {object} args.payload
 * @returns {Promise<{entityType: string, entityId: string, replyText: string, undoToken: string, entityRef: any, entityTitle: string}>}
 */
export async function markTaskDone({ sender, payload }) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('mark-task-done: missing payload');
  }
  const taskTitle = (payload.taskTitle || '').toString().trim();
  if (!taskTitle) throw new Error('mark-task-done: missing taskTitle');
  const forDate = payload.forDate || todayIsoDate();

  if (!sender.linkedUserId) {
    throw new UnlinkedMemberError(
      'sender member is not linked to an auth user; cannot mark task done'
    );
  }

  const userId = sender.linkedUserId;

  // 1) Search recurringTasks in this family.
  const tasksSnap = await db
    .collection('recurringTasks')
    .where('familyId', '==', sender.familyId)
    .get();

  const wanted = normalizeTitle(taskTitle);
  const wantedTokens = wanted.split(' ').filter(Boolean);

  /** @type {Array<{id:string, data: any}>} */
  const candidates = [];
  for (const docSnap of tasksSnap.docs) {
    const data = docSnap.data();
    if (data.archivedAt) continue;
    const tNorm = normalizeTitle(data.title);
    if (!tNorm) continue;
    if (
      tNorm.includes(wanted) ||
      wanted.includes(tNorm) ||
      wantedTokens.every((tok) => tNorm.includes(tok))
    ) {
      candidates.push({ id: docSnap.id, data });
    }
  }

  if (candidates.length === 1) {
    const taskId = candidates[0].id;
    const completionDoc = {
      familyId: sender.familyId,
      taskId,
      completedByMemberId: sender.memberId,
      completedAt: FieldValue.serverTimestamp(),
      forDate,
      notes: null,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: userId,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: userId,
      archivedAt: null,
      archivedBy: null,
    };
    const ref = await db.collection('recurringTaskCompletions').add(completionDoc);
    return {
      entityType: 'recurringTaskCompletion',
      entityId: ref.id,
      entityRef: ref,
      entityTitle: candidates[0].data.title,
      replyText: taskDoneReply(candidates[0].data.title || taskTitle),
      undoToken: newUndoToken(),
    };
  }

  // 2) No unique recurring task match → store a completed Todo.
  const todoDoc = {
    familyId: sender.familyId,
    title: taskTitle,
    description: null,
    proposedByMemberId: sender.memberId,
    responsibleMemberId: sender.memberId,
    dueAt: null,
    priority: 'normal',
    completedAt: FieldValue.serverTimestamp(),
    completedByMemberId: sender.memberId,
    createdAt: FieldValue.serverTimestamp(),
    createdBy: userId,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: userId,
    archivedAt: null,
    archivedBy: null,
  };
  const ref = await db.collection('todos').add(todoDoc);
  return {
    entityType: 'todo',
    entityId: ref.id,
    entityRef: ref,
    entityTitle: taskTitle,
    replyText: taskDoneReply(taskTitle),
    undoToken: newUndoToken(),
  };
}
