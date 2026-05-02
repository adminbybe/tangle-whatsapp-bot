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

// Header shown above the bullet list when there are events.
const SCHEDULE_HEADER_BY_WINDOW = {
  today: 'היום:',
  tomorrow: 'מחר:',
  'this-week': 'השבוע:',
  'next-week': 'השבוע הבא:',
  'this-month': 'החודש:',
  'next-month': 'החודש הבא:',
};

// Message shown when the schedule is empty for the chosen window. Hebrew
// preposition handling: "היום"/"מחר"/"השבוע"/"החודש" don't take a leading ב,
// but "בשבוע הבא"/"בחודש הבא" do — so each window owns its phrasing instead
// of a generic `אין לך אירועים ב${header}` template that produced
// ungrammatical output.
const SCHEDULE_EMPTY_BY_WINDOW = {
  today: 'אין לך אירועים היום.',
  tomorrow: 'אין לך אירועים מחר.',
  'this-week': 'אין לך אירועים השבוע.',
  'next-week': 'אין לך אירועים בשבוע הבא.',
  'this-month': 'אין לך אירועים החודש.',
  'next-month': 'אין לך אירועים בחודש הבא.',
};

/**
 * @param {'today'|'tomorrow'|'this-week'|'next-week'} window
 * @param {string[]} lines  e.g. ["09:00 פגישה עם דני", "14:00 רופא"]
 */
export function scheduleReply(window, lines) {
  if (!lines || lines.length === 0) {
    return SCHEDULE_EMPTY_BY_WINDOW[window] || 'אין לך אירועים בטווח הזה.';
  }
  const header = SCHEDULE_HEADER_BY_WINDOW[window] || '';
  return `${header}\n` + lines.map((l) => `- ${l}`).join('\n');
}

export function fileExpiryReply({ name, dateText, daysUntil }) {
  let urgency = '';
  if (typeof daysUntil === 'number') {
    if (daysUntil < 0) {
      urgency = ` (פג לפני ${Math.abs(daysUntil)} ימים)`;
    } else if (daysUntil === 0) {
      urgency = ' (פג היום)';
    } else if (daysUntil <= 30) {
      urgency = ` (בעוד ${daysUntil} ימים)`;
    }
  }
  return `${name} פג תוקף ב-${dateText}${urgency}.`;
}

export function fileExpiryNotFoundReply(query, knownFiles = []) {
  const head = query
    ? `לא מצאתי קובץ עם תאריך תפוגה שמתאים ל"${query}".`
    : 'לא מצאתי קובץ עם תאריך תפוגה תואם.';
  if (!Array.isArray(knownFiles) || knownFiles.length === 0) return head;
  const lines = knownFiles.slice(0, 8).map((f) => `- ${f}`).join('\n');
  return `${head}\nאלה הקבצים עם תאריך תפוגה שאני מכיר:\n${lines}`;
}
