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
import { extractE164FromJid, isLidJid } from './src/phone.js';
import { resolveSender, resolveSenderByMemberId } from './src/sender-resolver.js';
import { lookupLidMapping } from './src/lid-mapping.js';
import { extractAuthCode, claimAuthCode } from './src/whatsapp-auth-code.js';
import { parseMessage } from './src/nlu/gemini.js';
import { todayIsoDate } from './src/dates.js';
import { addEvent, UnlinkedMemberError } from './src/intents/add-event.js';
import { markTaskDone } from './src/intents/mark-task-done.js';
import { querySchedule } from './src/intents/query-schedule.js';
import { queryFileExpiry } from './src/intents/query-file-expiry.js';
import { queryPetInfo } from './src/intents/query-pet-info.js';
import { logBotMessage, updateBotMessageStatus } from './src/bot-message-log.js';
import { undoManager } from './src/undo.js';
import { parseTrigger, isAwake, setAwake } from './src/trigger.js';
import {
  unrecognizedSenderReply,
  unlinkedMemberReply,
  unknownIntentReply,
  internalErrorReply,
  confirmationPrompt,
  eventCancelledReply,
  taskCancelledReply,
  clarifyTimeReply,
  greetingFor,
  unknownLidOnboardingReply,
  authCodeAcceptedReply,
  authCodeExpiredReply,
  authCodeUsedReply,
  authCodeUnknownReply,
} from './src/reply-templates.js';
import { dayjs, FAMILY_TZ } from './src/dates.js';

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

// Operator-only LID lookup. Used to seed BOT_LID_MAPPING for a new family
// member without requiring them to send a first message. Calls Baileys'
// onWhatsApp() which sometimes — depending on Baileys version — surfaces
// the per-pair @lid alongside the @s.whatsapp.net jid. Gated behind
// ADMIN_SECRET so the URL alone isn't enough to enumerate phone numbers.
app.get('/admin/lookup-lid', async (req, res) => {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    return res.status(503).json({ error: 'admin endpoint disabled — set ADMIN_SECRET to enable' });
  }
  if (req.query.secret !== adminSecret) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const phone = String(req.query.phone || '').trim();
  if (!phone) return res.status(400).json({ error: 'phone query param required' });
  if (!sock || !isConnected) return res.status(503).json({ error: 'bot not connected' });
  try {
    const result = await sock.onWhatsApp(phone);
    res.json({ phone, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// Keep-alive self-ping. Render's free tier hibernates the service after
// ~15 minutes with no incoming HTTP traffic, which silently breaks the
// long-lived Baileys WebSocket and leaves the bot looking "connected" but
// unable to send messages. We hit our own public /status endpoint every
// few minutes so the idle timer never trips. SELF_PING_URL can be unset
// to disable (e.g. local dev) — only kicks in if the env var resolves to
// an https URL that's not localhost.
const SELF_PING_URL = process.env.SELF_PING_URL;
const SELF_PING_INTERVAL_MS = 10 * 60 * 1000;
if (SELF_PING_URL && /^https:\/\//.test(SELF_PING_URL)) {
  setInterval(() => {
    fetch(SELF_PING_URL).catch((err) => {
      console.warn('[self-ping] failed:', err.message);
    });
  }, SELF_PING_INTERVAL_MS);
  console.log(`[self-ping] enabled, every ${SELF_PING_INTERVAL_MS / 1000}s`);
}

// ── Message handling ───────────────────────────────────────────────────────

// Try to extract a time-of-day from a short user follow-up like "15:00",
// "ב-15:00", "ב 15:00", "בשעה 15:00" — used when we previously asked the user
// for a missing time. Returns "HH:mm" or null.
function extractTimeOfDay(text) {
  if (!text) return null;
  const m = String(text).match(/(\d{1,2})[:.\s](\d{2})/);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (isNaN(hh) || isNaN(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// Build an ISO startTime in Asia/Jerusalem from a "tomorrow"/"today" hint and
// an "HH:mm" string.
function buildStartIso({ window, hhmm }) {
  const base = window === 'tomorrow' ? dayjs().tz(FAMILY_TZ).add(1, 'day') : dayjs().tz(FAMILY_TZ);
  const [hh, mm] = hhmm.split(':').map((n) => parseInt(n, 10));
  return base.hour(hh).minute(mm).second(0).millisecond(0).format();
}

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
  if (intent === 'query-file-expiry') {
    const q = payload?.searchQuery ? `"${payload.searchQuery}"` : 'מסמך';
    return `נראה שאת שואלת מתי פג התוקף של ${q}.`;
  }
  if (intent === 'query-pet-info') {
    const p = payload?.petName ? ` של ${payload.petName}` : '';
    return `נראה שאת שואלת על פרטי חיית מחמד${p}.`;
  }
  return 'לא הצלחתי להבין את הבקשה.';
}

async function executeIntent({ sender, intent, confidence, payload, rawText, fromPhone }) {
  if (intent === 'add-event') {
    try {
      const result = await addEvent({ sender, payload });

      // Graceful path: the model produced a payload that's missing time info.
      // Don't write the event; ask the user for the missing time.
      if (result.status === 'needs-clarification') {
        await logBotMessage({
          sender,
          fromPhone,
          rawText,
          intent,
          confidence,
          payload,
          actionStatus: 'pending-confirmation',
          resultingEntityType: null,
          resultingEntityId: null,
          botReply: result.replyText,
          undoExpiresAt: null,
        });
        return {
          replyText: result.replyText,
          clarification: {
            kind: 'add-event-needs-time',
            title: result.title,
            partialPayload: result.partialPayload,
            originalRawText: rawText,
          },
        };
      }

      // Graceful path: payload was unrecognizable (missing title, etc.).
      if (result.status === 'cannot-understand') {
        await logBotMessage({
          sender,
          fromPhone,
          rawText,
          intent,
          confidence,
          payload,
          actionStatus: 'rejected',
          resultingEntityType: null,
          resultingEntityId: null,
          botReply: result.replyText,
          undoExpiresAt: null,
        });
        return { replyText: result.replyText };
      }

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

  if (intent === 'query-pet-info') {
    const result = await queryPetInfo({ sender, payload });
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

  if (intent === 'query-file-expiry') {
    const result = await queryFileExpiry({ sender, payload });
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

// Static LID → E.164 phone mapping pulled from the BOT_LID_MAPPING env
// var. Format: `lidNumber=+E164,otherLid=+E164` (the @lid suffix is
// optional). Used as a last-resort fallback when Baileys doesn't expose
// the underlying phone for a privacy-formatted JID — the operator adds
// the family's known LIDs once and the bot routes every future message
// from those LIDs to the right family member.
const STATIC_LID_MAP = (() => {
  const raw = process.env.BOT_LID_MAPPING;
  const map = new Map();
  if (!raw) return map;
  for (const entry of raw.split(',')) {
    const [lidPart, phonePart] = entry.split('=').map((s) => s?.trim());
    if (!lidPart || !phonePart) continue;
    const lidDigits = lidPart.replace(/@lid$/, '').replace(/\D/g, '');
    if (!lidDigits) continue;
    const lidJid = `${lidDigits}@lid`;
    map.set(lidJid, phonePart.startsWith('+') ? phonePart : `+${phonePart.replace(/\D/g, '')}`);
  }
  if (map.size) console.log(`[lid-map] loaded ${map.size} static mapping(s)`);
  return map;
})();

// Resolve a Baileys remoteJid to an E.164 phone, handling both classic
// `@s.whatsapp.net` (PN-format) and `@lid` (privacy-preserving Local-ID
// format used when the bot account isn't linked to the sender's account,
// which is exactly our case after switching to a dedicated bot number).
//
// Strategy for @lid:
//   1. Use the explicit `senderPn` field on msg.key if Baileys provides it
//      (newer versions do).
//   2. Fall back to `sock.onWhatsApp([jid])` which Baileys will resolve via
//      its internal LID↔PN cache once available.
async function resolveJidToPhone(msg) {
  const key = msg?.key || {};
  const jid = key.remoteJid;
  if (!jid) return null;

  const direct = extractE164FromJid(jid);
  if (direct) return direct;

  if (!isLidJid(jid)) return null;

  // 0) Static map (BOT_LID_MAPPING env var) — explicit operator-managed
  //    mapping for known senders. Tried first because it's instant and
  //    doesn't depend on Baileys version quirks.
  if (STATIC_LID_MAP.has(jid)) {
    return STATIC_LID_MAP.get(jid);
  }

  // Diagnostic: dump every field on key + selected fields from msg, so we
  // can see which one Baileys is using to convey the underlying PN in this
  // particular release.
  try {
    console.log('[lid-resolve] key dump:', JSON.stringify(key));
    console.log('[lid-resolve] msg fields:', JSON.stringify({
      participant: msg?.participant,
      participantPn: msg?.participantPn,
      pushName: msg?.pushName,
      broadcast: msg?.broadcast,
      verifiedBizName: msg?.verifiedBizName,
    }));
  } catch (e) { /* noop */ }

  // 1) senderPn / participantPn / participantAlt — names Baileys uses
  //    across different releases for the underlying PN of an @lid sender.
  const directHints = [
    key.senderPn,
    key.participantPn,
    key.participantAlt,
    msg?.participantPn,
    msg?.senderPn,
  ];
  for (const hint of directHints) {
    if (!hint) continue;
    const resolved = extractE164FromJid(hint);
    if (resolved) return resolved;
  }

  // 2) Baileys 6.7+ exposes a LID → PN cache via signalRepository.
  try {
    const lidMap = sock?.signalRepository?.lidMapping;
    if (lidMap?.getPNForLID) {
      const pn = await lidMap.getPNForLID(jid);
      if (pn) {
        const resolved = extractE164FromJid(pn);
        if (resolved) return resolved;
      }
    }
  } catch (err) {
    console.warn('[lid-resolve] lidMapping failed:', err.message);
  }

  // 3) onWhatsApp lookup — sometimes returns a PN-format jid for a LID input.
  try {
    if (sock?.onWhatsApp) {
      const results = await sock.onWhatsApp(jid);
      const hit = Array.isArray(results) ? results[0] : null;
      if (hit?.jid) {
        const fromHit = extractE164FromJid(hit.jid);
        if (fromHit) return fromHit;
      }
    }
  } catch (err) {
    console.warn('[lid-resolve] onWhatsApp failed:', err.message);
  }

  return null;
}

// Decide who's writing to the bot. Three possible outcomes:
//   - { kind: 'sender', sender, fromPhone }  — proceed with normal handling.
//   - { kind: 'reply-and-stop', reply }       — answer with this Hebrew reply
//                                                and skip NLU. Used for the
//                                                onboarding hint, code-claim
//                                                feedback, and "unknown phone"
//                                                reply.
//   - { kind: 'skip', reason }                — ignore silently (group, no JID,
//                                                no resolvable phone, etc.).
//
// `fromPhone` is used downstream as an in-process identity key (for the
// pending-confirmation map, awake-window, undo-manager). For @lid senders
// without a known phone we synthesize `lid:<jid>` so the key stays stable
// across messages from the same user.
async function resolveIncomingSender({ msg, rawText }) {
  const remoteJid = msg?.key?.remoteJid;
  if (!remoteJid) return { kind: 'skip', reason: 'no-jid' };

  // Classic PN-format JID — phone is embedded, just look the member up.
  if (!isLidJid(remoteJid)) {
    const fromPhone = await resolveJidToPhone(msg);
    if (!fromPhone) return { kind: 'skip', reason: 'phone-unresolved' };
    let sender = null;
    try {
      sender = await resolveSender(fromPhone);
    } catch (err) {
      console.error('[bot] resolveSender failed:', err.message);
    }
    if (!sender) {
      return { kind: 'reply-and-stop', reply: unrecognizedSenderReply() };
    }
    return { kind: 'sender', sender, fromPhone };
  }

  // ── @lid path ─────────────────────────────────────────────────────────
  // 1. Static env override (BOT_LID_MAPPING) — admin escape hatch, wins
  //    over everything else.
  if (STATIC_LID_MAP.has(remoteJid)) {
    const fromPhone = STATIC_LID_MAP.get(remoteJid);
    const sender = await resolveSender(fromPhone);
    if (sender) return { kind: 'sender', sender, fromPhone };
  }

  // 2. Self-service mapping written by the auth-code flow. Single Firestore
  //    get, then an in-process cache hit on subsequent messages.
  let mapping = null;
  try {
    mapping = await lookupLidMapping(remoteJid);
  } catch (err) {
    console.warn('[bot] lookupLidMapping failed:', err.message);
  }
  if (mapping) {
    const sender = await resolveSenderByMemberId(mapping.memberId);
    if (sender) {
      const fromPhone = sender.phone || `lid:${remoteJid}`;
      return { kind: 'sender', sender, fromPhone };
    }
  }

  // 3. Last-chance Baileys hints (senderPn, signalRepository, onWhatsApp).
  //    Useful for senders the bot has talked to before and where Baileys
  //    cached a PN.
  const legacyPhone = await resolveJidToPhone(msg);
  if (legacyPhone) {
    const sender = await resolveSender(legacyPhone);
    if (sender) return { kind: 'sender', sender, fromPhone: legacyPhone };
  }

  // 4. First-message claim. The user typed "קוד NNNNNN" → bind their LID.
  const code = extractAuthCode(rawText);
  if (code) {
    const result = await claimAuthCode({ lid: remoteJid, code });
    if (result.ok) {
      return { kind: 'reply-and-stop', reply: authCodeAcceptedReply() };
    }
    const reply =
      result.errorKind === 'expired'
        ? authCodeExpiredReply()
        : result.errorKind === 'used'
          ? authCodeUsedReply()
          : result.errorKind === 'internal'
            ? internalErrorReply()
            : authCodeUnknownReply();
    return { kind: 'reply-and-stop', reply };
  }

  // 5. Anything else from an unknown LID → onboarding hint.
  return { kind: 'reply-and-stop', reply: unknownLidOnboardingReply() };
}

async function handleIncomingMessage(msg) {
  if (!msg) return;
  const remoteJid = msg.key?.remoteJid;
  const fromMe = msg.key?.fromMe;
  const ownJidRaw = sock?.user?.id;
  const senderPnHint = msg.key?.senderPn || null;
  console.log('[bot:incoming]', JSON.stringify({ remoteJid, fromMe, ownJidRaw, senderPnHint, hasMsg: !!msg.message }));

  if (!remoteJid || remoteJid.endsWith('@g.us')) {
    console.log('[bot:skip] no remoteJid or group');
    return;
  }

  // CRITICAL: ignore messages we ourselves sent (the bot's own replies).
  // Without this, replying in a Note-to-self chat triggers an infinite loop
  // because the bot's reply re-enters messages.upsert as fromMe=true.
  if (fromMe && msg.key?.id && sentMessageCache.has(`${remoteJid}|${msg.key.id}`)) {
    console.log('[bot:skip] own outgoing reply');
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

  const resolution = await resolveIncomingSender({ msg, rawText });
  if (resolution.kind === 'skip') {
    console.log('[bot:skip]', { reason: resolution.reason, remoteJid });
    return;
  }
  if (resolution.kind === 'reply-and-stop') {
    console.log('[bot:reply-and-stop]', { remoteJid });
    await sock.sendMessage(remoteJid, { text: resolution.reply });
    return;
  }
  const { sender, fromPhone } = resolution;

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
    // User is mid-conversation — keep the awake window alive so a follow-up
    // after the pending resolves doesn't require re-saying the trigger.
    setAwake(fromPhone);
    // Special case: previous reply was a clarify-time prompt for an add-event.
    // If the user now sends just a time, merge it and re-attempt.
    if (pending.kind === 'add-event-needs-time') {
      const hhmm = extractTimeOfDay(rawText);
      if (hhmm) {
        pendingByPhone.delete(fromPhone);
        const partial = pending.partialPayload || {};
        // Default window is "tomorrow" since most follow-ups in this flow
        // come from messages like "פגישה עם דני מחר". The original window is
        // not always present on the partial payload, so pass it through if
        // we stashed one.
        const startIso = buildStartIso({
          window: pending.window || 'tomorrow',
          hhmm,
        });
        const fullPayload = { ...partial, startTime: startIso };
        try {
          const { replyText } = await executeIntent({
            sender,
            intent: 'add-event',
            confidence: pending.confidence ?? 0.95,
            payload: fullPayload,
            rawText: pending.originalRawText
              ? `${pending.originalRawText} | ${rawText}`
              : rawText,
            fromPhone,
          });
          await sock.sendMessage(remoteJid, { text: replyText });
        } catch (err) {
          console.error('[bot] clarify-followup failed:', err.message);
          await sock.sendMessage(remoteJid, { text: internalErrorReply() });
        }
        return;
      }
      // No time found in this message → drop the pending clarify and treat
      // the message as a fresh request.
      pendingByPhone.delete(fromPhone);
    }

    if (/^כן\.?$/.test(rawText)) {
      pendingByPhone.delete(fromPhone);
      try {
        const { replyText, clarification } = await executeIntent({
          sender,
          intent: pending.intent,
          confidence: pending.confidence,
          payload: pending.payload,
          rawText: pending.rawText,
          fromPhone,
        });
        if (clarification && clarification.kind === 'add-event-needs-time') {
          setPending(fromPhone, {
            kind: 'add-event-needs-time',
            intent: 'add-event',
            confidence: pending.confidence,
            partialPayload: clarification.partialPayload,
            window: pending.payload?.window || 'tomorrow',
            originalRawText: clarification.originalRawText,
          });
        }
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

  // Trigger handling — but no longer a *gate*. The bot now lives on a
  // dedicated number, so every incoming 1:1 message is intentional and
  // gets processed. We still detect "ג'רוויס" so that:
  //   - a bare call gets the friendly greeting
  //   - an inline trigger ("ג'רוויס תוסיף פגישה") has the prefix stripped
  //     before NLU, so Gemini sees the cleaner imperative.
  const trig = parseTrigger(rawText);
  let textToProcess = rawText;
  if (trig.matched) {
    if (trig.residual === '') {
      setAwake(fromPhone);
      await sock.sendMessage(remoteJid, { text: greetingFor(sender.displayName) });
      return;
    }
    textToProcess = trig.residual;
  }
  setAwake(fromPhone);

  // Standard NLU path
  let parsed;
  try {
    parsed = await parseMessage(textToProcess, sender.displayName, todayIsoDate());
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
      const { replyText, clarification } = await executeIntent({
        sender,
        intent: parsed.intent,
        confidence: parsed.confidence,
        payload: parsed.payload,
        rawText,
        fromPhone,
      });
      if (clarification && clarification.kind === 'add-event-needs-time') {
        // Save partial intent so the next message (a time) can complete it.
        setPending(fromPhone, {
          kind: 'add-event-needs-time',
          intent: 'add-event',
          confidence: parsed.confidence,
          partialPayload: clarification.partialPayload,
          window: parsed.payload?.window || 'tomorrow',
          originalRawText: clarification.originalRawText,
        });
      }
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

// In-memory cache of recent outgoing messages. Used by getMessage() so Baileys
// can answer WhatsApp's retry-receipts when the primary device fails to
// decrypt — the canonical fix for "Waiting for this message" on mobile.
const sentMessageCache = new Map();
function cacheOutgoing(key, msg) {
  if (!key?.id || !msg) return;
  sentMessageCache.set(`${key.remoteJid}|${key.id}`, msg);
  if (sentMessageCache.size > 500) {
    const oldest = sentMessageCache.keys().next().value;
    sentMessageCache.delete(oldest);
  }
}

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
      markOnlineOnConnect: false,
      syncFullHistory: false,
      getMessage: async (key) => {
        const hit = sentMessageCache.get(`${key.remoteJid}|${key.id}`);
        return hit?.message || { conversation: '' };
      },
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

    // Wrap sendMessage so EVERY message the bot sends is (a) prefixed with the
    // bot's identity tag — so the user can visually distinguish bot replies from
    // their own messages, especially in the Note-to-Self chat where both share
    // the same bubble color — and (b) cached for getMessage() and the loop-guard
    // in handleIncomingMessage.
    const _origSendMessage = sock.sendMessage.bind(sock);
    const BOT_PREFIX = "*ג'רוויס:* ";
    sock.sendMessage = async (jid, content, options) => {
      let outgoing = content;
      if (
        content &&
        typeof content.text === 'string' &&
        !content.text.startsWith(BOT_PREFIX)
      ) {
        outgoing = { ...content, text: BOT_PREFIX + content.text };
      }
      const result = await _origSendMessage(jid, outgoing, options);
      if (result?.key?.id) {
        cacheOutgoing(result.key, result);
      }
      return result;
    };

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      console.log('[bot:upsert]', { type, count: messages?.length });
      // Only handle 'notify' (real-time fresh messages). 'append' includes
      // messages we ourselves sent and would loop. Note-to-self from mobile
      // requires the user to have WhatsApp Desktop open as well; the linked-
      // device protocol routes only notify events to us.
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
