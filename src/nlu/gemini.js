// Gemini-based Hebrew NLU for the Tangle bot.
// Calls gemini-2.0-flash with a strict JSON response schema and a Hebrew system
// prompt + few-shot examples. Returns a normalized intent/confidence/payload.

import { GoogleGenerativeAI } from '@google/generative-ai';
import { NLU_RESPONSE_SCHEMA } from './schema.js';
import { dayjs, FAMILY_TZ } from '../dates.js';

const TIMEOUT_MS = 10_000;
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

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
JSON: {"intent":"add-event","confidence":0.97,"payload":{"title":"פגישה עם דני","startTime":"${isoTime(tomorrow, 14, 0)}","endTime":"${isoTime(tomorrow, 15, 0)}","location":"במשרד","attendees":["דני"],"category":"work"}}

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
    '  • intent="add-event" → רק title, startTime, endTime, location, attendees, category. אסור window/taskTitle/forDate.',
    '  • intent="mark-task-done" → רק taskTitle, forDate. אסור title/startTime/window.',
    '  • intent="query-schedule" → רק window. אסור title/startTime/taskTitle.',
    '  • intent="unknown" → payload ריק {}.',
    '- ל-add-event: title ו-startTime הם שדות חובה. אם המשתמש לא ציין שעה ברורה — השמט לגמרי את startTime (אל תמציא!), והורד את הביטחון מתחת ל-0.9.',
    '- כל ערכי startTime/endTime חייבים להיות ISO 8601 עם offset +03:00 או +02:00 לפי השעון בישראל.',
    '- אם המשתמש אמר "מחר" — startTime חייב להיות בתאריך todayIsoDate+1 (לא היום).',
    '- אם המשתמש אמר "היום" — startTime בתאריך todayIsoDate.',
    '- אל תעתיק תאריכים מהדוגמאות. תמיד חשב מחדש לפי todayIsoDate שניתן בראש ההודעה.',
    '- forDate תמיד YYYY-MM-DD.',
    '- אל תמציא שמות אנשים שלא הוזכרו.',
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
        temperature: 0.2,
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
    const allowed = ['add-event', 'mark-task-done', 'query-schedule', 'unknown'];
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
