/**
 * Slack HTTP client, message-block building, status-phrase rotation, and
 * usage/cost footer formatting. Pure and self-contained — no dependency on
 * the Claude agentic loop.
 */

const https = require('https');

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

// ─── Status Message Phrases ───────────────────────────────────────────────────

const TOOL_STATUS = {
  get_object_properties: 'Reading the CRM schema...',
  search_objects: 'Querying the pipeline...',
  get_deals_with_company_properties: 'Pulling deals and accounts...',
  get_contacts_with_company_properties: 'Pulling contacts and accounts...',
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

function getToolStatus(toolName) {
  return TOOL_STATUS[toolName] || FALLBACK_STATUSES[fallbackIdx++ % FALLBACK_STATUSES.length];
}

// ─── Usage/Cost Footer ────────────────────────────────────────────────────────

// Approximate $/M-token rates. The raw Anthropic Messages API (unlike the
// Claude Agent SDK) doesn't return a cost figure, so this is computed here.
// Update if Anthropic's published pricing changes.
const MODEL_RATES_PER_MTOK = {
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};
const DEFAULT_RATES = MODEL_RATES_PER_MTOK['claude-sonnet-4-6'];

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
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
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
  return {
    type: 'actions',
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

// NOTE: reverted from Slack's native "markdown" block back to the classic
// "section"/"mrkdwn" block — the markdown block returned "invalid_blocks"
// in production even after switching the Slack app to an AI/Agent app with
// assistant:write, confirmed via two separate live tests. Root cause still
// unconfirmed; not worth blocking answer delivery on it. Real pipe-table
// rendering is not available with mrkdwn — see SLACK FORMATTING RULES in
// the system prompt, which was reverted to single-asterisk bold to match.
function buildAnswerBlocks(answer, { skipFeedback = false, usage = null } = {}) {
  const blocks = [];
  let remaining = answer;
  while (remaining.length > 2900) {
    if (blocks.length >= 48) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_Response truncated — ask me to narrow the results._' } });
      return blocks;
    }
    const split = remaining.lastIndexOf('\n', 2900);
    const cutAt = split > 1000 ? split : 2900;
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: remaining.slice(0, cutAt) } });
    remaining = remaining.slice(cutAt).trimStart();
  }
  if (remaining) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: remaining } });
  const usageFooter = buildUsageFooter(usage);
  if (usageFooter) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: usageFooter }] });
  if (!skipFeedback) blocks.push(buildFeedbackBlock());
  return blocks;
}

module.exports = {
  slackRequest,
  buildAnswerBlocks,
  getToolStatus,
};
