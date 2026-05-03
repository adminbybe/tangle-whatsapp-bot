// Intent handler: query-pet-info (read-only).
// Answers free-form questions about a specific pet that don't fit the
// time-bound query-schedule mould — vet contact, food / supplies, current
// medications, recorded conditions, weight history. The user picks the
// `aspect` and the bot pulls the right Firestore collection.

import { db } from '../firebase-admin.js';
import { resolveEntity } from '../entity-resolver.js';

const KNOWN_ASPECTS = new Set([
  'vet',
  'food',
  'medication',
  'condition',
  'weight',
]);

function fmtAspectMissing(aspect) {
  switch (aspect) {
    case 'vet':
      return 'אין לי פרטי וטרינר רשומים על';
    case 'food':
      return 'לא מצאתי רשומות מזון/אביזרים על';
    case 'medication':
      return 'אין תרופות פעילות רשומות על';
    case 'condition':
      return 'אין רגישויות / מצבים רפואיים רשומים על';
    case 'weight':
      return 'אין שקילות רשומות על';
    default:
      return 'אין מידע על';
  }
}

async function fetchVet(pet) {
  const lines = [];
  if (pet.vetName) lines.push(`וטרינר: ${pet.vetName}`);
  if (pet.vetPhone) lines.push(`טלפון: ${pet.vetPhone}`);
  return lines;
}

async function fetchFood(petId, familyId) {
  const snap = await db
    .collection('petSupplies')
    .where('familyId', '==', familyId)
    .where('petId', '==', petId)
    .get();
  const lines = [];
  for (const d of snap.docs) {
    const s = d.data();
    if (s.archivedAt) continue;
    const name = [s.brand, s.productName].filter(Boolean).join(' ').trim() || 'מוצר';
    const remaining =
      typeof s.remainingApprox === 'number'
        ? ` · נשאר כ-${s.remainingApprox} ${s.remainingUnit || ''}`.trim()
        : '';
    const cat = s.category ? ` (${s.category})` : '';
    lines.push(`${name}${cat}${remaining}`);
  }
  return lines;
}

async function fetchMedications(petId, familyId) {
  const snap = await db
    .collection('petMedications')
    .where('familyId', '==', familyId)
    .where('petId', '==', petId)
    .get();
  const now = Date.now();
  const lines = [];
  for (const d of snap.docs) {
    const m = d.data();
    if (m.archivedAt) continue;
    // Skip medications that have ended.
    const endMs = m.endDate?.toMillis ? m.endDate.toMillis() : null;
    if (endMs && endMs < now) continue;
    const dose = m.dose ? ` · ${m.dose}` : '';
    const sched = m.schedule ? ` · ${m.schedule}` : '';
    lines.push(`${m.name || 'תרופה'}${dose}${sched}`);
  }
  return lines;
}

async function fetchConditions(petId, familyId) {
  const snap = await db
    .collection('petConditions')
    .where('familyId', '==', familyId)
    .where('petId', '==', petId)
    .get();
  const lines = [];
  for (const d of snap.docs) {
    const c = d.data();
    if (c.archivedAt) continue;
    const t = c.type === 'allergy' ? 'רגישות' : 'מצב';
    lines.push(`${t}: ${c.description || '—'}`);
  }
  return lines;
}

async function fetchLatestWeight(petId, familyId) {
  const snap = await db
    .collection('petWeightEntries')
    .where('familyId', '==', familyId)
    .where('petId', '==', petId)
    .orderBy('recordedAt', 'desc')
    .limit(1)
    .get();
  if (snap.empty) return [];
  const w = snap.docs[0].data();
  if (w.archivedAt) return [];
  const ms = w.recordedAt?.toMillis ? w.recordedAt.toMillis() : null;
  const dateStr = ms ? new Date(ms).toLocaleDateString('he-IL') : '';
  return [`${w.weightKg} ק"ג${dateStr ? ` (${dateStr})` : ''}`];
}

/**
 * @param {object} args
 * @param {{familyId: string, memberId?: string, role?: string}} args.sender
 * @param {object} args.payload   { petName: string, aspect: 'vet'|'food'|... }
 * @returns {Promise<{replyText: string}>}
 */
export async function queryPetInfo({ sender, payload }) {
  const petName = (payload?.petName || '').toString().trim();
  const aspect = (payload?.aspect || '').toString().trim().toLowerCase();

  if (!petName || !KNOWN_ASPECTS.has(aspect)) {
    return {
      replyText: 'לא הצלחתי להבין על איזו חיית מחמד או מה בדיוק שאלת. נסה שוב.',
    };
  }

  const resolved = await resolveEntity({
    familyId: sender.familyId,
    sender,
    name: petName,
  });
  if (resolved.kind === 'unknown') {
    return { replyText: `לא מצאתי חיית מחמד בשם "${petName}".` };
  }
  if (resolved.kind === 'ambiguous') {
    return {
      replyText: `"${petName}" מתאים לכמה דברים. צריך לציין שם ייחודי של חיית מחמד.`,
    };
  }
  if (resolved.kind !== 'pet') {
    return {
      replyText: `"${petName}" הוא בן/ת משפחה, לא חיית מחמד. שאלות על וטרינר/אוכל/תרופות מתייחסות לחיות.`,
    };
  }

  const pet = resolved.raw;
  let lines = [];
  switch (aspect) {
    case 'vet':
      lines = await fetchVet(pet);
      break;
    case 'food':
      lines = await fetchFood(pet.id, sender.familyId);
      break;
    case 'medication':
      lines = await fetchMedications(pet.id, sender.familyId);
      break;
    case 'condition':
      lines = await fetchConditions(pet.id, sender.familyId);
      break;
    case 'weight':
      lines = await fetchLatestWeight(pet.id, sender.familyId);
      break;
    default:
      lines = [];
  }

  const heading = (() => {
    switch (aspect) {
      case 'vet':
        return `וטרינר של ${pet.name}:`;
      case 'food':
        return `אוכל / אביזרים של ${pet.name}:`;
      case 'medication':
        return `תרופות פעילות של ${pet.name}:`;
      case 'condition':
        return `מצבים רפואיים / רגישויות של ${pet.name}:`;
      case 'weight':
        return `משקל אחרון של ${pet.name}:`;
      default:
        return `${pet.name}:`;
    }
  })();

  if (lines.length === 0) {
    return { replyText: `${fmtAspectMissing(aspect)} ${pet.name}.` };
  }
  return {
    replyText: `${heading}\n` + lines.map((l) => `- ${l}`).join('\n'),
  };
}
