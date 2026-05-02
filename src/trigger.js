// Trigger-word gating for the Tangle bot.
// The bot stays silent unless addressed by a configured trigger word
// ("ג'רוויס" by default) or already in an "awake" window for that sender.
// State is intentionally in-memory only — if the process restarts, callers
// re-address the bot by name. Acceptable trade for "plug & forget" simplicity.

const DEFAULT_TRIGGERS = ["ג'רוויס", "ג׳רוויס", 'jarvis'];
const DEFAULT_AWAKE_SECONDS = 120;

function loadTriggers() {
  const raw = process.env.BOT_TRIGGER_WORDS;
  if (!raw) return DEFAULT_TRIGGERS;
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : DEFAULT_TRIGGERS;
}

function loadAwakeMs() {
  const raw = process.env.BOT_AWAKE_WINDOW_SECONDS;
  const n = raw ? parseInt(raw, 10) : NaN;
  const seconds = Number.isFinite(n) && n > 0 ? n : DEFAULT_AWAKE_SECONDS;
  return seconds * 1000;
}

const TRIGGERS = loadTriggers();
const AWAKE_WINDOW_MS = loadAwakeMs();

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Match: optional leading whitespace/punctuation, then a trigger,
// then either end-of-string or whitespace/punctuation. The trailing
// separator is consumed so the residual is clean.
function buildTriggerRegex(triggers) {
  const alt = triggers.map(escapeRegex).join('|');
  return new RegExp(`^[\\s,.\\-!?]*(?:${alt})(?:[\\s,.\\-!?:;]+|$)`, 'i');
}

const TRIGGER_REGEX = buildTriggerRegex(TRIGGERS);

const awakeByPhone = new Map();

export function parseTrigger(rawText) {
  if (!rawText) return { matched: false, residual: '' };
  const m = String(rawText).match(TRIGGER_REGEX);
  if (!m) return { matched: false, residual: rawText };
  const residual = rawText.slice(m[0].length).trim();
  return { matched: true, residual };
}

export function isAwake(phone) {
  if (!phone) return false;
  const expiresAt = awakeByPhone.get(phone);
  if (!expiresAt) return false;
  if (expiresAt < Date.now()) {
    awakeByPhone.delete(phone);
    return false;
  }
  return true;
}

export function setAwake(phone) {
  if (!phone) return;
  awakeByPhone.set(phone, Date.now() + AWAKE_WINDOW_MS);
}

export function clearAwake(phone) {
  if (phone) awakeByPhone.delete(phone);
}

export const _internals = { TRIGGERS, AWAKE_WINDOW_MS };
