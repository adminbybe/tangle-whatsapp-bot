// All Hebrew strings the bot sends. Centralized so we tweak them in one place.

import dayjs from 'dayjs';
import 'dayjs/locale/he.js';

const HEB_DATE_FMT = 'dddd D בMMMM, HH:mm';

function formatHebDate(d) {
  // d is a dayjs object already in Asia/Jerusalem
  return d.locale('he').format(HEB_DATE_FMT);
}

export function eventAddedReply(title, startDayjs) {
  return `הוספתי "${title}" ל${formatHebDate(startDayjs)}. לביטול שלח/י "בטל" תוך 30 שניות.`;
}

export function clarifyTimeReply(title) {
  const safeTitle = title ? `"${title}"` : 'האירוע';
  return `באיזו שעה ${safeTitle}? לדוגמה "ב-15:00".`;
}

export function eventCancelledReply() {
  return 'בוטל. האירוע הוסר מהיומן.';
}

export function taskDoneReply(title) {
  return `רשמתי שעשית "${title}" היום ✓ לביטול שלח/י "בטל" תוך 30 שניות.`;
}

export function taskCancelledReply(title) {
  return title
    ? `בוטל. ההשלמה של "${title}" הוסרה.`
    : 'בוטל. ההשלמה הוסרה.';
}

export function confirmationPrompt(intentSummaryHebrew) {
  return `${intentSummaryHebrew}\nלאישור השב/י "כן" או "לא" לביטול.`;
}

export function unrecognizedSenderReply() {
  return 'מספר לא מזוהה. נא לבקש ממנהל/ת המשפחה להוסיף אותך כחבר/ת משפחה באפליקציה.';
}

export function unlinkedMemberReply() {
  return 'הנייד שלך מזוהה אך עדיין לא קושרת חשבון. כנסי לאפליקציה ותתקבלי הזמנה.';
}

export function unknownIntentReply() {
  return 'לא הבנתי את הבקשה. אפשר לנסות לנסח אחרת? למשל: "תוסיפי פגישה עם דני מחר ב-14:00" או "מה יש לי השבוע?"';
}

export function internalErrorReply() {
  return 'משהו השתבש אצלי. נסי שוב בעוד רגע.';
}

export function greetingFor(displayName) {
  const safeName = displayName ? ` ${displayName}` : '';
  return `כן${safeName}, איך אפשר לעזור?`;
}

/**
 * @param {string} headerHebrew  e.g. "היום:" / "מחר:" / "השבוע:"
 * @param {string[]} lines       e.g. ["09:00 פגישה עם דני", "14:00 רופא"]
 */
export function scheduleReply(headerHebrew, lines) {
  if (!lines || lines.length === 0) {
    return `אין לך אירועים ב${headerHebrew.replace(':', '')}.`;
  }
  return `${headerHebrew}\n` + lines.map((l) => `- ${l}`).join('\n');
}
