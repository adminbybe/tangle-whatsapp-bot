// Tangle WhatsApp bot — Hebrew family-management orchestrator.
// Boots Baileys, persists session in Firebase Realtime DB, parses incoming
// Hebrew messages with Gemini, dispatches to intent handlers, and offers undo.

import 'dotenv/config';

import * as baileys from '@whiskeysockets/baileys';
const { makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = baileys;
import { Boom } from '@hapi/boom';
import pino from 'pino';
import QRCode from 'qrcode';
import express from 'express';
import cors from 'cors';

import { useFirebaseAuthState, clearAuthState } from './src/firebase-auth-state.js';
import { extractE164FromJid } from './src/phone.js';
import { resolveSender } from './src/sender-resolver.js';
import { parseMessage } from './src/nlu/gemini.js';
import { todayIsoDate } from './src/dates.js';
import { addEvent, UnlinkedMemberError } from './src/intents/add-event.js';
import { markTaskDone } from './src/intents/mark-task-done.js';
import { querySchedule } from './src/intents/query-schedule.js';
import { logBotMessage, updateBotMessageStatus } from './src/bot-message-log.js';
import { undoManager } from './src/undo.js';
import {
  unrecognizedSenderReply,
  unlinkedMemberReply,
  unknownIntentReply,
  internalErrorReply,
  confirmationPrompt,
  eventCancelledReply,
  taskCancelledReply,
} from './src/reply-templates.js';

const API_PORT = process.env.PORT || 3000;
const CONFIDENCE_THRESHOLD = 0.9;
const UNDO_TTL_MS = 30_000;
const PENDING_TTL_MS = 60_000;

// In-memory pending-confirmation map: phone -> { intent, payload, expiresAt }
const pendingByPhone = new Map();

function setPending(phone, entry) {
  pendingByPhone.set(phone, { ...entry, expiresAt: Date.now() + PENDING_TTL_MS });
}
function takePending(phone) {
  const e = pendingByPhone.get(phone);
  if (!e) return null;
  pendingByPhone.delete(phone);
  if (e.expiresAt < Date.now()) return null;
  return e;
}

// ── HTTP server (status / QR view / send / logout) ─────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

let sock = null;
let isConnected = false;
let lastQR = null;

app.get('/status', (req, res) => {
  res.json({ connected: isConnected });
});

app.get('/qr', (req, res) => {
  if (isConnected) return res.json({ connected: true, qr: null });
  res.json({ connected: false, qr: lastQR });
});

app.get('/qr-view', (req, res) => {
  if (isConnected) {
    return res.send(
      '<h2 style="font-family:sans-serif;text-align:center;margin-top:80px">הבוט מחובר</h2>'
    );
  }
  if (!lastQR) {
    return res.send(
      '<h2 style="font-family:sans-serif;text-align:center;margin-top:80px">ממתין ל-QR... רענני בעוד 10 שניות</h2><script>setTimeout(()=>location.reload(),10000)</script>'
    );
  }
  res.send(
    `<!DOCTYPE html><html><body style="display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f5f5f5;flex-direction:column;font-family:sans-serif">
      <h2>סרקי כדי לחבר WhatsApp</h2>
      <img src="${lastQR}" style="width:300px;height:300px;border:8px solid white;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.15)"/>
      <p style="color:#888;margin-top:16px">QR תקף לכ-60 שניות. רענני אם פג תוקפו.</p>
      <script>setTimeout(()=>location.reload(),55000)</script>
    </body></html>`
  );
});

app.post('/logout', async (req, res) => {
  try {
    isConnected = false;
    lastQR = null;
    if (sock) {
      try {
        await sock.logout();
      } catch (e) {
        /* noop */
      }
    }
    await clearAuthState();
    res.json({ success: true });
    setTimeout(() => process.exit(1), 1000);
  } catch (e) {
    res.json({ success: false, error: e.message });
    setTimeout(() => process.exit(1), 1000);
  }
});

app.listen(API_PORT, () => {
  console.log(`שרת API פועל על פורט ${API_PORT}`);
});

// ── Message handling ───────────────────────────────────────────────────────

function intentSummaryHebrew(intent, payload) {
  if (intent === 'add-event') {
    return `נראה שאת מבקשת להוסיף אירוע: "${payload?.title || ''}".`;
  }
  if (intent === 'mark-task-done') {
    return `נראה שאת מסמנת שעשית: "${payload?.taskTitle || ''}".`;
  }
  if (intent === 'query-schedule') {
    return 'נראה שאת שואלת על האירועים שלך.';
  }
  return 'לא הצלחתי להבין את הבקשה.';
}

async function executeIntent({ sender, intent, confidence, payload, rawText, fromPhone }) {
  if (intent === 'add-event') {
    try {
      const result = await addEvent({ sender, payload });
      const undoExpiresAt = new Date(Date.now() + UNDO_TTL_MS);
      const botMessageId = await logBotMessage({
        sender,
        fromPhone,
        rawText,
        intent,
        confidence,
        payload,
        actionStatus: 'auto-executed',
        resultingEntityType: 'event',
        resultingEntityId: result.eventId,
        botReply: result.replyText,
        undoExpiresAt,
      });
      undoManager.register({
        token: result.undoToken,
        phone: fromPhone,
        entityType: 'event',
        entityRef: result.eventRef,
        botMessageId,
        entityTitle: result.eventTitle,
        ttlMs: UNDO_TTL_MS,
      });
      return { replyText: result.replyText };
    } catch (err) {
      if (err instanceof UnlinkedMemberError) {
        await logBotMessage({
          sender,
          fromPhone,
          rawText,
          intent,
          confidence,
          payload,
          actionStatus: 'failed',
          resultingEntityType: null,
          resultingEntityId: null,
          botReply: unlinkedMemberReply(),
          undoExpiresAt: null,
        });
        return { replyText: unlinkedMemberReply() };
      }
      throw err;
    }
  }

  if (intent === 'mark-task-done') {
    try {
      const result = await markTaskDone({ sender, payload });
      const undoExpiresAt = new Date(Date.now() + UNDO_TTL_MS);
      const botMessageId = await logBotMessage({
        sender,
        fromPhone,
        rawText,
        intent,
        confidence,
        payload,
        actionStatus: 'auto-executed',
        resultingEntityType: result.entityType,
        resultingEntityId: result.entityId,
        botReply: result.replyText,
        undoExpiresAt,
      });
      undoManager.register({
        token: result.undoToken,
        phone: fromPhone,
        entityType: result.entityType,
        entityRef: result.entityRef,
        botMessageId,
        entityTitle: result.entityTitle,
        ttlMs: UNDO_TTL_MS,
      });
      return { replyText: result.replyText };
    } catch (err) {
      if (err instanceof UnlinkedMemberError) {
        await logBotMessage({
          sender,
          fromPhone,
          rawText,
          intent,
          confidence,
          payload,
          actionStatus: 'failed',
          resultingEntityType: null,
          resultingEntityId: null,
          botReply: unlinkedMemberReply(),
          undoExpiresAt: null,
        });
        return { replyText: unlinkedMemberReply() };
      }
      throw err;
    }
  }

  if (intent === 'query-schedule') {
    const result = await querySchedule({ sender, payload });
    await logBotMessage({
      sender,
      fromPhone,
      rawText,
      intent,
      confidence,
      payload,
      actionStatus: 'auto-executed',
      resultingEntityType: null,
      resultingEntityId: null,
      botReply: result.replyText,
      undoExpiresAt: null,
    });
    return { replyText: result.replyText };
  }

  // unknown
  await logBotMessage({
    sender,
    fromPhone,
    rawText,
    intent: 'unknown',
    confidence,
    payload,
    actionStatus: 'rejected',
    resultingEntityType: null,
    resultingEntityId: null,
    botReply: unknownIntentReply(),
    undoExpiresAt: null,
  });
  return { replyText: unknownIntentReply() };
}

async function handleIncomingMessage(msg) {
  if (!msg) return;
  const remoteJid = msg.key?.remoteJid;
  const fromMe = msg.key?.fromMe;
  const ownJidRaw = sock?.user?.id;
  console.log('[bot:incoming]', JSON.stringify({ remoteJid, fromMe, ownJidRaw, hasMsg: !!msg.message }));

  if (!remoteJid || remoteJid.endsWith('@g.us')) {
    console.log('[bot:skip] no remoteJid or group');
    return;
  }

  // Allow "Note to self" — when the user messages their own number, the chat
  // sends fromMe=true with remoteJid === own JID. Reject other fromMe messages
  // (we don't want to react to outgoing chats with other people).
  if (fromMe) {
    const ownJid = ownJidRaw?.split(':')[0]?.split('@')[0];
    const ownJidFull = ownJid ? `${ownJid}@s.whatsapp.net` : null;
    console.log('[bot:fromMe]', { ownJidFull, matches: remoteJid === ownJidFull });
    if (!ownJidFull || remoteJid !== ownJidFull) return;
  }

  const rawText = (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    ''
  ).trim();
  if (!rawText) return;

  const fromPhone = extractE164FromJid(remoteJid);
  if (!fromPhone) return;

  let sender = null;
  try {
    sender = await resolveSender(fromPhone);
  } catch (err) {
    console.error('[bot] resolveSender failed:', err.message);
  }

  // Unknown sender
  if (!sender) {
    const reply = unrecognizedSenderReply();
    console.warn('[bot] unknown sender message:', { fromPhone, rawText });
    await sock.sendMessage(remoteJid, { text: reply });
    return;
  }

  // Cancel ("בטל")
  if (/^בטל\s*\.?$/.test(rawText)) {
    const handle = undoManager.consume(fromPhone);
    if (!handle) {
      // Nothing to cancel
      await sock.sendMessage(remoteJid, { text: 'אין פעולה אחרונה לביטול.' });
      return;
    }
    try {
      await undoManager.revert(handle);
      const reply =
        handle.entityType === 'event'
          ? eventCancelledReply()
          : taskCancelledReply(handle.entityTitle);
      await sock.sendMessage(remoteJid, { text: reply });
    } catch (err) {
      console.error('[bot] revert failed:', err.message);
      await sock.sendMessage(remoteJid, { text: internalErrorReply() });
    }
    return;
  }

  // Pending confirmation reply
  const pending = pendingByPhone.get(fromPhone);
  if (pending && pending.expiresAt >= Date.now()) {
    if (/^כן\.?$/.test(rawText)) {
      pendingByPhone.delete(fromPhone);
      try {
        const { replyText } = await executeIntent({
          sender,
          intent: pending.intent,
          confidence: pending.confidence,
          payload: pending.payload,
          rawText: pending.rawText,
          fromPhone,
        });
        await sock.sendMessage(remoteJid, { text: replyText });
      } catch (err) {
        console.error('[bot] confirm-execute failed:', err.message);
        await sock.sendMessage(remoteJid, { text: internalErrorReply() });
      }
      return;
    }
    if (/^לא\.?$/.test(rawText)) {
      pendingByPhone.delete(fromPhone);
      if (pending.botMessageId) {
        try {
          await updateBotMessageStatus(pending.botMessageId, 'rejected');
        } catch (e) {
          /* noop */
        }
      }
      await sock.sendMessage(remoteJid, { text: 'בסדר, ביטלתי את הבקשה.' });
      return;
    }
    // anything else → fall through, treat as a new message and clear pending
    pendingByPhone.delete(fromPhone);
  }

  // Standard NLU path
  let parsed;
  try {
    parsed = await parseMessage(rawText, sender.displayName, todayIsoDate());
  } catch (err) {
    console.error('[bot] parseMessage threw:', err.message);
    parsed = { intent: 'unknown', confidence: 0, payload: {} };
  }

  // Check unlinked-member up front for write intents (so we don't ask for confirmation
  // on something we can't execute anyway).
  const isWriteIntent = parsed.intent === 'add-event' || parsed.intent === 'mark-task-done';
  if (isWriteIntent && !sender.linkedUserId) {
    const reply = unlinkedMemberReply();
    try {
      await logBotMessage({
        sender,
        fromPhone,
        rawText,
        intent: parsed.intent,
        confidence: parsed.confidence,
        payload: parsed.payload,
        actionStatus: 'failed',
        resultingEntityType: null,
        resultingEntityId: null,
        botReply: reply,
        undoExpiresAt: null,
      });
    } catch (e) {
      /* noop */
    }
    await sock.sendMessage(remoteJid, { text: reply });
    return;
  }

  if (parsed.intent === 'unknown') {
    try {
      await executeIntent({
        sender,
        intent: 'unknown',
        confidence: parsed.confidence,
        payload: parsed.payload,
        rawText,
        fromPhone,
      });
    } catch (e) {
      /* logging best-effort */
    }
    await sock.sendMessage(remoteJid, { text: unknownIntentReply() });
    return;
  }

  if (parsed.confidence >= CONFIDENCE_THRESHOLD) {
    try {
      const { replyText } = await executeIntent({
        sender,
        intent: parsed.intent,
        confidence: parsed.confidence,
        payload: parsed.payload,
        rawText,
        fromPhone,
      });
      await sock.sendMessage(remoteJid, { text: replyText });
    } catch (err) {
      console.error('[bot] execute failed:', err.message, err.stack);
      try {
        await logBotMessage({
          sender,
          fromPhone,
          rawText,
          intent: parsed.intent,
          confidence: parsed.confidence,
          payload: parsed.payload,
          actionStatus: 'failed',
          resultingEntityType: null,
          resultingEntityId: null,
          botReply: internalErrorReply(),
          undoExpiresAt: null,
        });
      } catch (e) {
        /* noop */
      }
      await sock.sendMessage(remoteJid, { text: internalErrorReply() });
    }
    return;
  }

  // Low-confidence → ask for confirmation
  const summary = intentSummaryHebrew(parsed.intent, parsed.payload);
  const promptText = confirmationPrompt(summary);
  let pendingBotMessageId = null;
  try {
    pendingBotMessageId = await logBotMessage({
      sender,
      fromPhone,
      rawText,
      intent: parsed.intent,
      confidence: parsed.confidence,
      payload: parsed.payload,
      actionStatus: 'pending-confirmation',
      resultingEntityType: null,
      resultingEntityId: null,
      botReply: promptText,
      undoExpiresAt: null,
    });
  } catch (e) {
    console.error('[bot] log pending failed:', e.message);
  }
  setPending(fromPhone, {
    intent: parsed.intent,
    confidence: parsed.confidence,
    payload: parsed.payload,
    rawText,
    botMessageId: pendingBotMessageId,
  });
  await sock.sendMessage(remoteJid, { text: promptText });
}

// ── Boot Baileys ───────────────────────────────────────────────────────────

async function startBot() {
  console.log('מפעיל בוט...');
  try {
    const { state, saveCreds } = await useFirebaseAuthState();
    console.log('Firebase auth loaded');
    const { version } = await fetchLatestBaileysVersion();
    console.log('Baileys version:', version);

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'warn' }),
      browser: ['Tangle', 'Chrome', '4.0.0'],
      keepAliveIntervalMs: 30_000,
      connectTimeoutMs: 60_000,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        console.log('QR נוצר — ממתין לסריקה...');
        try {
          lastQR = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
        } catch (e) {
          /* noop */
        }
      }

      if (connection === 'open') {
        console.log('=============================================');
        console.log('הבוט מחובר ומוכן לעבודה');
        console.log('=============================================');
        isConnected = true;
        lastQR = null;
      }

      if (connection === 'close') {
        isConnected = false;
        const code =
          lastDisconnect?.error instanceof Boom
            ? lastDisconnect.error.output?.statusCode
            : 0;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        console.log('התנתק, קוד:', code, '— מחבר מחדש:', shouldReconnect);
        if (shouldReconnect) {
          setTimeout(startBot, 5000);
        } else {
          console.log('נותק מכוון — מוחק סשן...');
          await clearAuthState();
          setTimeout(startBot, 3000);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      console.log('[bot:upsert]', { type, count: messages?.length });
      if (type !== 'notify') return;
      for (const msg of messages) {
        try {
          await handleIncomingMessage(msg);
        } catch (err) {
          console.error('[bot] handleIncomingMessage error:', err.message, err.stack);
          try {
            await sock.sendMessage(msg.key.remoteJid, {
              text: internalErrorReply(),
            });
          } catch (e) {
            /* noop */
          }
        }
      }
    });
  } catch (err) {
    console.error('startBot error:', err.message, err.stack);
    setTimeout(startBot, 5000);
  }
}

startBot().catch((err) => {
  console.error('שגיאה בהפעלה:', err.message);
  setTimeout(() => process.exit(1), 5000);
});
