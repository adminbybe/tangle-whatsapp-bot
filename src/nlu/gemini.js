// Gemini-based Hebrew NLU for the Tangle bot.
// Calls gemini-2.0-flash with a strict JSON response schema and a Hebrew system
// prompt + few-shot examples. Returns a normalized intent/confidence/payload.

import { GoogleGenerativeAI } from '@google/generative-ai';
import { NLU_RESPONSE_SCHEMA } from './schema.js';

const TIMEOUT_MS = 10_000;
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

const FEW_SHOT_EXAMPLES = `
דוגמאות (today=2026-04-30, יום חמישי):

הודעה: "תוסיפי פגישה עם דני מחר ב-14:00 במשרד"
JSON: {"intent":"add-event","confidence":0.97,"payload":{"title":"פגישה עם דני","startTime":"2026-05-01T14:00:00+03:00","endTime":"2026-05-01T15:00:00+03:00","location":"במשרד","attendees":["דני"],"category":"work"}}

הודעה: "יש לי משהו עם אמא בערב"
JSON: {"intent":"add-event","confidence":0.55,"payload":{"title":"משהו עם אמא","startTime":"2026-04-30T19:00:00+03:00","endTime":"2026-04-30T20:00:00+03:00","location":null,"attendees":["אמא"],"category":"family"}}

הודעה: "תכניסי תור לרופא ביום ראשון בבוקר"
JSON: {"intent":"add-event","confidence":0.86,"payload":{"title":"תור לרופא","startTime":"2026-05-03T09:00:00+03:00","endTime":"2026-05-03T10:00:00+03:00","location":null,"attendees":[],"category":"medical"}}

הודעה: "הוצאתי את הכלבה לטיול"
JSON: {"intent":"mark-task-done","confidence":0.95,"payload":{"taskTitle":"טיול עם הכלבה","forDate":"2026-04-30"}}

הודעה: "מה יש לי השבוע?"
JSON: {"intent":"query-schedule","confidence":0.98,"payload":{"window":"this-week"}}

הודעה: "אהלן מה קורה"
JSON: {"intent":"unknown","confidence":0.1,"payload":{}}
`;

function buildSystemPrompt(senderName, todayIsoDate) {
  return [
    `אתה עוזר משפחתי בעברית. נתח הודעה ממשתמש בשם ${senderName} שנשלחה היום (${todayIsoDate}, אזור זמן Asia/Jerusalem).`,
    'זהה את הכוונה ואת הביטחון שלך (0..1). השב רק JSON לפי הסכמה.',
    'כללים:',
    '- כל ערכי startTime/endTime חייבים להיות ISO 8601 עם offset +03:00 או +02:00 לפי השעון בישראל.',
    '- אם המשתמש אמר "מחר" — חשב לפי todayIsoDate.',
    '- אם לא ניתן לדעת בוודאות שעה — ניחוש סביר אבל הורד את הביטחון.',
    '- forDate תמיד YYYY-MM-DD.',
    '- אל תמציא שמות אנשים שלא הוזכרו.',
    '- אם ההודעה לא מתאימה לאף כוונה החזר intent="unknown".',
    FEW_SHOT_EXAMPLES,
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
