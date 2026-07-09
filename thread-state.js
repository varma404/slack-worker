/**
 * In-memory state for the worker: event dedup, response cache, thread
 * history, and per-thread locking. All of this dies on process restart —
 * that's a known, accepted limitation (see plan notes), not an oversight.
 */

const { log } = require('./logger');

// ─── Event Deduplication ─────────────────────────────────────────────────────

const processedEvents = new Map();
const DEDUP_TTL_MS = 60 * 1000;

function isDuplicate(event) {
  const eventId = event.client_msg_id || event.event_ts || event.ts;
  if (!eventId) return false;
  if (processedEvents.has(eventId)) return true;
  processedEvents.set(eventId, Date.now());
  if (processedEvents.size > 200) {
    const cutoff = Date.now() - DEDUP_TTL_MS;
    for (const [k, v] of processedEvents) {
      if (v < cutoff) processedEvents.delete(k);
      if (processedEvents.size <= 150) break;
    }
  }
  return false;
}

// ─── Response Cache ───────────────────────────────────────────────────────────

const responseCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

function getCached(key) {
  const e = responseCache.get(key);
  if (!e || Date.now() - e.ts > CACHE_TTL_MS) { responseCache.delete(key); return null; }
  return e;
}
function setCache(key, answer) {
  if (responseCache.size >= 500) {
    const cutoff = Date.now() - CACHE_TTL_MS / 2;
    for (const [k, v] of responseCache) {
      if (v.ts < cutoff) responseCache.delete(k);
      if (responseCache.size < 400) break;
    }
  }
  responseCache.set(key, { answer, ts: Date.now() });
}

// ─── Thread History Store ────────────────────────────────────────────────────

const threadHistory = new Map();
const HISTORY_TTL_MS = 30 * 60 * 1000;
const MAX_HISTORY_MESSAGES = 40;

function getThreadKey(event) {
  if (event.thread_ts) return `${event.channel}:${event.thread_ts}`;
  // A fresh channel mention must key on its own ts, not the user — Slack
  // sets a threaded reply's thread_ts to the parent message's own ts, so
  // this is the only value a later reply can ever match. DMs don't thread
  // ordinary back-and-forth turns at all, so they need a key that's stable
  // across the whole conversation instead — the channel id alone already
  // uniquely identifies that 1:1 (or group) DM.
  if (event.channel_type === 'im') return event.channel;
  return `${event.channel}:${event.ts}`;
}

function getThreadMessages(threadKey) {
  const entry = threadHistory.get(threadKey);
  if (!entry || Date.now() - entry.ts > HISTORY_TTL_MS) {
    threadHistory.delete(threadKey);
    return [];
  }
  return entry.messages;
}

function compressHistory(messages) {
  return messages.map((msg, i) => {
    if (i >= messages.length - 4) return msg;
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      return {
        role: 'user',
        content: msg.content.map(block => {
          if (block.type === 'tool_result') {
            try {
              const parsed = JSON.parse(block.content);
              const summary = { total: parsed.total };
              if (parsed.returned !== undefined) summary.returned = parsed.returned;
              if (parsed.truncated) summary.truncated = true;
              if (parsed.error) summary.error = parsed.error;
              return { ...block, content: JSON.stringify(summary) };
            } catch { return block; }
          }
          return block;
        })
      };
    }
    return msg;
  });
}

function isToolResultMessage(msg) {
  return msg.role === 'user' && Array.isArray(msg.content) &&
    msg.content.some(b => b.type === 'tool_result');
}

function storeThreadMessages(threadKey, messages) {
  const compressed = compressHistory(messages);
  let trimmed = compressed;
  if (compressed.length > MAX_HISTORY_MESSAGES) {
    let start = compressed.length - MAX_HISTORY_MESSAGES;
    // Never start the window on a tool_result message — that would orphan it
    // from the tool_use block in the assistant message immediately before it.
    while (start > 0 && isToolResultMessage(compressed[start])) start--;
    trimmed = compressed.slice(start);
  }
  threadHistory.set(threadKey, { messages: trimmed, ts: Date.now() });
}

function getThreadHistoryCount() {
  return threadHistory.size;
}

function clearThreadHistory() {
  const count = threadHistory.size;
  threadHistory.clear();
  return count;
}

// ─── Thread Lock ─────────────────────────────────────────────────────────────

const threadLocks = new Map();
const LOCK_TIMEOUT_MS = 120_000; // generous: ~25 iterations x (HubSpot retries + Claude latency)

// Races `fn` against a timeout so one wedged call can't block every later
// message in the same thread forever. If the timeout wins, the lock slot is
// released immediately; `fn` keeps running in the background (Node can't
// cleanly cancel an in-flight HTTPS call) but its result is discarded —
// the caller sees { __lockTimedOut: true } instead.
function withThreadLock(threadKey, fn) {
  const prev = threadLocks.get(threadKey) || Promise.resolve();
  const run = prev.then(fn, fn);

  const timeout = new Promise((resolve) => {
    const t = setTimeout(() => {
      log('ERROR', 'thread_lock_timeout', { correlation_id: threadKey });
      resolve({ __lockTimedOut: true });
    }, LOCK_TIMEOUT_MS);
    run.finally(() => clearTimeout(t));
  });

  const current = Promise.race([run, timeout]);
  // Queue position always resolves (never rejects) so the next call's
  // `prev.then(fn, fn)` fires regardless of how this one settled.
  const queuePosition = current.then(() => undefined, () => undefined);
  threadLocks.set(threadKey, queuePosition);
  queuePosition.finally(() => {
    if (threadLocks.get(threadKey) === queuePosition) threadLocks.delete(threadKey);
  });
  return current;
}

function getActiveThreadCount() {
  return threadLocks.size;
}

module.exports = {
  isDuplicate,
  getCached,
  setCache,
  getThreadKey,
  getThreadMessages,
  storeThreadMessages,
  getThreadHistoryCount,
  clearThreadHistory,
  withThreadLock,
  getActiveThreadCount,
};
