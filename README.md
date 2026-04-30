# Tangle WhatsApp Bot

בוט WhatsApp בעברית למערכת Tangle. מקבל הודעות חופשיות מבני המשפחה ומוסיף אירועים, מסמן משימות שבוצעו, ומסכם את היומן.

## מה הבוט יודע לעשות (גרסה 1)

- **הוספת אירוע**: "תוסיפי פגישה עם דני מחר ב-14:00 במשרד"
- **סימון משימה כבוצעה**: "הוצאתי את הכלבה לטיול"
- **שאילתת לוח זמנים**: "מה יש לי השבוע?"
- **ביטול תוך 30 שניות**: שליחת "בטל" אחרי פעולה אוטומטית מבטלת אותה
- **אישור לבקשות לא ברורות**: אם הבוט לא בטוח, הוא ישאל "כן/לא"

הבוט עונה רק לבני משפחה שמספר הטלפון שלהם רשום ב-`familyMembers`.

## דרישות מקדימות

- חשבון Render (Free tier מספיק; שים לב שהוא נכנס למצב שינה לאחר חוסר פעילות)
- חשבון Firebase עם קובץ `serviceAccount.json` (Project Settings → Service accounts → Generate new private key)
- מפתח Gemini API (Google AI Studio → Get API key)

## משתני סביבה

יש להגדיר ב-Render:

| משתנה | תיאור |
|--------|--------|
| `GEMINI_API_KEY` | מפתח API מ-Google AI Studio |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | תוכן ה-JSON המלא של ה-service account, בשורה אחת |
| `FIREBASE_DB_URL` | למשל `https://fir-e9a0b-default-rtdb.firebaseio.com` |
| `BOT_FAMILY_TIMEZONE` | ברירת מחדל `Asia/Jerusalem` |
| `PORT` | Render קובע אוטומטית |

## דיפלוי על Render

1. צור Web Service חדש מהמאגר.
2. **Build command**: `npm install`
3. **Start command**: `npm start`
4. **Instance type**: Free.
5. הדבק את משתני הסביבה למעלה תחת Environment.
6. לאחר ההפעלה הראשונה, פתח את `https://<your-service>.onrender.com/qr-view` וסרוק את ה-QR מה-WhatsApp שלך (Linked Devices → Link a device). זה נדרש פעם אחת בלבד; אחרי זה הסשן נשמר ב-Realtime DB.

## ניטור

כל הודעה ותגובה נשמרת ב-Firestore תחת `botMessages`. שדות חשובים:

- `fromPhone`, `fromMemberId`
- `rawText`, `botReply`
- `detectedIntent`, `intentConfidence`, `parsedPayload`
- `actionStatus`: `auto-executed`, `pending-confirmation`, `confirmed-and-executed`, `rejected`, `failed`, `reverted`
- `resultingEntityType`, `resultingEntityId` — מצביעים על האירוע/משימה שנוצרו

ב-Firestore Console אפשר למיין לפי `createdAt` יורד כדי לראות את ההודעות האחרונות.

## פיתוח מקומי

```bash
cp .env.example .env
# מלא ערכים אמיתיים ב-.env (אל תקמיט אותו!)
npm install
npm run dev
```

הבוט יציג QR בפעם הראשונה באתר `http://localhost:3000/qr-view`. ה-`/dev` משתמש ב-`node --watch` כדי לרענן בעת שינוי בקבצים.

## סקריפט אתחול נתונים

יש סקריפט שמכניס שתי משימות חוזרות לדוגמה למשפחת ברנס:

```bash
npm run seed
```

צריך את אותם משתני סביבה כמו לבוט. הסקריפט הוא idempotent — אם המשימה קיימת, הוא ידלג עליה.

## ארכיטקטורה בקצרה

- `index.js` — Orchestrator: Express, Baileys, ניתוב הודעות
- `src/firebase-admin.js` — אתחול Admin SDK
- `src/firebase-auth-state.js` — שמירת סשן Baileys ב-Realtime DB
- `src/phone.js` — נרמול מספרי טלפון לפורמט E.164
- `src/sender-resolver.js` — איתור בן משפחה לפי טלפון (עם cache של 5 דקות)
- `src/nlu/gemini.js` + `schema.js` — ניתוח עברית עם Gemini 2.0 Flash
- `src/intents/*.js` — מטפלי כוונות (add-event, mark-task-done, query-schedule)
- `src/undo.js` — מנגנון ביטול 30 שניות (בזיכרון בלבד)
- `src/bot-message-log.js` — כתיבה ל-`botMessages`
- `src/reply-templates.js` — כל הטקסטים בעברית
