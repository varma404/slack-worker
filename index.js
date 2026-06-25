/**
 * Slack Worker - HubSpot CRM assistant powered by Claude Agent SDK
 */

const express = require('express');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { query } = require('@anthropic-ai/claude-agent-sdk');
const { App } = require('@slack/bolt');

// ─── System Prompt (CLAUDE.md) ────────────────────────────────────────────────
// Written at startup so query() picks it up via cwd: __dirname

const SARAS_CONTEXT = fs.readFileSync(path.join(__dirname, 'saras_context.md'), 'utf8');

const CLAUDE_MD = `You are a HubSpot CRM assistant for Saras Analytics. Responses are shown in Slack.

${SARAS_CONTEXT}
${process.env.BUSINESS_CONTEXT ? `\nADDITIONAL CONTEXT:\n${process.env.BUSINESS_CONTEXT}\n` : ''}
SCOPE RESTRICTION:
You ONLY answer questions about HubSpot CRM data — deals, contacts, companies, pipelines, or Saras's sales and marketing activities.
If a question is unrelated to HubSpot CRM (e.g. general company strategy, coding help, weather, internal ops tools, personal questions), respond with a brief, professional out-of-scope message. Keep it friendly, 2–3 sentences. Do NOT call any tools for out-of-scope questions.

TOOL SELECTION RULES:
- For ANY question involving BOTH deals AND company properties (ICP status, company name, industry, revenue, etc.) → use get_deals_with_company_properties. This is a single batch call. Do NOT use get_associations one-by-one for this.
- Use search_objects / search_deals for deal-only queries with no company property filtering.
- Use get_associations only when you need a one-off relationship lookup for a single record.

RESPONSE RULES:
- Call all tools silently — zero text output while fetching data
- Only produce text ONCE as your final answer, using this exact structure:

*Answer:* <the direct result — count, list, or value>

*Filters applied:*
• <filter 1>
• <filter 2>

*Notes:* <only if something important needs flagging — skip if nothing to flag>

- Do NOT narrate your reasoning, show intermediate checks, or list records you rejected
- Do NOT show ✅ / ❌ per record — only show records that matched
- If listing matched records, show: name, stage, amount, and any other directly relevant fields

SLACK FORMATTING RULES — follow strictly:
- Bold: *text* (single asterisk, NOT double **)
- Bullet lists: start lines with •
- Numbered lists: 1. 2. 3.
- NO markdown tables (no | pipes) — use numbered lists instead
- NO ## or # headers — use *Bold Title* on its own line

Always use tools to fetch actual data — never say you "don't have access".`;

fs.writeFileSync(path.join(__dirname, 'CLAUDE.md'), CLAUDE_MD);
console.log('[WORKER] CLAUDE.md written');

// ─── Express App ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

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

// ─── Thread Session Store ─────────────────────────────────────────────────────
// Maps thread keys to Agent SDK session IDs for persistent context across messages.

const threadSessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getThreadKey(event) {
  // Thread reply: key on the thread root so all replies share a session
  if (event.thread_ts) return `${event.channel}:${event.thread_ts}`;
  // DM or top-level mention: key on user+channel so DMs stay isolated per user
  return `${event.channel}:${event.user || event.ts}`;
}

function getSessionId(threadKey) {
  const entry = threadSessions.get(threadKey);
  if (!entry || Date.now() - entry.ts > SESSION_TTL_MS) {
    threadSessions.delete(threadKey);
    return null;
  }
  return entry.id;
}

function storeSessionId(threadKey, sessionId) {
  threadSessions.set(threadKey, { id: sessionId, ts: Date.now() });
}

// ─── Status Message Phrases ───────────────────────────────────────────────────

const TOOL_STATUS = {
  get_object_properties: 'Reading the CRM schema...',
  search_objects: 'Querying the pipeline...',
  search_contacts: 'Searching for contacts...',
  search_deals: 'Querying the pipeline...',
  get_deals_with_company_properties: 'Pulling deals and accounts...',
  get_associations: 'Connecting the dots...',
  get_contact: 'Fetching the record...',
  get_deal: 'Fetching the record...',
  get_company: 'Fetching the record...',
};

const FALLBACK_STATUSES = [
  'Negotiating with HubSpot...',
  'Herding the data...',
  'Crunching the numbers...',
  'Consulting the CRM oracle...',
];
let fallbackIdx = 0;

// ─── Slack Block Builder ──────────────────────────────────────────────────────

function buildAnswerBlocks(answer) {
  const blocks = [];
  let remaining = answer;
  while (remaining.length > 2900) {
    const split = remaining.lastIndexOf('\n', 2900);
    const cutAt = split > 1000 ? split : 2900;
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: remaining.slice(0, cutAt) } });
    remaining = remaining.slice(cutAt).trimStart();
  }
  if (remaining) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: remaining } });
  return blocks;
}

// ─── Slack HTTP Client ────────────────────────────────────────────────────────

function slackRequest(endpoint, payload, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const options = {
      hostname: 'slack.com',
      port: 443,
      path: `/api${endpoint}`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (!parsed.ok) reject(new Error(`Slack error: ${parsed.error}`));
          else resolve(parsed);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── Claude via Agent SDK ─────────────────────────────────────────────────────

async function askClaude(question, threadKey, statusUpdater = async () => {}) {
  await statusUpdater('Analyzing your request...');

  const sessionId = getSessionId(threadKey);
  if (sessionId) console.log(`[CLAUDE] Resuming session ${sessionId} for ${threadKey}`);
  else console.log(`[CLAUDE] New session for ${threadKey}`);

  const options = {
    cwd: __dirname,
    permissionMode: 'bypassPermissions',
    allowedTools: [
      'mcp__hubspot__get_object_properties',
      'mcp__hubspot__search_objects',
      'mcp__hubspot__search_contacts',
      'mcp__hubspot__search_deals',
      'mcp__hubspot__get_deals_with_company_properties',
      'mcp__hubspot__get_associations',
      'mcp__hubspot__get_contact',
      'mcp__hubspot__get_deal',
      'mcp__hubspot__get_company'
    ],
    mcpServers: {
      hubspot: {
        command: 'node',
        args: [path.join(__dirname, 'hubspot-mcp-server.js')],
        env: { HUBSPOT_PRIVATE_APP_TOKEN: process.env.HUBSPOT_PRIVATE_APP_TOKEN }
      }
    },
    ...(sessionId ? { resume: sessionId } : {})
  };

  let answer = null;

  try {
    for await (const message of query({ prompt: question, options })) {
      // Capture session ID from init message for thread continuity
      if (message.type === 'system' && message.subtype === 'init') {
        const sid = message.session_id || message.data?.session_id;
        if (sid) {
          storeSessionId(threadKey, sid);
          console.log(`[CLAUDE] Session ${sid} stored`);
        }
      }

      // Update status when Claude calls a HubSpot tool
      if (message.type === 'assistant') {
        const content = Array.isArray(message.message?.content) ? message.message.content : [];
        for (const block of content) {
          if (block.type === 'tool_use') {
            const shortName = block.name.replace('mcp__hubspot__', '');
            const statusText = TOOL_STATUS[shortName] || FALLBACK_STATUSES[fallbackIdx++ % FALLBACK_STATUSES.length];
            console.log(`[CLAUDE] Tool: ${block.name}`);
            await statusUpdater(statusText);
          }
        }
      }

      // Final answer
      if (message.type === 'result') {
        answer = message.result;
      }
    }
  } catch (err) {
    // If session resume fails (e.g. session file gone after Railway restart), retry fresh
    if (sessionId && (err.message?.includes('session') || err.message?.includes('resume') || err.message?.includes('not found'))) {
      console.warn(`[CLAUDE] Session resume failed (${err.message}), retrying fresh`);
      threadSessions.delete(threadKey);
      return askClaude(question, threadKey, statusUpdater);
    }
    throw err;
  }

  return answer || 'No response received.';
}

function trimToAnswer(text) {
  const match = text.match(/(\*Answer:|Answer:)/);
  return match ? text.slice(match.index) : text;
}

// ─── Event Processor ──────────────────────────────────────────────────────────

async function processEvent(event, slackToken) {
  console.log('[PROCESS] event:', event.type, 'channel:', event.channel);

  const isMention = event.type === 'app_mention';
  const isDM = event.type === 'message' && event.channel_type === 'im';
  if (!isMention && !isDM) return;

  const question = event.text?.replace(/<@[A-Z0-9]+>/g, '').trim();
  if (!question) return;

  console.log('[PROCESS] Question:', question);

  const threadKey = getThreadKey(event);
  const hasSession = !!getSessionId(threadKey);

  // Skip response cache for context-aware follow-ups (their answer depends on thread history)
  const cacheKey = `${event.user || ''}:${event.channel}:${question.toLowerCase()}`;
  if (!hasSession) {
    const cached = getCached(cacheKey);
    if (cached) {
      console.log('[PROCESS] Cache hit');
      const blocks = buildAnswerBlocks(cached.answer);
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_⚡ Cached result_' }] });
      await slackRequest('/chat.postMessage', {
        channel: event.channel,
        thread_ts: event.thread_ts || event.ts,
        text: cached.answer.slice(0, 200),
        blocks
      }, slackToken).catch(err => console.error('[SLACK] Failed to post cached answer:', err.message));
      return;
    }
  }

  // Post status message
  let statusTs = null;
  try {
    const statusMsg = await slackRequest('/chat.postMessage', {
      channel: event.channel,
      thread_ts: event.thread_ts || event.ts,
      text: 'Analyzing your request...'
    }, slackToken);
    statusTs = statusMsg.ts;
  } catch (err) {
    console.error('[PROCESS] Failed to post status:', err.message);
  }

  async function statusUpdater(text) {
    if (!statusTs) return;
    await slackRequest('/chat.update', {
      channel: event.channel,
      ts: statusTs,
      text
    }, slackToken).catch(() => {});
  }

  let answer;
  try {
    answer = trimToAnswer(await askClaude(question, threadKey, statusUpdater));
  } catch (err) {
    console.error('[PROCESS] Claude error:', err.message);
    const raw = err.message || '';
    const limitMatch = raw.match(/you have reached your specified workspace api usage limits[^]*/i);
    if (limitMatch) {
      const detail = raw.match(/You will regain access[^".]*/i);
      answer = `*API Usage Limit Reached*\n${detail ? detail[0] + '.' : 'Monthly API quota exhausted.'}\nPlease contact your Anthropic account admin to increase the limit.`;
    } else {
      answer = `*Error:* ${raw}`;
    }
  }

  // Cache fresh questions (no active session = standalone query)
  if (!hasSession) setCache(cacheKey, answer);

  const blocks = buildAnswerBlocks(answer);

  if (statusTs) {
    await slackRequest('/chat.delete', {
      channel: event.channel,
      ts: statusTs
    }, slackToken).catch(err => console.error('[SLACK] Failed to delete status:', err.message));
  }

  await slackRequest('/chat.postMessage', {
    channel: event.channel,
    thread_ts: event.thread_ts || event.ts,
    text: answer.slice(0, 200),
    blocks
  }, slackToken).catch(err => console.error('[SLACK] Failed to post answer:', err.message));

  // Log Q+A to logging channel (fire-and-forget)
  const logChannel = process.env.LOG_CHANNEL_ID;
  if (logChannel && event.user) {
    const answerSnippet = answer.replace(/\*/g, '').slice(0, 300);
    slackRequest('/chat.postMessage', {
      channel: logChannel,
      text: `*Q* from <@${event.user}> in <#${event.channel}>\n*Question:* ${question}\n*Answer:* ${answerSnippet}${answer.length > 300 ? '...' : ''}`,
      unfurl_links: false,
      unfurl_media: false
    }, slackToken).catch(() => {});
  }

  console.log('[PROCESS] Done');
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({
  status: 'ok',
  env: {
    hasHubspot: !!process.env.HUBSPOT_PRIVATE_APP_TOKEN,
    hasAnthropic: !!process.env.ANTHROPIC_API_KEY,
    hasSlackToken: !!process.env.SLACK_BOT_TOKEN
  }
}));

app.post('/process', async (req, res) => {
  const workerSecret = process.env.WORKER_SECRET;
  if (workerSecret && req.headers['x-worker-secret'] !== workerSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { event, token } = req.body;
  if (!event || !token) return res.status(400).json({ error: 'Missing event or token' });

  res.status(200).json({ queued: true });

  processEvent(event, token).catch(err => console.error('[WORKER ERROR]', err.message));
});

app.listen(PORT, () => console.log(`[WORKER] Listening on port ${PORT}`));

// ─── Slack Socket Mode (bolt) ─────────────────────────────────────────────────
// Only starts when SLACK_APP_TOKEN is set. Without it, Vercel webhook handles
// incoming events — making the token the single kill switch for rollback.

const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

slackApp.event('app_mention', async ({ event }) => {
  await processEvent(event, process.env.SLACK_BOT_TOKEN)
    .catch(err => console.error('[BOLT] app_mention error:', err.message));
});

slackApp.event('message', async ({ event }) => {
  if (event.channel_type === 'im' && !event.bot_id && !event.subtype) {
    await processEvent(event, process.env.SLACK_BOT_TOKEN)
      .catch(err => console.error('[BOLT] message error:', err.message));
  }
});

if (process.env.SLACK_APP_TOKEN) {
  slackApp.start()
    .then(() => console.log('[WORKER] Socket Mode active'))
    .catch(err => console.error('[WORKER] Socket Mode failed to start:', err.message));
} else {
  console.log('[WORKER] No SLACK_APP_TOKEN — Socket Mode disabled, using Vercel webhook');
}
