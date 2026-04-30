// One-shot seed script — inserts two demo RecurringTasks into the Berans
// family. Idempotent: skips by exact title match (case-insensitive).
//
// Run with the same env vars as the bot:
//   npm run seed
//
// FAMILY_ID is hard-coded to T7CdDMb8lug0qSAQcJdQ — that's the real test
// family. Member ids are looked up dynamically by firstName so we don't hard
// code them.

import 'dotenv/config';
import admin from 'firebase-admin';

const FAMILY_ID = 'T7CdDMb8lug0qSAQcJdQ';

const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const dbUrl = process.env.FIREBASE_DB_URL;
if (!serviceAccountJson) {
  console.error('Missing FIREBASE_SERVICE_ACCOUNT_JSON');
  process.exit(1);
}
if (!dbUrl) {
  console.error('Missing FIREBASE_DB_URL');
  process.exit(1);
}

const credentials = JSON.parse(serviceAccountJson);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(credentials),
    databaseURL: dbUrl,
  });
}

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

async function findMemberByName(firstName) {
  const snap = await db
    .collection('familyMembers')
    .where('familyId', '==', FAMILY_ID)
    .where('firstName', '==', firstName)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

async function findExistingTaskByTitle(title) {
  const snap = await db
    .collection('recurringTasks')
    .where('familyId', '==', FAMILY_ID)
    .where('title', '==', title)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return snap.docs[0];
}

async function main() {
  const jordan = await findMemberByName('Jordan');
  const maza = await findMemberByName('Maza');

  // Fall back to Hebrew names if English isn't there.
  const jordanFallback = jordan || (await findMemberByName('ג\'ורדן')) || (await findMemberByName('ג׳ורדן')) || (await findMemberByName('יורדן'));
  const mazaFallback = maza || (await findMemberByName('מזה')) || (await findMemberByName('מאזה'));

  if (!jordanFallback) {
    console.error('Could not find Jordan in family members. Seed aborted.');
    process.exit(1);
  }
  if (!mazaFallback) {
    console.error('Could not find Maza in family members. Seed aborted.');
    process.exit(1);
  }

  const userId = jordanFallback.linkedUserId || 'seed-script';

  const tasks = [
    {
      title: 'טיול עם הכלבה',
      target: 'pet',
      targetEntityId: null,
      scheduleTimes: ['09:00', '17:00'],
      rotation: 'rotating',
      responsibleMemberIds: [jordanFallback.id, mazaFallback.id],
    },
    {
      title: 'תרופה לכלבה',
      target: 'pet',
      targetEntityId: null,
      scheduleTimes: ['08:00'],
      rotation: 'fixed',
      responsibleMemberIds: [jordanFallback.id],
    },
  ];

  let created = 0;
  let skipped = 0;
  for (const t of tasks) {
    const existing = await findExistingTaskByTitle(t.title);
    if (existing) {
      skipped += 1;
      continue;
    }
    await db.collection('recurringTasks').add({
      familyId: FAMILY_ID,
      title: t.title,
      target: t.target,
      targetEntityId: t.targetEntityId,
      scheduleTimes: t.scheduleTimes,
      rotation: t.rotation,
      responsibleMemberIds: t.responsibleMemberIds,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: userId,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: userId,
      archivedAt: null,
      archivedBy: null,
    });
    created += 1;
  }

  console.log(`Seed complete: ${created} created, ${skipped} skipped (already existed).`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
