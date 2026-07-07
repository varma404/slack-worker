/**
 * Slack Worker - HubSpot CRM assistant powered by Claude API
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { App } = require('@slack/bolt');
const { TOOLS: MCP_TOOLS, executeTool } = require('./hubspot-mcp-server');
const { log } = require('./logger');
const { slackRequest, uploadFile, buildAnswerBlocks, getToolStatus, estimateCostUsd } = require('./slack-client');
const {
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
} = require('./thread-state');

// ─── Startup Validation ─────────────────────────────────────────────────────
// Fail fast and loud on misconfiguration rather than silently degrading
// behavior. Socket Mode is the only supported architecture — every one of
// these is required for the process to do anything useful. Note:
// SLACK_SIGNING_SECRET is NOT required here — Bolt only enforces it for the
// default HTTP receiver's signature verification; the Socket Mode receiver
// (socketMode: true, used exclusively below) never needs it.
const REQUIRED_ENV_VARS = ['SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN', 'ANTHROPIC_API_KEY', 'HUBSPOT_PRIVATE_APP_TOKEN'];
const missingEnvVars = REQUIRED_ENV_VARS.filter(name => !process.env[name]);
if (missingEnvVars.length > 0) {
  log('ERROR', 'missing_required_env_vars', { missing: missingEnvVars });
  process.exit(1);
}

// ─── Claude Client & System Prompt ──────────────────────────────────────────

const anthropic = new Anthropic();
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
// Medium effort is enough for this deterministic, narrowly-scoped CRM
// lookup task given how prescriptive the system prompt already is —
// `high` (Sonnet 5's default) costs meaningfully more for no quality gain
// here. Adjustable via env var without a redeploy if quality suffers.
const CLAUDE_EFFORT = process.env.CLAUDE_EFFORT || 'medium';

const SARAS_CONTEXT = fs.readFileSync(path.join(__dirname, 'saras_context.md'), 'utf8');
const QUERY_PLAYBOOKS = fs.readFileSync(path.join(__dirname, 'query_playbooks.md'), 'utf8');

// Prompt caching: the static body (business rules + SARAS_CONTEXT +
// QUERY_PLAYBOOKS — several thousand tokens, byte-identical across every
// request) is cached separately from the per-request date/addendum suffix,
// which changes daily and would otherwise invalidate the whole cache if it
// were part of the same block. This was held back as a single plain string
// during the tool_use/tool_result pairing-fix soak period (see PR #1) —
// that fix has since been stable across multiple days of real production
// traffic, so it's safe to re-enable now.
function buildSystemPrompt(addendum = null) {
  const today = new Date().toISOString().split('T')[0];
  let suffix = `TODAY'S DATE: ${today}\nWhen the user says "this month", "last 3 months", "this year", "last quarter", etc., calculate the exact date range relative to ${today}. Never fall back to dates from your training data.`;
  if (addendum) suffix += `\n\n${addendum}`;
  return [
    { type: 'text', text: buildStaticPromptBody(), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: suffix },
  ];
}

function buildStaticPromptBody() {
  return `You are a HubSpot CRM assistant for Saras Analytics. Responses are shown in Slack.

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

CLARIFICATION — WHEN TO ASK INSTEAD OF ANSWERING:
Most questions have a clear best interpretation — resolve those yourself using the defaults and patterns in this prompt. Only ask a clarifying question when the ambiguity would silently change the numeric result or record set returned, AND no default below resolves it. Concretely, ask when:

1. A company/person name in the question matches more than one HubSpot record and the records are meaningfully different (different domains, different deal stages) — do NOT ask if one match is an obvious best fit (exact name match vs. partial/fuzzy match) or the question doesn't care which one it is.
2. A relative or informal time range is genuinely two-way ambiguous — e.g. "last quarter" when today is early in a quarter (could mean the quarter just ended or the one before), or "this week" said on a Monday close to a month boundary. Do NOT ask about "this month", "last 3 months", "this year" — those resolve unambiguously from TODAY'S DATE below.
3. A metric or term has no definition in the Saras business context AND no established default in this prompt, AND more than one reasonable interpretation would change the result (e.g. "our best customers" — by revenue? by deal count? by tenure? there is no default). Do NOT ask for terms that ARE defined (MQL, ICP, SQL, funnel milestones) — use the definition.
4. A count/list request is scoped to an object or property that could plausibly mean two different HubSpot objects with different answers (e.g. "how many deals do we have with Acme" could mean deals associated with the Acme company record, or deals where the deal name contains "Acme" — ask if a quick get_object_properties/search_objects check shows both readings would return different counts).

When in doubt, prefer answering with your best interpretation and stating it explicitly in **Filters applied:** over asking — a stated assumption the user can correct is better than an interruption, UNLESS the ambiguity is a fork in what OBJECT or WHICH RECORD the entire query is about (name collision, metric definition), in which case ask.

Ask AT MOST one question, offering the specific options you found (e.g. list the 2-3 matching companies with their domain/city to disambiguate). Never ask a vague "can you clarify?" — the question must name the specific fork and the concrete options.

To ask a clarifying question: do not call any more tools. End your turn with text starting EXACTLY with:

🤔 **Need a bit more detail:** <your specific question, naming the exact fork and options>

Do NOT use this prefix for anything except a genuine blocking ambiguity. Do NOT use it to ask permission to run a query, confirm scope, or hedge — only when you cannot proceed without the user's choice.

TOOL SELECTION RULES:
- For "how many" / count questions, use count_objects — it returns exact totals without fetching records. For breakdowns by time period, call count_objects once per period.
- For ANY question involving BOTH deals AND company properties (ICP status, company name, industry, revenue, etc.) → use get_deals_with_company_properties (deal-side filters) or get_companies_with_deal_properties (company-side filters) — pick whichever side's filters are more selective as the search anchor. See the Cross-Object Mismatch Queries playbook below for questions comparing a deal's property against its company's property. Do NOT use get_associations one-by-one for this.
- For ANY question involving contacts WITH company properties (ICP status, company name, revenue) → use get_contacts_with_company_properties. Same batch pattern.
- NEVER call get_deal/get_company/get_contact more than 2-3 times in a row to check individual records against a filter — that pattern means the query should be restructured as a single batch call instead. Repeated single-record lookups don't scale and burn far more tokens than one batch call would.
- Use search_objects for single-object queries with no cross-object property filtering.
- Use get_associations only when you need a one-off relationship lookup for a single record.
- NEVER use the BETWEEN operator for ANY range query (dates, numbers, revenue, etc.) — it is unreliable on HubSpot properties. Instead, use two separate filters: GTE for the lower bound and LTE for the upper bound.
- For multi-value matching (e.g. country = US or CA or UK), use the IN operator with comma-separated values: { property: "country", operator: "IN", value: "United States,Canada,United Kingdom" }. Use full property values as stored in HubSpot.
- When a user asks "why is X not in the list?", ALWAYS look up the record first using get_company/get_contact/get_deal, then compare its properties against the filters. Never guess or speculate before checking.
- If a search returns 0 results and the user expected data, re-check your filters: verify the property name with get_object_properties, confirm you used GTE+LTE (not BETWEEN), and make sure you searched the correct object type (Company for MQLs, not Contact).
- When a search returns truncated: true and after is not null, you CAN call the same tool with the after cursor to get the next page — but only if the user's question requires all records. For counts, use count_objects instead.
- If a tool response includes "truncated": true, tell the user the exact total count and that you're showing a subset. Suggest narrowing filters if the total is large.
- Use send_data_as_file ONLY when the user explicitly asks for a CSV, TSV, spreadsheet, export, or downloadable file. Do NOT use it automatically for ordinary lists — those should stay inline as text or a markdown table.

=== QUERY PLAYBOOKS ===
${QUERY_PLAYBOOKS}

RESPONSE RULES:
- Call all tools silently — zero text output while fetching data
- Only produce text ONCE as your final answer, using this exact structure:

**Answer:** <the direct result — count, list, or value>

**Filters applied:**
• <filter 1>
• <filter 2>

**Notes:** <only if something important needs flagging>

If there is nothing to flag, omit the **Notes:** line entirely — do not write "**Notes:** None" or "**Notes:** N/A".

- Do NOT narrate your reasoning, show intermediate checks, or list records you rejected
- Do NOT show ✅ / ❌ per record — only show records that matched
- If listing matched records, show: name, stage, amount, and any other directly relevant fields
- For result sets with more than 20 records, show a grouped summary (e.g. by stage, country, or source) with counts. Offer to list individual records if the user wants.
- Do NOT prefix **Answer:** with any lead-in text ("Here's what I found:", "Sure, here's the breakdown:", etc.) and do NOT add a closing line after your last section ("Let me know if you need anything else!", "Happy to dig deeper if needed."). The response ends at the last populated section.
- You may use a standard Markdown table (header row, a separator row of dashes, then data rows, all using | to separate columns) when tabular data is the clearest presentation — it renders as a real table in Slack. Use it for genuinely tabular comparisons; for simple lists, a numbered/bulleted list is still often clearer.

SLACK FORMATTING RULES — follow strictly:
- Bold: **text** (double asterisk — standard Markdown, NOT Slack's classic single-asterisk mrkdwn)
- Bullet lists: start lines with •
- Numbered lists: 1. 2. 3.
- Markdown tables ARE supported — use pipe (|) syntax when a table is the clearest format
- NO ## or # headers — use **Bold Title** on its own line

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

// A separate tool (not a HubSpot data tool — handled specially in askClaude's
// tool loop, see SEND_FILE_TOOL_NAME below) matching DE Agent's on-demand
// send_slack_file capability: Claude decides when a CSV/TSV export is
// actually useful, rather than every multi-record list automatically
// getting one. This is distinct from the automatic long-answer .md
// fallback in processEvent, which exists purely to fit within Slack's
// markdown-block character limit, not as an export feature.
const SEND_FILE_TOOL_NAME = 'send_data_as_file';
const SEND_FILE_TOOL = {
  name: SEND_FILE_TOOL_NAME,
  description: 'Upload data as a downloadable file attachment in this Slack thread. Use ONLY when the user explicitly asks for a CSV, TSV, spreadsheet, export, or downloadable file — never automatically for normal record lists, which should stay inline as text or a markdown table.',
  input_schema: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: 'File name including extension, e.g. "icp_contacts.csv" or "deals_export.tsv".' },
      content: { type: 'string', description: 'The full file content: one header row, then one row per record, with fields separated by commas (.csv) or real tab characters (.tsv) matching the filename extension.' },
    },
    required: ['filename', 'content'],
  },
};
anthropicTools.push(SEND_FILE_TOOL);

// ─── Express App ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// ─── Claude via Anthropic SDK ────────────────────────────────────────────────

function emptyUsage() {
  return { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
}

function addUsage(totals, usage) {
  if (!usage) return;
  totals.input_tokens += usage.input_tokens || 0;
  totals.output_tokens += usage.output_tokens || 0;
  totals.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
  totals.cache_creation_input_tokens += usage.cache_creation_input_tokens || 0;
}

// Shared by both the iteration cap and the hard cost ceiling: asks Claude to
// summarize whatever was found so far instead of just refusing outright, so
// hitting either limit still produces a genuinely useful partial answer.
async function generatePartialSummary(messages, threadKey, usage, reasonAddendum) {
  const FALLBACK_TEXT = 'Reached maximum iterations — try a more specific question.';
  try {
    const summaryResp = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      // On Sonnet 5, omitting `thinking` now defaults to adaptive (was
      // thinking-off on 4.6) — disable it explicitly here so the tight
      // 2000-token budget goes entirely to the summary text, not reasoning.
      thinking: { type: 'disabled' },
      output_config: { effort: CLAUDE_EFFORT },
      system: buildSystemPrompt(reasonAddendum),
      tools: anthropicTools,
      tool_choice: { type: 'none' },
      messages,
    });
    addUsage(usage, summaryResp.usage);
    const text = summaryResp.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    return text || FALLBACK_TEXT;
  } catch (err) {
    log('ERROR', 'partial_progress_summary_failed', { correlation_id: threadKey, error: err.message });
    return FALLBACK_TEXT;
  }
}

async function askClaude(question, threadKey, statusUpdater = async () => {}, streamUpdater = async () => {}, sendFile = async () => ({ error: 'file sending not available on this path' })) {
  await statusUpdater('Analyzing your request...');

  const history = getThreadMessages(threadKey);
  const hasHistory = history.length > 0;
  log('INFO', 'thread_resume', { correlation_id: threadKey, resumed: hasHistory, historyLen: history.length });

  const messages = [...history, { role: 'user', content: question }];
  const usage = emptyUsage();

  const loopStartTs = Date.now();
  const MAX_LOOP_MS = 100_000;
  // Two-tier cost guard, not a single flat cutoff — a hard cutoff alone
  // can't tell "expensive because inefficient" apart from "expensive
  // because genuinely complex," and would refuse both identically. Once
  // SOFT_BUDGET_USD is crossed, the model gets a wrap-up nudge (via the
  // uncached suffix of buildSystemPrompt, so it doesn't touch the cached
  // system prompt) and keeps going — most legitimately complex questions
  // finish here. Only if HARD_BUDGET_USD is still crossed after that does
  // the loop actually stop, and even then it produces a partial answer via
  // generatePartialSummary rather than a blunt refusal. $0.75 (not $1)
  // leaves headroom for that trailing summary call itself.
  const SOFT_BUDGET_USD = 0.35;
  const HARD_BUDGET_USD = 0.75;
  const WRAP_UP_ADDENDUM = "You're approaching this question's budget — finish efficiently: use the most direct remaining tool calls, avoid redundant lookups, and give your best answer soon.";
  let nearBudget = false;
  let iterations = 0;
  while (iterations++ < 25) {
    if (Date.now() - loopStartTs > MAX_LOOP_MS) {
      log('WARN', 'agent_loop_time_exceeded', { correlation_id: threadKey, iterations, elapsedMs: Date.now() - loopStartTs });
      storeThreadMessages(threadKey, messages);
      return { text: 'This is taking too long — try narrowing your question.', usage };
    }
    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      // Sonnet 5 rejects the old fixed-budget form (`enabled` + `budget_tokens`)
      // with a 400 — adaptive thinking is the only supported "on" mode now.
      thinking: { type: 'adaptive' },
      output_config: { effort: CLAUDE_EFFORT },
      system: buildSystemPrompt(nearBudget ? WRAP_UP_ADDENDUM : null),
      tools: anthropicTools,
      messages,
    });
    addUsage(usage, response.usage);

    const estCost = estimateCostUsd(usage, CLAUDE_MODEL);
    if (estCost > HARD_BUDGET_USD) {
      log('WARN', 'agent_loop_cost_exceeded', { correlation_id: threadKey, iterations, estCost });
      storeThreadMessages(threadKey, messages);
      const text = await generatePartialSummary(messages, threadKey, usage, 'This question has exceeded its cost budget for a single request. Do NOT call any more tools. Summarize what you found so far using the **Answer:** / **Filters applied:** / **Notes:** structure, but replace **Answer:** with **Partial answer (cost budget reached):** and use **Notes:** to say exactly what part of the question you were not able to finish and what the user could do to get a complete answer (e.g. narrow the date range, split into two questions).');
      return { text, usage };
    }
    if (!nearBudget && estCost > SOFT_BUDGET_USD) {
      nearBudget = true;
      log('INFO', 'agent_loop_near_budget', { correlation_id: threadKey, iterations, estCost });
    }

    const contentWithoutThinking = response.content.filter(b => b.type !== 'thinking');
    messages.push({ role: 'assistant', content: contentWithoutThinking });

    const toolBlocks = contentWithoutThinking.filter(b => b.type === 'tool_use');
    if (response.stop_reason === 'end_turn' || toolBlocks.length === 0) {
      storeThreadMessages(threadKey, messages);
      const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      return { text: text || 'No response generated.', usage };
    }

    const toolResults = [];
    for (const block of toolBlocks) {
      log('INFO', 'tool_use', { correlation_id: threadKey, tool: block.name });
      await statusUpdater(getToolStatus(block.name));
      await streamUpdater('start', block.name, block.input);
      const result = block.name === SEND_FILE_TOOL_NAME
        ? await sendFile(block.input.filename, block.input.content)
        : await executeTool(block.name, block.input, { correlation_id: threadKey });
      await streamUpdater('complete', block.name, block.input, !result.error);
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
    }
    // Rolling cache breakpoint: without this, every iteration of a
    // multi-step query re-bills the entire accumulated tool-result history
    // from all prior iterations at full price. Marking the last block of
    // each turn cacheable means only the new content since the last
    // breakpoint costs full price — everything before reads from cache.
    if (toolResults.length) toolResults[toolResults.length - 1].cache_control = { type: 'ephemeral' };
    messages.push({ role: 'user', content: toolResults });
  }

  log('WARN', 'agent_loop_iteration_cap', { correlation_id: threadKey, iterations, question });
  storeThreadMessages(threadKey, messages);

  const text = await generatePartialSummary(messages, threadKey, usage, 'You have run out of tool-call budget for this request. Do NOT call any more tools. Summarize what you found so far using the **Answer:** / **Filters applied:** / **Notes:** structure, but replace **Answer:** with **Partial answer (ran out of steps):** and use **Notes:** to say exactly what part of the question you were not able to finish and what the user could do to get a complete answer (e.g. narrow the date range, split into two questions).');
  return { text, usage };
}

function trimToAnswer(text) {
  const match = text.match(/(\*\*Answer:|\*Answer:|Answer:)/);
  return match ? text.slice(match.index) : text;
}

// Slack's cumulative limit across all "markdown" blocks in one message is
// 12,000 characters (matches DE Agent's own SLACK_BLOCK_CHAR_LIMIT). Past
// that, don't try to chunk it into more blocks — upload the full answer as
// a file instead and post a short truncated notice in its place.
const MAX_INLINE_ANSWER_CHARS = 12000;

function truncateForNotice(text, maxChars) {
  const cut = text.lastIndexOf('\n', maxChars);
  return (cut > maxChars * 0.5 ? text.slice(0, cut) : text.slice(0, maxChars)).trim();
}

// ─── Event Processor ──────────────────────────────────────────────────────────

let shuttingDown = false;
const startTs = Date.now();
let lastInvocationTs = null;

async function processEvent(event, slackToken, teamId) {
  if (shuttingDown) return;

  const isMention = event.type === 'app_mention';
  const isDM = event.type === 'message' && event.channel_type === 'im';
  if (!isMention && !isDM) return;

  const threadKey = getThreadKey(event);
  log('INFO', 'event_received', { correlation_id: threadKey, eventType: event.type, channel: event.channel });

  if (isDuplicate(event)) {
    log('INFO', 'event_duplicate', { correlation_id: threadKey });
    return;
  }

  const question = event.text?.replace(/<@[A-Z0-9]+>/g, '').trim();
  if (!question) return;

  lastInvocationTs = new Date().toISOString();
  log('INFO', 'question_received', { correlation_id: threadKey, question });

  slackRequest('/reactions.add', {
    channel: event.channel,
    timestamp: event.ts,
    name: 'eyes'
  }, slackToken).catch(() => {});

  const lockResult = await withThreadLock(threadKey, async () => {
    const hasHistory = getThreadMessages(threadKey).length > 0;

    const cacheKey = `${event.user || ''}:${event.channel}:${question.toLowerCase()}`;
    if (!hasHistory) {
      const cached = getCached(cacheKey);
      if (cached) {
        log('INFO', 'cache_hit', { correlation_id: threadKey });
        const blocks = buildAnswerBlocks(cached.answer);
        blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_⚡ Cached result_' }] });
        await slackRequest('/chat.postMessage', {
          channel: event.channel,
          thread_ts: event.thread_ts || event.ts,
          text: cached.answer.slice(0, 200),
          blocks
        }, slackToken).catch(err => log('ERROR', 'cached_answer_post_failed', { correlation_id: threadKey, error: err.message }));
        return;
      }
    }

    // Always shows a rotating assistant status ("E3", assistant.threads.
    // setStatus) immediately, independent of the step-list stream below —
    // separately, also attempts a collapsible step-list stream
    // (chat.startStream/appendStream/stopStream — "E4") that runs alongside
    // it when available. These are complementary, not alternatives: E3
    // gives instant animated feedback, E4 adds a per-tool-call breakdown
    // once the stream is up.
    const threadTs = event.thread_ts || event.ts;

    let streamTs = null;
    let toolStepCount = 0;

    await slackRequest('/assistant.threads.setStatus', {
      channel_id: event.channel,
      thread_ts: threadTs,
      status: 'Analyzing your request...',
      loading_messages: ['Analyzing your request...', 'Reading the CRM schema...', 'Querying HubSpot...', 'Crunching the numbers...']
    }, slackToken).catch(err => log('ERROR', 'status_post_failed', { correlation_id: threadKey, error: err.message }));

    // Slack auto-clears the rotating status as soon as the stream posts its
    // first message, so without a pause here the E3 status is visible for
    // well under a second before the E4 card replaces it. A short floor
    // gives it time to actually be seen.
    const E3_MIN_VISIBLE_MS = 3000;
    await new Promise(resolve => setTimeout(resolve, E3_MIN_VISIBLE_MS));

    try {
      if (!teamId) throw new Error('missing_recipient_team_id (no Bolt context.teamId available)');
      const streamStart = await slackRequest('/chat.startStream', {
        channel: event.channel,
        thread_ts: threadTs,
        recipient_team_id: teamId,
        recipient_user_id: event.user,
        task_display_mode: 'plan'
      }, slackToken);
      streamTs = streamStart.ts;
      log('INFO', 'stream_mode', { correlation_id: threadKey, mode: 'e4' });
      // Establishes the collapsible step-list container before any
      // task_update chunks arrive — without this, Slack has nothing to
      // attach per-tool cards to.
      await slackRequest('/chat.appendStream', {
        channel: event.channel,
        ts: streamTs,
        chunks: [{ type: 'plan_update', title: 'Working on it...' }]
      }, slackToken).catch(err => log('WARN', 'stream_append_failed', { correlation_id: threadKey, error: err.message }));
    } catch (err) {
      log('WARN', 'stream_start_failed', { correlation_id: threadKey, error: err.message });
    }

    // Matches the reference implementation's behavior exactly: setStatus is
    // only ever called before the stream exists (Slack auto-clears it once
    // the app "sends a reply," which the stream's first posted message
    // counts as). Calling it again after streamTs is set produced a second,
    // competing visual element in the thread alongside the step-list card —
    // once streaming, all progress updates flow through streamUpdater
    // (task_update chunks) instead.
    async function statusUpdater(text) {
      if (streamTs) return;
      await slackRequest('/assistant.threads.setStatus', {
        channel_id: event.channel,
        thread_ts: threadTs,
        status: text
      }, slackToken).catch(err => log('WARN', 'status_update_failed', { correlation_id: threadKey, error: err.message }));
    }

    // Only active when the E4 stream is up (streamTs set). Emits a
    // task_update chunk pair per tool call — 'in_progress' when it starts,
    // 'complete'/'error' when it finishes — producing the per-step
    // accordion, with `details` populated from the tool's input so each
    // card has something to expand into. Tool calls in this loop are
    // sequential (never concurrent), so toolStepCount is a safe stable id
    // across each pair.
    async function streamUpdater(phase, toolName, input, ok) {
      if (!streamTs) return;
      if (phase === 'start') toolStepCount++;
      const title = getToolStatus(toolName).replace(/\.\.\.$/, '');
      const details = input ? JSON.stringify(input).slice(0, 250) : undefined;
      await slackRequest('/chat.appendStream', {
        channel: event.channel,
        ts: streamTs,
        chunks: [{
          type: 'task_update',
          id: String(toolStepCount),
          title,
          status: phase === 'start' ? 'in_progress' : (ok ? 'complete' : 'error'),
          ...(details ? { details } : {})
        }]
      }, slackToken).catch(err => log('WARN', 'stream_append_failed', { correlation_id: threadKey, error: err.message }));
    }

    // Backs the SEND_FILE_TOOL Claude can call explicitly (see index.js top)
    // when a user asks for a CSV/TSV/export — distinct from the automatic
    // long-answer .md fallback below, which exists only to stay within
    // Slack's markdown-block character limit.
    async function sendFile(filename, content) {
      try {
        await uploadFile(filename, content, { channelId: event.channel, threadTs }, slackToken);
        return { ok: true };
      } catch (err) {
        log('WARN', 'send_file_tool_failed', { correlation_id: threadKey, error: err.message });
        return { error: err.message };
      }
    }

    let answer;
    let answerUsage = null;
    try {
      const result = await askClaude(question, threadKey, statusUpdater, streamUpdater, sendFile);
      answer = trimToAnswer(result.text);
      answerUsage = result.usage;
    } catch (err) {
      log('ERROR', 'claude_error', { correlation_id: threadKey, error: err.message });
      const raw = err.message || '';
      const limitMatch = raw.match(/you have reached your specified workspace api usage limits[^]*/i);
      if (limitMatch) {
        const detail = raw.match(/You will regain access[^".]*/i);
        answer = `**API Usage Limit Reached**\n${detail ? detail[0] + '.' : 'Monthly API quota exhausted.'}\nPlease contact your Anthropic account admin to increase the limit.`;
      } else {
        answer = `**Error:** ${raw}`;
      }
    }

    const isClarification = answer.startsWith('🤔 **Need a bit more detail:**');

    let longAnswerFile = null;
    if (!isClarification && answer.length > MAX_INLINE_ANSWER_CHARS) {
      longAnswerFile = answer;
      answer = `${truncateForNotice(answer, 1500)}\n\n_(Full answer attached as a file in this thread — this response was too long to fit in one Slack message.)_`;
    }

    if (!hasHistory && !isClarification) setCache(cacheKey, answer);

    const blocks = buildAnswerBlocks(answer, { skipFeedback: isClarification, usage: isClarification ? null : answerUsage });

    // The E4 stream (if active) only ever carries the step-trace UI — it's
    // finalized here with just a completion title, never the answer itself.
    // The real answer always posts as its own ordinary message below, which
    // is also what gives it a real preview/notification text (chat.stopStream
    // has no such field, so folding the answer into it left Slack's preview
    // frozen on the stream's initial "Thinking..." placeholder).
    if (streamTs) {
      await slackRequest('/chat.stopStream', {
        channel: event.channel,
        ts: streamTs,
        chunks: [{ type: 'plan_update', title: `Completed (${toolStepCount} step${toolStepCount === 1 ? '' : 's'})` }]
      }, slackToken).catch(err => log('WARN', 'stream_stop_failed', { correlation_id: threadKey, error: err.message }));
    }

    const primaryPost = slackRequest('/chat.postMessage', {
      channel: event.channel,
      thread_ts: event.thread_ts || event.ts,
      text: answer.slice(0, 200),
      blocks
    }, slackToken);

    await primaryPost.catch(err => {
      log('ERROR', 'answer_post_failed', { correlation_id: threadKey, error: err.message });
      slackRequest('/chat.postMessage', {
        channel: event.channel,
        thread_ts: event.thread_ts || event.ts,
        text: 'Sorry, I had trouble formatting that response. Please try rephrasing your question.'
      }, slackToken).catch(err2 => {
        log('ERROR', 'fallback_post_failed', { correlation_id: threadKey, error: err2.message });
        const logChannel = process.env.LOG_CHANNEL_ID;
        if (logChannel) {
          slackRequest('/chat.postMessage', {
            channel: logChannel,
            text: `:rotating_light: Bot failed to answer <@${event.user}> in <#${event.channel}> (thread ${threadKey}) — both primary and fallback post failed. Error: ${err2.message}`
          }, slackToken).catch(err3 => log('ERROR', 'admin_escalation_failed', { correlation_id: threadKey, error: err3.message }));
        }
      });
    });

    if (longAnswerFile) {
      uploadFile('hubspot-answer.md', longAnswerFile, {
        channelId: event.channel,
        threadTs: event.thread_ts || event.ts,
      }, slackToken).catch(err => log('WARN', 'long_answer_upload_failed', { correlation_id: threadKey, error: err.message }));
    }

    slackRequest('/reactions.remove', { channel: event.channel, timestamp: event.ts, name: 'eyes' }, slackToken).catch(() => {});
    slackRequest('/reactions.add', { channel: event.channel, timestamp: event.ts, name: isClarification ? 'question' : 'white_check_mark' }, slackToken).catch(() => {});

    const logChannel = process.env.LOG_CHANNEL_ID;
    if (logChannel && event.user) {
      const answerSnippet = answer.replace(/\*/g, '').slice(0, 300);
      slackRequest('/chat.postMessage', {
        channel: logChannel,
        text: `*Q* from <@${event.user}> in <#${event.channel}>\n*Question:* ${question}\n*Answer:* ${answerSnippet}${answer.length > 300 ? '...' : ''}`,
        unfurl_links: false,
        unfurl_media: false
      }, slackToken).catch(err => log('WARN', 'qa_log_post_failed', { correlation_id: threadKey, error: err.message }));
    }

    log('INFO', 'request_complete', { correlation_id: threadKey });
  });

  if (lockResult && lockResult.__lockTimedOut) {
    slackRequest('/chat.postMessage', {
      channel: event.channel,
      thread_ts: event.thread_ts || event.ts,
      text: 'This is taking longer than expected — please try again in a moment.'
    }, slackToken).catch(err => log('ERROR', 'lock_timeout_notice_failed', { correlation_id: threadKey, error: err.message }));
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({
  status: 'ok',
  uptime_seconds: Math.floor((Date.now() - startTs) / 1000),
  last_invocation_ts: lastInvocationTs,
  active_threads: getActiveThreadCount(),
  thread_history_count: getThreadHistoryCount(),
  env: {
    hasHubspot: !!process.env.HUBSPOT_PRIVATE_APP_TOKEN,
    hasAnthropic: !!process.env.ANTHROPIC_API_KEY,
    hasSlackToken: !!process.env.SLACK_BOT_TOKEN
  }
}));

app.post('/clear-history', (req, res) => {
  const workerSecret = process.env.WORKER_SECRET;
  if (workerSecret && req.headers['x-worker-secret'] !== workerSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const count = clearThreadHistory();
  log('INFO', 'thread_history_cleared', { count });
  res.json({ cleared: count });
});

const httpServer = app.listen(PORT, () => log('INFO', 'worker_listening', { port: PORT }));

// ─── Slack Socket Mode (bolt) ─────────────────────────────────────────────────

const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

slackApp.event('app_mention', async ({ event, context }) => {
  if (event.bot_id || event.subtype) return;
  processEvent(event, process.env.SLACK_BOT_TOKEN, context.teamId)
    .catch(err => log('ERROR', 'bolt_app_mention_error', { error: err.message }));
});

slackApp.event('message', async ({ event, context }) => {
  if (event.channel_type === 'im' && !event.bot_id && !event.subtype) {
    processEvent(event, process.env.SLACK_BOT_TOKEN, context.teamId)
      .catch(err => log('ERROR', 'bolt_message_error', { error: err.message }));
  }
});

slackApp.action('feedback', async ({ ack, body, action }) => {
  await ack();
  const value = action.value; // 'good-feedback' | 'bad-feedback'
  log('INFO', 'feedback_received', {
    value,
    user: body.user && body.user.id,
    channel: body.channel && body.channel.id,
    message_ts: body.message && body.message.ts,
  });
  const logChannel = process.env.LOG_CHANNEL_ID;
  if (logChannel) {
    slackRequest('/chat.postMessage', {
      channel: logChannel,
      text: `${value === 'good-feedback' ? '👍' : '👎'} Feedback from <@${body.user.id}> on <#${body.channel.id}|${body.message.ts}>`
    }, process.env.SLACK_BOT_TOKEN).catch(err => log('WARN', 'feedback_log_post_failed', { error: err.message }));
  }
});

slackApp.start()
  .then(() => log('INFO', 'socket_mode_active', {}))
  .catch(err => log('ERROR', 'socket_mode_start_failed', { error: err.message }));

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

process.on('SIGTERM', () => {
  log('INFO', 'sigterm_received', {});
  shuttingDown = true;
  httpServer.close();
  setTimeout(() => process.exit(0), 25000);
});
