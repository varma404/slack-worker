/**
 * Slack Worker - HubSpot CRM assistant powered by Claude API
 */

const express = require('express');
const https = require('https');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { App } = require('@slack/bolt');
const { TOOLS: MCP_TOOLS, executeTool } = require('./hubspot-mcp-server');

// ─── Claude Client & System Prompt ──────────────────────────────────────────

const anthropic = new Anthropic();

const SARAS_CONTEXT = fs.readFileSync(path.join(__dirname, 'saras_context.md'), 'utf8');

const SYSTEM_PROMPT = `You are a HubSpot CRM assistant for Saras Analytics. Responses are shown in Slack.

${SARAS_CONTEXT}
${process.env.BUSINESS_CONTEXT ? `\nADDITIONAL CONTEXT:\n${process.env.BUSINESS_CONTEXT}\n` : ''}
SCOPE RESTRICTION:
You ONLY answer questions about HubSpot CRM data — deals, contacts, companies, pipelines, or Saras's sales and marketing activities.
If a question is unrelated to HubSpot CRM (e.g. general company strategy, coding help, weather, internal ops tools, personal questions), respond with a brief, professional out-of-scope message. Keep it friendly, 2–3 sentences. Do NOT call any tools for out-of-scope questions.

TOOL SELECTION RULES:
- For ANY question involving BOTH deals AND company properties (ICP status, company name, industry, revenue, etc.) → use get_deals_with_company_properties. This is a single batch call. Do NOT use get_associations one-by-one for this.
- Use search_objects / search_deals for deal-only queries with no company property filtering.
- Use get_associations only when you need a one-off relationship lookup for a single record.
- For date range queries, NEVER use the BETWEEN operator — it is unreliable on HubSpot date properties. Instead, use two separate filters: GTE for the start date and LTE for the end date.

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

// Convert MCP tool format to Anthropic API format
const anthropicTools = MCP_TOOLS.map(t => ({
  name: t.name,
  description: t.description,
  input_schema: t.inputSchema,
}));

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

// ─── Thread History Store ────────────────────────────────────────────────────
// Stores conversation messages per thread for follow-up context.

const threadHistory = new Map();
const HISTORY_TTL_MS = 30 * 60 * 1000;
const MAX_HISTORY_MESSAGES = 40;

function getThreadKey(event) {
  if (event.thread_ts) return `${event.channel}:${event.thread_ts}`;
  return `${event.channel}:${event.user || event.ts}`;
}

function getThreadMessages(threadKey) {
  const entry = threadHistory.get(threadKey);
  if (!entry || Date.now() - entry.ts > HISTORY_TTL_MS) {
    threadHistory.delete(threadKey);
    return [];
  }
  return entry.messages;
}

function storeThreadMessages(threadKey, messages) {
  const trimmed = messages.length > MAX_HISTORY_MESSAGES
    ? messages.slice(-MAX_HISTORY_MESSAGES)
    : messages;
  threadHistory.set(threadKey, { messages: trimmed, ts: Date.now() });
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

// ─── Claude via Anthropic SDK ────────────────────────────────────────────────

async function askClaude(question, threadKey, statusUpdater = async () => {}) {
  await statusUpdater('Analyzing your request...');

  const history = getThreadMessages(threadKey);
  const hasHistory = history.length > 0;
  if (hasHistory) console.log(`[CLAUDE] Resuming thread ${threadKey} (${history.length} messages)`);
  else console.log(`[CLAUDE] New thread ${threadKey}`);

  const messages = [...history, { role: 'user', content: question }];

  let iterations = 0;
  while (iterations++ < 15) {
    const response = await anthropic.messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: anthropicTools,
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });

    const toolBlocks = response.content.filter(b => b.type === 'tool_use');
    if (response.stop_reason === 'end_turn' || toolBlocks.length === 0) {
      storeThreadMessages(threadKey, messages);
      const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      return text || 'No response generated.';
    }

    const toolResults = [];
    for (const block of toolBlocks) {
      const statusText = TOOL_STATUS[block.name] || FALLBACK_STATUSES[fallbackIdx++ % FALLBACK_STATUSES.length];
      console.log(`[CLAUDE] Tool: ${block.name}`);
      await statusUpdater(statusText);
      const result = await executeTool(block.name, block.input);
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  storeThreadMessages(threadKey, messages);
  return 'Reached maximum iterations — try a more specific question.';
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
  const hasHistory = getThreadMessages(threadKey).length > 0;

  const cacheKey = `${event.user || ''}:${event.channel}:${question.toLowerCase()}`;
  if (!hasHistory) {
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

  if (!hasHistory) setCache(cacheKey, answer);

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

if (process.env.SLACK_APP_TOKEN) {
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

  slackApp.start()
    .then(() => console.log('[WORKER] Socket Mode active'))
    .catch(err => console.error('[WORKER] Socket Mode failed to start:', err.message));
} else {
  console.log('[WORKER] No SLACK_APP_TOKEN — Socket Mode disabled, using Vercel webhook');
}
