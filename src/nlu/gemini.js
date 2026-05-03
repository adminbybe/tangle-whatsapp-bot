// Gemini-based Hebrew NLU for the Tangle bot.
// Calls gemini-2.0-flash with a strict JSON response schema and a Hebrew system
// prompt + few-shot examples. Returns a normalized intent/confidence/payload.

import { GoogleGenerativeAI } from '@google/generative-ai';
import { NLU_RESPONSE_SCHEMA } from './schema.js';
import { dayjs, FAMILY_TZ } from '../dates.js';

const TIMEOUT_MS = 10_000;
// Default to the full flash model (not flash-lite). Lite was producing
// inconsistent intent classification on the same exact input — same
// "מתי הטסט של מזל נגמר?" alternated between query-file-expiry and
// unknown, which felt like a broken bot to the user. Override via
// GEMINI_MODEL env var if needed.
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// Build few-shot examples with dates anchored to "today" so Gemini doesn't
// copy stale dates from a hardcoded example. All dates here are computed
// relative to todayIsoDate and use Asia/Jerusalem offsets.
function buildFewShot(todayIsoDate) {
  const today = dayjs.tz(todayIsoDate, FAMILY_TZ);
  const tomorrow = today.add(1, 'day');
  // For "Sunday morning" example: the next Sunday after today.
  const dayOfWeek = today.day(); // 0=Sun, 1=Mon, ...
  const daysUntilSunday = dayOfWeek === 0 ? 7 : 7 - dayOfWeek;
  const nextSunday = today.add(daysUntilSunday, 'day');
  const yyyymmdd = (d) => d.format('YYYY-MM-DD');
  const isoTime = (d, hh, mm) => d.hour(hh).minute(mm).second(0).millisecond(0).format();
  return `
דוגמאות (today=${todayIsoDate}, יום ${today.format('dddd')}):

הודעה: "תוסיפי פגישה עם דני מחר ב-14:00 במשרד"
JSON: {"intent":"add-event","confidence":0.97,"payload":{"title":"פגישה עם דני","startTime":"${isoTime(tomorrow, 14, 0)}","endTime":"${isoTime(tomorrow, 15, 0)}","location":"משרד","attendees":["דני"],"category":"work"}}

הודעה: "תקבע פגישה עם דני מחר ב-14:00 במלון דן תל אביב"
JSON: {"intent":"add-event","confidence":0.97,"payload":{"title":"פגישה עם דני","startTime":"${isoTime(tomorrow, 14, 0)}","endTime":"${isoTime(tomorrow, 15, 0)}","location":"מלון דן תל אביב","attendees":["דני"],"category":"work"}}

הודעה: "תקבע תור לרופא ביום ראשון 9 בבוקר ברחוב הרצל 12 תל אביב"
JSON: {"intent":"add-event","confidence":0.94,"payload":{"title":"תור לרופא","startTime":"${isoTime(nextSunday, 9, 0)}","endTime":"${isoTime(nextSunday, 10, 0)}","location":"רחוב הרצל 12 תל אביב","attendees":[],"category":"medical"}}

הודעה: "תקבע תור לוטרינר של ברי מחר ב-15:00 ברחוב ויצמן 8 הוד השרון"
JSON: {"intent":"add-event","confidence":0.95,"payload":{"title":"וטרינר ברי","startTime":"${isoTime(tomorrow, 15, 0)}","endTime":"${isoTime(tomorrow, 16, 0)}","location":"רחוב ויצמן 8 הוד השרון","attendees":["ברי"],"category":"medical"}}

הודעה: "תוסיף לי פגישת זום עם רותם מחר ב-10:00"
JSON: {"intent":"add-event","confidence":0.95,"payload":{"title":"פגישת זום עם רותם","startTime":"${isoTime(tomorrow, 10, 0)}","endTime":"${isoTime(tomorrow, 11, 0)}","attendees":["רותם"],"category":"work"}}

הודעה: "תוסיף לי פגישה עם דני מחר ב-15:00"
JSON: {"intent":"add-event","confidence":0.97,"payload":{"title":"פגישה עם דני","startTime":"${isoTime(tomorrow, 15, 0)}","endTime":"${isoTime(tomorrow, 16, 0)}","location":null,"attendees":["דני"],"category":"work"}}

הודעה: "תוסיף לי פגישה עם דני מחר"
JSON: {"intent":"add-event","confidence":0.6,"payload":{"title":"פגישה עם דני","location":null,"attendees":["דני"],"category":"work"}}

הודעה: "יש לי משהו עם אמא בערב"
JSON: {"intent":"add-event","confidence":0.55,"payload":{"title":"משהו עם אמא","startTime":"${isoTime(today, 19, 0)}","endTime":"${isoTime(today, 20, 0)}","location":null,"attendees":["אמא"],"category":"family"}}

הודעה: "תכניסי תור לרופא ביום ראשון בבוקר"
JSON: {"intent":"add-event","confidence":0.86,"payload":{"title":"תור לרופא","startTime":"${isoTime(nextSunday, 9, 0)}","endTime":"${isoTime(nextSunday, 10, 0)}","location":null,"attendees":[],"category":"medical"}}

הודעה: "הוצאתי את הכלבה לטיול"
JSON: {"intent":"mark-task-done","confidence":0.95,"payload":{"taskTitle":"טיול עם הכלבה","forDate":"${yyyymmdd(today)}"}}

הודעה: "מה יש לי השבוע?"
JSON: {"intent":"query-schedule","confidence":0.98,"payload":{"window":"this-week"}}

הודעה: "מה יש לי בשבוע הבא?"
JSON: {"intent":"query-schedule","confidence":0.97,"payload":{"window":"next-week"}}

הודעה: "תן לי את הלו"ז השבועי שלי החל ממחר"
JSON: {"intent":"query-schedule","confidence":0.92,"payload":{"window":"next-week"}}

הודעה: "מה יש לי החודש?"
JSON: {"intent":"query-schedule","confidence":0.97,"payload":{"window":"this-month","forMembers":["self"]}}

הודעה: "מה יש לי השבוע?"
JSON: {"intent":"query-schedule","confidence":0.97,"payload":{"window":"this-week","forMembers":["self"]}}

הודעה: "מה יש לי החודש הבא?"
JSON: {"intent":"query-schedule","confidence":0.95,"payload":{"window":"next-month","forMembers":["self"]}}

הודעה: "מה יש רק לי החודש?"
JSON: {"intent":"query-schedule","confidence":0.94,"payload":{"window":"this-month","forMembers":["self"],"strict":true}}

הודעה: "מה יש לי לבד השבוע?"
JSON: {"intent":"query-schedule","confidence":0.93,"payload":{"window":"this-week","forMembers":["self"],"strict":true}}

הודעה: "מה יש למזל החודש?"
JSON: {"intent":"query-schedule","confidence":0.93,"payload":{"window":"this-month","forMembers":["מזל"]}}

הודעה: "מה יש רק למזל החודש?"
JSON: {"intent":"query-schedule","confidence":0.92,"payload":{"window":"this-month","forMembers":["מזל"],"strict":true}}

הודעה: "מה יש לאשתי השבוע?"
JSON: {"intent":"query-schedule","confidence":0.92,"payload":{"window":"this-week","forMembers":["אשתי"]}}

הודעה: "תן לי את הלו"ז שלי ואת הלו"ז של מזל החודש"
JSON: {"intent":"query-schedule","confidence":0.93,"payload":{"window":"this-month","forMembers":["self","מזל"]}}

הודעה: "מה יש לי ולאשתי השבוע?"
JSON: {"intent":"query-schedule","confidence":0.92,"payload":{"window":"this-week","forMembers":["self","אשתי"]}}

הודעה: "מה יש לי ולברי החודש?"
JSON: {"intent":"query-schedule","confidence":0.92,"payload":{"window":"this-month","forMembers":["self","ברי"]}}

הודעה: "מה יש לברי החודש?"
JSON: {"intent":"query-schedule","confidence":0.93,"payload":{"window":"this-month","forMembers":["ברי"]}}

הודעה: "מה יש לכלבה השבוע?"
JSON: {"intent":"query-schedule","confidence":0.9,"payload":{"window":"this-week","forMembers":["כלבה"]}}

הודעה: "מתי הטסט של מזל נגמר?"
JSON: {"intent":"query-file-expiry","confidence":0.95,"payload":{"searchQuery":"טסט מזל"}}

הודעה: "מתי פג הביטוח של הרכב?"
JSON: {"intent":"query-file-expiry","confidence":0.93,"payload":{"searchQuery":"ביטוח רכב"}}

הודעה: "כמה זמן יש לי על הרישיון?"
JSON: {"intent":"query-file-expiry","confidence":0.9,"payload":{"searchQuery":"רישיון"}}

הודעה: "מתי הדרכון של אבא נגמר?"
JSON: {"intent":"query-file-expiry","confidence":0.95,"payload":{"searchQuery":"דרכון אבא"}}

הודעה: "כמה זמן עוד יש לחוזה השכירות?"
JSON: {"intent":"query-file-expiry","confidence":0.9,"payload":{"searchQuery":"חוזה שכירות"}}

הודעה: "עד מתי תקף הביטוח של הבית?"
JSON: {"intent":"query-file-expiry","confidence":0.92,"payload":{"searchQuery":"ביטוח בית"}}

הודעה: "מתי הטסט של אשתי נגמר?"
JSON: {"intent":"query-file-expiry","confidence":0.95,"payload":{"searchQuery":"טסט אשתי"}}

הודעה: "מתי פג הדרכון של הילד?"
JSON: {"intent":"query-file-expiry","confidence":0.93,"payload":{"searchQuery":"דרכון הילד"}}

הודעה: "אהלן מה קורה"
JSON: {"intent":"unknown","confidence":0.1,"payload":{}}
`;
}

function buildSystemPrompt(senderName, todayIsoDate) {
  return [
    `אתה עוזר משפחתי בעברית. נתח הודעה ממשתמש בשם ${senderName} שנשלחה היום (${todayIsoDate}, אזור זמן Asia/Jerusalem).`,
    'זהה את הכוונה ואת הביטחון שלך (0..1). השב רק JSON לפי הסכמה.',
    'כללים קריטיים:',
    '- payload חייב להכיל אך ורק שדות של ה-intent שזיהית. אסור לערבב שדות בין intents.',
    '  • intent="add-event" → רק title, startTime, endTime, location, attendees, category. אסור window/taskTitle/forDate. attendees הוא מערך של שמות שהוזכרו במפורש (גם בני משפחה וגם חיות מחמד) — בלי להמציא.',
    '  • intent="mark-task-done" → רק taskTitle, forDate. אסור title/startTime/window.',
    '  • intent="query-schedule" → רק window. אסור title/startTime/taskTitle.',
    '  • intent="query-file-expiry" → רק searchQuery. אסור window/title/taskTitle. השתמש בכוונה הזו לשאלות "מתי X פג/נגמר/תקף", "כמה זמן יש לי על X", על מסמכים, רישיונות, ביטוחים, טסט רכב, תעודות חיסון, חוזים — כל קובץ עם תאריך תפוגה.',
    '  • intent="unknown" → payload ריק {}.',
    '- ל-add-event: title ו-startTime הם שדות חובה. אם המשתמש לא ציין שעה ברורה — השמט לגמרי את startTime (אל תמציא!), והורד את הביטחון מתחת ל-0.9.',
    '- כל ערכי startTime/endTime חייבים להיות ISO 8601 עם offset +03:00 או +02:00 לפי השעון בישראל.',
    '- ב-query-schedule: window="this-week" כשהמשתמש שואל על השבוע הנוכחי. window="next-week" כשהוא שואל "השבוע הבא", "בשבוע הבא", או "הלו"ז השבועי החל ממחר". window="this-month" כשהוא שואל "מה יש לי החודש", "החודש הזה", "החודש הקרוב". window="next-month" כשהוא שואל "החודש הבא". אם today הוא יום שבת והמשתמש אומר "השבוע" סתם, נטה ל-this-week (הקוד יטפל בזה הגיוני).',
    '- ב-query-schedule: כשהמשתמש מציין את עצמו ("מה יש לי", "מה הלו"ז שלי") — forMembers=["self"]. כשהוא מציין שם ("מה יש למזל", "של אשתי") — forMembers=[השם]. כשהוא מציין כמה אנשים ("הלו"ז שלי ושל אשתי", "מה יש לי ולברי") — forMembers הוא מערך עם כל השמות, בסדר ההופעה ("self" כשהוא הזכיר את עצמו). strict=true רק כשהמשתמש מוסיף "רק" ("מה יש *רק* לי") — סינון קשיח של אירוע ש-target הוא היחיד המתויג. בלי "רק" → strict לא מצוין (filtering soft: כל אירוע שאחד מהיעדים מופיע בו).',
    '- ב-query-file-expiry: כל שאלה בנוסח "מתי X פג / נגמר / עד מתי תקף / כמה זמן יש על X" על מסמך, רישיון, ביטוח, טסט רכב, חיסון, דרכון, חוזה, או כל פריט עם תוקף-זמן — היא query-file-expiry. גם אם השאלה מציינת שם של בן משפחה ("של מזל"), זו עדיין query-file-expiry. שלוף מילות-מפתח ל-searchQuery (כולל שם בן המשפחה אם הוזכר).',
    '- intent="unknown" רק לנושאים שמחוץ לטווח הבוט לחלוטין: שיחת חולין ("מה שלומך"), מזג אוויר, חדשות, חישובים, שאלות על המוצר עצמו. לעולם אל תחזיר unknown לשאלה תקפה על אירועים/משימות/לוח זמנים/קבצים-עם-תוקף.',
    '- אם המשתמש אמר "מחר" — startTime חייב להיות בתאריך todayIsoDate+1 (לא היום).',
    '- אם המשתמש אמר "היום" — startTime בתאריך todayIsoDate.',
    '- אל תעתיק תאריכים מהדוגמאות. תמיד חשב מחדש לפי todayIsoDate שניתן בראש ההודעה.',
    '- forDate תמיד YYYY-MM-DD.',
    '- אל תמציא שמות אנשים שלא הוזכרו.',
    '- חילוץ מיקום ב-add-event: אם ההודעה כוללת ביטוי מיקום ("ב-<מקום>", "ברחוב <שם> <מס>", "בכתובת <…>", "ב<עיר>", "אצל <מקום>"), העתק אותו לשדה location בלי מילת היחס המובילה (ב/אצל). אל תכלול את המיקום בתוך title — title צריך להיות נקי ("פגישה עם דני", לא "פגישה עם דני במלון דן"). אם אין מיקום בהודעה, השמט את location או החזר null.',
    '- ב-add-event, attendees כולל את כל השמות הספציפיים שהמשתמש הזכיר (אנשים וחיות מחמד), בלי "אני"/"לי"/"שלי" ובלי שמות שהמשתמש לא ציין. דוגמה: "תקבע תור לוטרינר של ברי ברחוב ויצמן 8" → attendees=["ברי"], location="רחוב ויצמן 8". דוגמה: "תקבע פגישה עם דני" → attendees=["דני"]. דוגמה: "תוסיף פגישת זום מחר" → attendees=[].',
    '- ב-add-event, category="medical" כשמדובר ברופא/וטרינר/חיסון/בדיקה רפואית. category="work" כשמדובר בפגישת עבודה. category="school" לבית ספר/גן. category="family" ברירת מחדל.',
    '- אם ההודעה לא מתאימה לאף כוונה החזר intent="unknown".',
    buildFewShot(todayIsoDate),
  ].join('\n');
}

function unknownResult(reason) {
  const payload = reason ? { _debug: reason } : {};
  return { intent: 'unknown', confidence: 0, payload };
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('gemini-timeout')), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

let cachedClient = null;
function getClient() {
  if (!cachedClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('Missing GEMINI_API_KEY environment variable.');
    }
    cachedClient = new GoogleGenerativeAI(apiKey);
  }
  return cachedClient;
}

/**
 * Parse a raw Hebrew message via Gemini.
 *
 * @param {string} rawText
 * @param {string} senderName
 * @param {string} todayIsoDate  YYYY-MM-DD in Asia/Jerusalem
 * @returns {Promise<{intent: string, confidence: number, payload: object}>}
 */
export async function parseMessage(rawText, senderName, todayIsoDate) {
  if (!rawText || !rawText.trim()) return unknownResult();

  let model;
  try {
    const client = getClient();
    model = client.getGenerativeModel({
      model: MODEL_NAME,
      generationConfig: {
        // 0 → deterministic. The same input always gets the same intent,
        // which is the right tradeoff for a command parser.
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: NLU_RESPONSE_SCHEMA,
      },
      systemInstruction: buildSystemPrompt(senderName, todayIsoDate),
    });
  } catch (err) {
    console.error('[nlu] failed to construct model:', err.message);
    return unknownResult('model-construct: ' + err.message);
  }

  try {
    const result = await withTimeout(
      model.generateContent({
        contents: [{ role: 'user', parts: [{ text: rawText }] }],
      }),
      TIMEOUT_MS
    );
    const text = result?.response?.text?.();
    console.log('[nlu] Gemini response text:', text?.slice(0, 500));
    if (!text) return unknownResult('empty-response');
    const parsed = JSON.parse(text);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.intent !== 'string' ||
      typeof parsed.confidence !== 'number' ||
      typeof parsed.payload !== 'object' ||
      parsed.payload === null
    ) {
      return unknownResult('schema-mismatch: ' + JSON.stringify(parsed).slice(0, 200));
    }
    const allowed = ['add-event', 'mark-task-done', 'query-schedule', 'query-file-expiry', 'unknown'];
    if (!allowed.includes(parsed.intent)) {
      return unknownResult('bad-intent: ' + parsed.intent);
    }
    return {
      intent: parsed.intent,
      confidence: Math.max(0, Math.min(1, parsed.confidence)),
      payload: parsed.payload,
    };
  } catch (err) {
    console.error('[nlu] Gemini parse failed:', err.message, err.stack);
    return unknownResult('exception: ' + err.message);
  }
}
