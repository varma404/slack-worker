/**
 * Slack HTTP client, message-block building, status-phrase rotation, and
 * usage/cost footer formatting. Pure and self-contained — no dependency on
 * the Claude agentic loop.
 */

const https = require('https');
const { WebClient } = require('@slack/web-api');

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
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Slack timeout')); });
    req.write(data);
    req.end();
  });
}

// ─── File Upload ──────────────────────────────────────────────────────────────

// files.upload is sunset (Nov 2025); the current flow is a 3-call sequence
// (files.getUploadURLExternal -> raw POST to the returned upload_url ->
// files.completeUploadExternal). Using @slack/web-api's uploadV2 rather than
// hand-rolling that sequence over raw https — it's already a transitive
// dependency of @slack/bolt (now a direct one too) and handles the upload
// encoding correctly, which isn't worth re-implementing by hand.
const webClientCache = new Map();
function getWebClient(token) {
  if (!webClientCache.has(token)) webClientCache.set(token, new WebClient(token));
  return webClientCache.get(token);
}

async function uploadFile(filename, content, { channelId, threadTs, comment } = {}, token) {
  const client = getWebClient(token);
  return client.files.uploadV2({
    filename,
    content,
    channel_id: channelId,
    thread_ts: threadTs,
    initial_comment: comment,
  });
}

// ─── Status Message Phrases ───────────────────────────────────────────────────

const TOOL_STATUS = {
  get_object_properties: 'Reading the CRM schema...',
  search_objects: 'Querying the pipeline...',
  get_deals_with_company_properties: 'Pulling deals and accounts...',
  get_companies_with_deal_properties: 'Pulling accounts and deals...',
  get_contacts_with_company_properties: 'Pulling contacts and accounts...',
  get_companies_with_contact_properties: 'Pulling accounts and contacts...',
  get_associations: 'Connecting the dots...',
  get_contact: 'Fetching the record...',
  get_deal: 'Fetching the record...',
  get_company: 'Fetching the record...',
  count_objects: 'Counting records...',
  list_owners: 'Looking up owners...',
  send_data_as_file: 'Preparing your file...',
};

const FALLBACK_STATUSES = [
  'Negotiating with HubSpot...',
  'Herding the data...',
  'Crunching the numbers...',
  'Consulting the CRM oracle...',
];
let fallbackIdx = 0;

function getToolStatus(toolName) {
  return TOOL_STATUS[toolName] || FALLBACK_STATUSES[fallbackIdx++ % FALLBACK_STATUSES.length];
}

// ─── Usage/Cost Footer ────────────────────────────────────────────────────────

// Approximate $/M-token rates. The raw Anthropic Messages API (unlike the
// Claude Agent SDK) doesn't return a cost figure, so this is computed here.
// Update if Anthropic's published pricing changes.
const MODEL_RATES_PER_MTOK = {
  // Standard post-introductory rate. Sonnet 5 is priced at $2/$10 through
  // 2026-08-31 as an introductory discount; using the durable $3/$15 rate
  // here so this table doesn't silently go stale once the promo ends.
  'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};
const DEFAULT_RATES = MODEL_RATES_PER_MTOK['claude-sonnet-5'];

function formatTokenCount(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function estimateCostUsd(usage, model) {
  const rates = MODEL_RATES_PER_MTOK[model] || DEFAULT_RATES;
  return (
    (usage.input_tokens / 1e6) * rates.input +
    (usage.cache_read_input_tokens / 1e6) * rates.cacheRead +
    (usage.cache_creation_input_tokens / 1e6) * rates.cacheWrite +
    (usage.output_tokens / 1e6) * rates.output
  );
}

function buildUsageFooter(usage) {
  if (!usage) return null;
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
  const totalIn = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
  const cacheParts = [];
  if (usage.cache_read_input_tokens) cacheParts.push(`${formatTokenCount(usage.cache_read_input_tokens)} cache read`);
  if (usage.cache_creation_input_tokens) cacheParts.push(`${formatTokenCount(usage.cache_creation_input_tokens)} cache write`);
  let inText = `${formatTokenCount(totalIn)} tokens in`;
  if (cacheParts.length) inText += ` (${cacheParts.join(' · ')})`;
  const cost = estimateCostUsd(usage, model);
  return `${inText} · ${formatTokenCount(usage.output_tokens)} tokens out · $${cost.toFixed(4)}`;
}

// ─── Slack Block Builder ──────────────────────────────────────────────────────

function buildFeedbackBlock() {
  // Slack requires feedback_buttons to be nested in a context_actions block,
  // not a plain actions block — a plain actions block causes Slack to reject
  // the entire message with "invalid_blocks". This was the real cause of
  // every answer failing to post since this block was first added; the
  // "markdown" block investigated earlier was an unrelated red herring.
  return {
    type: 'context_actions',
    block_id: 'response_feedback',
    elements: [
      {
        type: 'feedback_buttons',
        action_id: 'feedback',
        positive_button: {
          text: { type: 'plain_text', text: 'Good Response' },
          accessibility_label: 'Submit positive feedback',
          value: 'good-feedback'
        },
        negative_button: {
          text: { type: 'plain_text', text: 'Bad Response' },
          accessibility_label: 'Submit negative feedback',
          value: 'bad-feedback'
        }
      }
    ]
  };
}

// Uses Slack's native "markdown" block (standard CommonMark, incl. real
// tables) — see SLACK FORMATTING RULES in the system prompt for the
// matching bold syntax. Previously reverted after an "invalid_blocks"
// incident, but that was actually caused by buildFeedbackBlock() using the
// wrong container block type (fixed separately) — the markdown block
// itself was never the problem. Restored to match DE Agent's approach.
// Slack's cumulative limit across all markdown blocks in one message is
// 12,000 characters; the caller (processEvent) diverts anything over that
// to a file upload before this function ever sees it, so the per-block
// chunking below only needs to keep individual blocks a reasonable size.
function buildAnswerBlocks(answer, { skipFeedback = false, usage = null } = {}) {
  const blocks = [];
  let remaining = answer;
  while (remaining.length > 2900) {
    if (blocks.length >= 48) {
      blocks.push({ type: 'markdown', text: '_Response truncated — ask me to narrow the results._' });
      return blocks;
    }
    const split = remaining.lastIndexOf('\n', 2900);
    const cutAt = split > 1000 ? split : 2900;
    blocks.push({ type: 'markdown', text: remaining.slice(0, cutAt) });
    remaining = remaining.slice(cutAt).trimStart();
  }
  if (remaining) blocks.push({ type: 'markdown', text: remaining });
  const usageFooter = buildUsageFooter(usage);
  if (usageFooter) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: usageFooter }] });
  if (!skipFeedback) blocks.push(buildFeedbackBlock());
  return blocks;
}

module.exports = {
  slackRequest,
  uploadFile,
  buildAnswerBlocks,
  getToolStatus,
  estimateCostUsd,
};
