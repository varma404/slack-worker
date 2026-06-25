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

function buildSystemPrompt() {
  const today = new Date().toISOString().split('T')[0];
  return `You are a HubSpot CRM assistant for Saras Analytics. Responses are shown in Slack.

TODAY'S DATE: ${today}
When the user says "this month", "last 3 months", "this year", "last quarter", etc., calculate the exact date range relative to ${today}. Never fall back to dates from your training data.

=== CRITICAL QUERY RULES ===

MONTHLY/PERIODIC BREAKDOWNS:
When the user asks for a breakdown by month, quarter, week, or any time period:
- Make ONE SEPARATE count_objects call PER time period with tight GTE/LTE date filters.
- NEVER fetch a wide date range in one query and then try to group records by reading date values. You WILL miscount.
- Example: "ICP MQLs by month for Apr–Jun" → 3 separate count_objects calls, one per month.
- Report the "total" field from each query response as the count — do NOT manually tally records from a results array.

FOLLOW-UP CORRECTIONS:
When the user challenges a number or says your answer is wrong:
1. Re-read the ORIGINAL question in this thread to identify ALL filters that were applied.
2. Re-query with the EXACT SAME filters. Never drop, simplify, or broaden filters to investigate.
3. If the count differs, state the correction and show the records. If it matches, show the individual records for the user to verify.
4. If the user clarifies a missing filter (e.g. "from marketing"), add it and re-query — do not argue.

NEVER SPECULATE ABOUT HUBSPOT INTERNALS:
- Do NOT invent explanations about how HubSpot stores values (boolean vs string, internal encodings, sync delays, workflow configs) to rationalize unexpected results.
- If your count differs from what the user expects, the ONLY valid response is to re-query and show the actual records with their property values.
- Say "Let me re-check the data" — never "The discrepancy is because HubSpot stores..."

ICP PROPERTY NAMES — use the exact name for each object:
• Company: is_the_company_icp_ (one trailing underscore)
• Contact: is_the_company_icp (no trailing underscore)
• Deal: is_the_company_icp__ (two trailing underscores)
Never use 'icp', 'hs_ideal_customer_profile', or any other variant.

SCOPE RESTRICTION:
You ONLY answer questions about HubSpot CRM data — deals, contacts, companies, pipelines, or Saras's sales and marketing activities.
If a question is unrelated to HubSpot CRM (e.g. general company strategy, coding help, weather, internal ops tools, personal questions), respond with a brief, professional out-of-scope message. Keep it friendly, 2–3 sentences. Do NOT call any tools for out-of-scope questions.

TOOL SELECTION RULES:
- For "how many" / count questions, use count_objects — it returns exact totals without fetching records. For breakdowns by time period, call count_objects once per period.
- For ANY question involving BOTH deals AND company properties (ICP status, company name, industry, revenue, etc.) → use get_deals_with_company_properties. This is a single batch call. Do NOT use get_associations one-by-one for this.
- Use search_objects / search_deals for deal-only queries with no company property filtering.
- Use get_associations only when you need a one-off relationship lookup for a single record.
- NEVER use the BETWEEN operator for ANY range query (dates, numbers, revenue, etc.) — it is unreliable on HubSpot properties. Instead, use two separate filters: GTE for the lower bound and LTE for the upper bound.
- For multi-value matching (e.g. country = US or CA or UK), use the IN operator with comma-separated values: { property: "country", operator: "IN", value: "United States,Canada,United Kingdom" }. Use full property values as stored in HubSpot.
- When a user asks "why is X not in the list?", ALWAYS look up the record first using get_company/get_contact/get_deal, then compare its properties against the filters. Never guess or speculate before checking.
- If a search returns 0 results and the user expected data, re-check your filters: verify the property name with get_object_properties, confirm you used GTE+LTE (not BETWEEN), and make sure you searched the correct object type (Company for MQLs, not Contact).
- When a search returns truncated: true and after is not null, you CAN call the same tool with the after cursor to get the next page — but only if the user's question requires all records. For counts, use count_objects instead.
- If a tool response includes "truncated": true, tell the user the exact total count and that you're showing a subset. Suggest narrowing filters if the total is large.

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
- For result sets with more than 20 records, show a grouped summary (e.g. by stage, country, or source) with counts. Offer to list individual records if the user wants.

SLACK FORMATTING RULES — follow strictly:
- Bold: *text* (single asterisk, NOT double **)
- Bullet lists: start lines with •
- Numbered lists: 1. 2. 3.
- NO markdown tables (no | pipes) — use numbered lists instead
- NO ## or # headers — use *Bold Title* on its own line

Always use tools to fetch actual data — never say you "don't have access".

=== SARAS BUSINESS CONTEXT ===
${SARAS_CONTEXT}
${process.env.BUSINESS_CONTEXT ? `\nADDITIONAL CONTEXT:\n${process.env.BUSINESS_CONTEXT}\n` : ''}`;
}

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

// ─── Thread Lock ─────────────────────────────────────────────────────────────

const threadLocks = new Map();

function withThreadLock(threadKey, fn) {
  const prev = threadLocks.get(threadKey) || Promise.resolve();
  const current = prev.then(fn, fn);
  threadLocks.set(threadKey, current);
  current.finally(() => {
    if (threadLocks.get(threadKey) === current) threadLocks.delete(threadKey);
  });
  return current;
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
  count_objects: 'Counting records...',
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
      max_tokens: 16000,
      thinking: { type: 'enabled', budget_tokens: 5000 },
      system: buildSystemPrompt(),
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

  if (isDuplicate(event)) {
    console.log('[PROCESS] Duplicate event, skipping');
    return;
  }

  const question = event.text?.replace(/<@[A-Z0-9]+>/g, '').trim();
  if (!question) return;

  console.log('[PROCESS] Question:', question);

  const threadKey = getThreadKey(event);

  await withThreadLock(threadKey, async () => {
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
    } finally {
      if (statusTs) {
        await slackRequest('/chat.delete', {
          channel: event.channel,
          ts: statusTs
        }, slackToken).catch(err => console.error('[SLACK] Failed to delete status:', err.message));
      }
    }

    if (!hasHistory) setCache(cacheKey, answer);

    const blocks = buildAnswerBlocks(answer);

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
  });
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
  if (process.env.SLACK_APP_TOKEN) {
    return res.status(410).json({ error: 'Socket Mode active — webhook disabled' });
  }

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
    processEvent(event, process.env.SLACK_BOT_TOKEN)
      .catch(err => console.error('[BOLT] app_mention error:', err.message));
  });

  slackApp.event('message', async ({ event }) => {
    if (event.channel_type === 'im' && !event.bot_id && !event.subtype) {
      processEvent(event, process.env.SLACK_BOT_TOKEN)
        .catch(err => console.error('[BOLT] message error:', err.message));
    }
  });

  slackApp.start()
    .then(() => console.log('[WORKER] Socket Mode active'))
    .catch(err => console.error('[WORKER] Socket Mode failed to start:', err.message));
} else {
  console.log('[WORKER] No SLACK_APP_TOKEN — Socket Mode disabled, using Vercel webhook');
}
