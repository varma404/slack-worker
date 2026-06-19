/**
 * Slack Worker - Process events with Claude + HubSpot tools
 */

const express = require('express');
const https = require('https');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Response Cache ───────────────────────────────────────────────────────────

const responseCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getCached(key) {
  const e = responseCache.get(key);
  if (!e || Date.now() - e.ts > CACHE_TTL_MS) { responseCache.delete(key); return null; }
  return e;
}
function setCache(key, answer) {
  responseCache.set(key, { answer, ts: Date.now() });
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

// ─── Table Rendering ──────────────────────────────────────────────────────────

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

// ─── HubSpot API Client ───────────────────────────────────────────────────────

function hubspotRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.hubapi.com',
      port: 443,
      path,
      method,
      headers: {
        'Authorization': `Bearer ${process.env.HUBSPOT_PRIVATE_APP_TOKEN}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (res.statusCode >= 400) reject(new Error(`HubSpot ${res.statusCode}: ${parsed.message}`));
          else resolve(parsed);
        } catch (e) { reject(e); }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('HubSpot timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const TOOL_DEFINITIONS = [
  {
    name: 'get_object_properties',
    description: 'List all available properties (including custom ones) for a HubSpot object type. Call this first when you need to filter or retrieve a property whose name you don\'t know (e.g. MQL date, lifecycle stage, source).',
    input_schema: {
      type: 'object',
      properties: {
        object_type: { type: 'string', enum: ['contacts', 'companies', 'deals'], description: 'The CRM object type' }
      },
      required: ['object_type']
    }
  },
  {
    name: 'search_objects',
    description: 'Flexible search across any HubSpot object type with filters on any property. Use get_object_properties first if you need to find the exact property names. All filters in the list are AND\'d together. For date values use ISO date strings like "2026-06-09" — they are automatically converted to the correct format. Never compute milliseconds manually.',
    input_schema: {
      type: 'object',
      properties: {
        object_type: { type: 'string', enum: ['contacts', 'companies', 'deals'], description: 'The CRM object type to search' },
        filters: {
          type: 'array',
          description: 'Filters — all AND\'d together',
          items: {
            type: 'object',
            properties: {
              property: { type: 'string', description: 'HubSpot property name (e.g. lifecyclestage, hs_analytics_source, hs_date_entered_marketingqualifiedlead)' },
              operator: { type: 'string', enum: ['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'BETWEEN', 'HAS_PROPERTY', 'NOT_HAS_PROPERTY', 'CONTAINS_TOKEN', 'NOT_CONTAINS_TOKEN'], description: 'Comparison operator' },
              value: { type: 'string', description: 'Filter value. For dates use ISO format: "2026-06-09" or "2026-06-09T00:00:00Z". Do NOT compute milliseconds manually.' },
              high_value: { type: 'string', description: 'Upper bound for BETWEEN operator only' }
            },
            required: ['property', 'operator']
          }
        },
        properties: {
          type: 'array',
          items: { type: 'string' },
          description: 'Property names to return in results. Include any custom properties you need.'
        },
        sort_by: { type: 'string', description: 'Property to sort by (default: createdate)' },
        sort_direction: { type: 'string', enum: ['ASCENDING', 'DESCENDING'], description: 'Sort direction (default: DESCENDING)' },
        limit: { type: 'integer', description: 'Max results 1-100 (default 20)', default: 20 }
      },
      required: ['object_type']
    }
  },
  {
    name: 'search_contacts',
    description: 'Quick text search for contacts by name, email, or company. For filtering by custom properties or dates use search_objects instead.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name, email, or company to search for.' },
        created_after: { type: 'string', description: 'ISO date string to filter contacts created after this date.' },
        limit: { type: 'integer', description: 'Max results (1-100, default 10)', default: 10 }
      },
      required: []
    }
  },
  {
    name: 'search_deals',
    description: 'Search HubSpot deals with optional filters by stage or amount. For custom property filters use search_objects instead.',
    input_schema: {
      type: 'object',
      properties: {
        dealstage: { type: 'string', description: 'Deal stage e.g. closedwon, closedlost, negotiation, proposal' },
        amount_min: { type: 'number', description: 'Minimum deal amount' },
        amount_max: { type: 'number', description: 'Maximum deal amount' },
        limit: { type: 'integer', description: 'Max results (1-100, default 10)', default: 10 }
      },
      required: []
    }
  },
  {
    name: 'get_deals_with_company_properties',
    description: 'Efficiently fetch deals AND their associated company properties in a single batch operation. Use this for ANY cross-object question involving deals and companies — e.g. "deals where company is ICP", "deals where company revenue > X", "ICP mismatch between deal and company". Far more efficient than fetching associations one-by-one. Returns each deal with its associated company data attached.',
    input_schema: {
      type: 'object',
      properties: {
        deal_filters: {
          type: 'array',
          description: 'Filters for deals — same format as search_objects. Use ISO date strings for dates.',
          items: {
            type: 'object',
            properties: {
              property: { type: 'string' },
              operator: { type: 'string', enum: ['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'BETWEEN', 'HAS_PROPERTY', 'NOT_HAS_PROPERTY', 'CONTAINS_TOKEN', 'NOT_CONTAINS_TOKEN'] },
              value: { type: 'string' },
              high_value: { type: 'string' }
            },
            required: ['property', 'operator']
          }
        },
        deal_properties: {
          type: 'array',
          items: { type: 'string' },
          description: 'Deal properties to return. Defaults to dealname, dealstage, amount, closedate, createdate.'
        },
        company_properties: {
          type: 'array',
          items: { type: 'string' },
          description: 'Company properties to return for each associated company. Defaults to name, is_the_company_icp_, domain.'
        },
        limit: { type: 'integer', description: 'Max deals to fetch (1-100, default 100)', default: 100 }
      },
      required: []
    }
  },
  {
    name: 'get_associations',
    description: 'Get objects associated with a given HubSpot record (e.g. find the company linked to a deal, or contacts linked to a company). Use this to cross-reference data across object types.',
    input_schema: {
      type: 'object',
      properties: {
        object_type: { type: 'string', enum: ['contacts', 'companies', 'deals'], description: 'The source object type' },
        object_id: { type: 'string', description: 'The source object ID' },
        to_object_type: { type: 'string', enum: ['contacts', 'companies', 'deals'], description: 'The associated object type to fetch' }
      },
      required: ['object_type', 'object_id', 'to_object_type']
    }
  },
  {
    name: 'get_contact',
    description: 'Get full details for a specific contact by HubSpot ID.',
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string', description: 'HubSpot Contact ID' },
        properties: { type: 'array', items: { type: 'string' }, description: 'Extra property names to include (custom properties)' }
      },
      required: ['contact_id']
    }
  },
  {
    name: 'get_deal',
    description: 'Get full details for a specific deal by HubSpot ID.',
    input_schema: {
      type: 'object',
      properties: {
        deal_id: { type: 'string', description: 'HubSpot Deal ID' },
        properties: { type: 'array', items: { type: 'string' }, description: 'Extra property names to include (custom properties)' }
      },
      required: ['deal_id']
    }
  },
  {
    name: 'get_company',
    description: 'Get full details for a specific company by HubSpot ID.',
    input_schema: {
      type: 'object',
      properties: {
        company_id: { type: 'string', description: 'HubSpot Company ID' },
        properties: { type: 'array', items: { type: 'string' }, description: 'Extra property names to include (custom properties)' }
      },
      required: ['company_id']
    }
  }
];

// ─── Tool Executor ────────────────────────────────────────────────────────────

async function executeTool(name, input) {
  try {
    switch (name) {

      case 'get_object_properties': {
        const res = await hubspotRequest('GET', `/crm/v3/properties/${input.object_type}`);
        const props = (res.results || [])
          .map(p => ({ name: p.name, label: p.label, type: p.type, fieldType: p.fieldType }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return { total: props.length, properties: props };
      }

      case 'search_objects': {
        function toHubSpotValue(v) {
          if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
            return String(new Date(v).getTime());
          }
          return v;
        }
        const filters = (input.filters || []).map(f => ({
          propertyName: f.property,
          operator: f.operator,
          ...(f.value !== undefined ? { value: toHubSpotValue(f.value) } : {}),
          ...(f.high_value !== undefined ? { highValue: toHubSpotValue(f.high_value) } : {})
        }));
        const defaultProps = {
          contacts: ['firstname', 'lastname', 'email', 'createdate', 'lifecyclestage', 'hs_lead_status'],
          companies: ['name', 'domain', 'createdate', 'lifecyclestage', 'hs_analytics_source', 'hs_analytics_source_data_1'],
          deals: ['dealname', 'dealstage', 'amount', 'closedate', 'pipeline']
        };
        const properties = input.properties?.length
          ? input.properties
          : defaultProps[input.object_type] || ['createdate'];
        const body = {
          limit: Math.min(input.limit || 20, 100),
          properties,
          sorts: [{ propertyName: input.sort_by || 'createdate', direction: input.sort_direction || 'DESCENDING' }],
          ...(filters.length > 0 ? { filterGroups: [{ filters }] } : {})
        };
        const res = await hubspotRequest('POST', `/crm/v3/objects/${input.object_type}/search`, body);
        return {
          total: res.total || res.results?.length || 0,
          returned: res.results?.length || 0,
          results: res.results?.map(r => ({ id: r.id, ...r.properties }))
        };
      }

      case 'search_contacts': {
        const filterGroups = [];
        if (input.created_after) {
          filterGroups.push({
            filters: [{
              propertyName: 'createdate',
              operator: 'GTE',
              value: new Date(input.created_after).getTime().toString()
            }]
          });
        }
        const body = {
          limit: Math.min(input.limit || 10, 100),
          properties: ['firstname', 'lastname', 'email', 'phone', 'company', 'createdate', 'hs_lead_status'],
          sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
          ...(input.query ? { query: input.query } : {}),
          ...(filterGroups.length > 0 ? { filterGroups } : {})
        };
        const res = await hubspotRequest('POST', '/crm/v3/objects/contacts/search', body);
        return { success: true, total: res.results?.length || 0, results: res.results?.map(c => ({ id: c.id, ...c.properties })) };
      }

      case 'search_deals': {
        const filterGroups = [];
        if (input.dealstage) filterGroups.push({ filters: [{ propertyName: 'dealstage', operator: 'EQ', value: input.dealstage }] });
        if (input.amount_min) filterGroups.push({ filters: [{ propertyName: 'amount', operator: 'GTE', value: String(input.amount_min) }] });
        if (input.amount_max) filterGroups.push({ filters: [{ propertyName: 'amount', operator: 'LTE', value: String(input.amount_max) }] });
        const body = {
          limit: Math.min(input.limit || 10, 100),
          properties: ['dealname', 'dealstage', 'amount', 'closedate', 'pipeline'],
          sorts: [{ propertyName: 'amount', direction: 'DESCENDING' }],
          ...(filterGroups.length > 0 ? { filterGroups } : {})
        };
        const res = await hubspotRequest('POST', '/crm/v3/objects/deals/search', body);
        return { success: true, total: res.results?.length || 0, results: res.results?.map(d => ({ id: d.id, ...d.properties })) };
      }

      case 'search_companies': {
        const body = {
          limit: Math.min(input.limit || 10, 100),
          query: input.query,
          properties: ['name', 'domain', 'industry', 'annualrevenue', 'hs_lead_status'],
          sorts: [{ propertyName: 'name', direction: 'ASCENDING' }]
        };
        const res = await hubspotRequest('POST', '/crm/v3/objects/companies/search', body);
        return { success: true, total: res.results?.length || 0, results: res.results?.map(c => ({ id: c.id, ...c.properties })) };
      }

      case 'get_deals_with_company_properties': {
        const filters = (input.deal_filters || []).map(f => {
          const filter = { propertyName: f.property, operator: f.operator };
          if (f.value !== undefined) {
            const v = f.value;
            filter.value = /^\d{4}-\d{2}-\d{2}/.test(v) ? new Date(v).getTime().toString() : v;
          }
          if (f.high_value !== undefined) {
            filter.highValue = /^\d{4}-\d{2}-\d{2}/.test(f.high_value)
              ? new Date(f.high_value).getTime().toString() : f.high_value;
          }
          return filter;
        });
        const dealProps = input.deal_properties?.length
          ? input.deal_properties
          : ['dealname', 'dealstage', 'amount', 'closedate', 'createdate'];
        const dealSearch = await hubspotRequest('POST', '/crm/v3/objects/deals/search', {
          limit: Math.min(input.limit || 100, 100),
          properties: dealProps,
          sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
          ...(filters.length > 0 ? { filterGroups: [{ filters }] } : {})
        });
        const deals = dealSearch.results || [];
        if (deals.length === 0) return { total: 0, results: [] };

        const assocRes = await hubspotRequest('POST', '/crm/v4/associations/deals/companies/batch/read', {
          inputs: deals.map(d => ({ id: d.id }))
        });
        const dealToCompany = {};
        for (const result of (assocRes.results || [])) {
          const companyIds = (result.to || []).map(t => t.toObjectId);
          if (companyIds.length > 0) dealToCompany[result.from.id] = companyIds[0];
        }
        const companyIds = [...new Set(Object.values(dealToCompany))];

        const companyData = {};
        if (companyIds.length > 0) {
          const companyProps = input.company_properties?.length
            ? input.company_properties
            : ['name', 'is_the_company_icp_', 'domain'];
          const companyRes = await hubspotRequest('POST', '/crm/v3/objects/companies/batch/read', {
            inputs: companyIds.map(id => ({ id })),
            properties: companyProps
          });
          for (const c of (companyRes.results || [])) {
            companyData[c.id] = { id: c.id, ...c.properties };
          }
        }

        const results = deals.map(d => ({
          deal: { id: d.id, ...d.properties },
          company: dealToCompany[d.id] ? companyData[dealToCompany[d.id]] || null : null
        }));
        return { total: deals.length, results };
      }

      case 'get_associations': {
        const res = await hubspotRequest('GET', `/crm/v3/objects/${input.object_type}/${input.object_id}/associations/${input.to_object_type}`);
        const ids = (res.results || []).map(r => r.id);
        return { total: ids.length, ids };
      }

      case 'get_contact': {
        const baseProps = ['firstname', 'lastname', 'email', 'phone', 'company', 'createdate', 'hs_lead_status', 'jobtitle', 'lifecyclestage'];
        const props = [...new Set([...baseProps, ...(input.properties || [])])].join(',');
        const res = await hubspotRequest('GET', `/crm/v3/objects/contacts/${input.contact_id}?properties=${props}`);
        return { id: res.id, ...res.properties };
      }

      case 'get_deal': {
        const baseProps = ['dealname', 'dealstage', 'amount', 'closedate', 'pipeline', 'description'];
        const props = [...new Set([...baseProps, ...(input.properties || [])])].join(',');
        const res = await hubspotRequest('GET', `/crm/v3/objects/deals/${input.deal_id}?properties=${props}`);
        return { id: res.id, ...res.properties };
      }

      case 'get_company': {
        const baseProps = ['name', 'domain', 'industry', 'annualrevenue', 'hs_lead_status', 'website', 'city', 'country', 'lifecyclestage'];
        const props = [...new Set([...baseProps, ...(input.properties || [])])].join(',');
        const res = await hubspotRequest('GET', `/crm/v3/objects/companies/${input.company_id}?properties=${props}`);
        return { id: res.id, ...res.properties };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    console.error(`[TOOL ERROR] ${name}:`, err.message);
    return { error: err.message };
  }
}

// ─── Claude with Tool Use ─────────────────────────────────────────────────────

async function fetchThreadHistory(channel, thread_ts, botUserId, token) {
  return new Promise((resolve) => {
    const path = `/api/conversations.replies?channel=${encodeURIComponent(channel)}&ts=${encodeURIComponent(thread_ts)}&limit=20`;
    const options = {
      hostname: 'slack.com',
      port: 443,
      path,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (!parsed.ok) { resolve([]); return; }
          const msgs = [];
          const history = (parsed.messages || []).slice(0, -1);
          for (const m of history) {
            const isBot = m.bot_id || (botUserId && m.user === botUserId);
            const text = m.text?.replace(/<@[A-Z0-9]+>/g, '').trim();
            if (!text) continue;
            msgs.push({ role: isBot ? 'assistant' : 'user', content: text });
          }
          resolve(msgs);
        } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

async function askClaude(question, history = [], statusUpdater = async () => {}) {
  const messages = [...history, { role: 'user', content: question }];
  const now = new Date().toISOString();

  await statusUpdater('Analyzing your request...');

  for (let i = 0; i < 20; i++) {
    const response = await claude.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: `You are a HubSpot CRM assistant for Saras Analytics. Responses are shown in Slack.

${process.env.BUSINESS_CONTEXT ? `BUSINESS CONTEXT:\n${process.env.BUSINESS_CONTEXT}\n` : ''}
SARAS ANALYTICS — HUBSPOT PROPERTY MAPPINGS:
${process.env.HUBSPOT_CONTEXT || '(none configured)'}
Always use the mapped property name when a user asks about a business term listed above.

SCOPE RESTRICTION:
You ONLY answer questions about HubSpot CRM data — deals, contacts, companies, pipelines, or Saras's sales and marketing activities.
If a question is unrelated to HubSpot CRM (e.g. general company strategy, coding help, weather, internal ops tools, personal questions), respond with a brief, professional out-of-scope message. Keep it friendly, 2–3 sentences. Acknowledge what they asked, clarify your scope, and point them to the right place. Do NOT call any tools for out-of-scope questions.

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

*Notes:* <only if something important needs flagging, e.g. nulls, ambiguous stages, data gaps — skip this section if nothing to flag>

- Do NOT narrate your reasoning, show intermediate checks, or list records you rejected
- Do NOT show ✅ / ❌ per record — only show records that matched
- If listing matched records, show: name, stage, amount, and any other directly relevant fields — nothing else

SLACK FORMATTING RULES — follow strictly:
- Bold: *text* (single asterisk, NOT double **)
- Bullet lists: start lines with •
- Numbered lists: 1. 2. 3.
- NO markdown tables (no | pipes) — use numbered lists instead
- NO ## or # headers — use *Bold Title* on its own line

Current date/time: ${now}
Always use tools to fetch actual data — never say you "don't have access".`,
      tools: TOOL_DEFINITIONS,
      messages
    });

    if (response.stop_reason === 'end_turn') {
      await statusUpdater('Manifesting your answer...');
      const text = response.content.find(b => b.type === 'text');
      return text?.text || 'Done.';
    }

    if (response.stop_reason !== 'tool_use') {
      await statusUpdater('Manifesting your answer...');
      const text = response.content.find(b => b.type === 'text');
      return text?.text || 'Done.';
    }

    const toolCalls = response.content.filter(b => b.type === 'tool_use');
    const toolResults = [];

    for (const call of toolCalls) {
      const statusText = TOOL_STATUS[call.name] || FALLBACK_STATUSES[fallbackIdx++ % FALLBACK_STATUSES.length];
      await statusUpdater(statusText);
      console.log(`[WORKER] Tool call: ${call.name}`, JSON.stringify(call.input));
      const result = await executeTool(call.name, call.input);
      console.log(`[WORKER] Tool result: ${call.name} →`, JSON.stringify(result).slice(0, 200));
      toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result) });
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });
  }

  return 'Reached max iterations — please try a more specific question.';
}

function trimToAnswer(text) {
  const match = text.match(/(\*Answer:|Answer:)/);
  return match ? text.slice(match.index) : text;
}

// ─── Slack Client ─────────────────────────────────────────────────────────────

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

// ─── Event Processor ─────────────────────────────────────────────────────────

async function processEvent(event, slackToken) {
  console.log('[PROCESS] event:', event.type, 'channel:', event.channel);

  const isMention = event.type === 'app_mention';
  const isDM = event.type === 'message' && event.channel_type === 'im';
  if (!isMention && !isDM) return;

  const question = event.text?.replace(/<@[A-Z0-9]+>/g, '').trim();
  if (!question) return;

  console.log('[PROCESS] Question:', question);

  // Check cache — skip for thread replies to keep conversation context fresh
  const isThreadReply = event.thread_ts && event.thread_ts !== event.ts;
  const cacheKey = `${event.channel}:${question.toLowerCase()}`;
  if (!isThreadReply) {
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
      }, slackToken).catch(() => {});
      return;
    }
  }

  // Fetch thread history for follow-up context
  let history = [];
  if (isThreadReply) {
    const botUserId = process.env.SLACK_BOT_USER_ID || '';
    history = await fetchThreadHistory(event.channel, event.thread_ts, botUserId, slackToken);
    if (history.length > 0) console.log(`[PROCESS] Loaded ${history.length} prior messages from thread`);
  }

  // Post initial status message and store its ts for in-place updates
  let statusTs = null;
  try {
    const statusMsg = await slackRequest('/chat.postMessage', {
      channel: event.channel,
      thread_ts: event.thread_ts || event.ts,
      text: 'Analyzing your request...'
    }, slackToken);
    statusTs = statusMsg.ts;
  } catch (err) {
    console.error('[PROCESS] Failed to post status message:', err.message);
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
    answer = trimToAnswer(await askClaude(question, history, statusUpdater));
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

  // Cache for non-thread questions
  if (!isThreadReply) setCache(cacheKey, answer);

  const blocks = buildAnswerBlocks(answer);

  // Delete the status message (removes the "edited" label), then post a clean fresh answer
  if (statusTs) {
    await slackRequest('/chat.delete', {
      channel: event.channel,
      ts: statusTs
    }, slackToken).catch(() => {});
  }

  await slackRequest('/chat.postMessage', {
    channel: event.channel,
    thread_ts: event.thread_ts || event.ts,
    text: answer.slice(0, 200),
    blocks
  }, slackToken).catch(() => {});

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
  const { event, token } = req.body;
  if (!event || !token) return res.status(400).json({ error: 'Missing event or token' });

  res.status(200).json({ queued: true });

  processEvent(event, token).catch(err => console.error('[WORKER ERROR]', err.message));
});

app.listen(PORT, () => console.log(`[WORKER] Listening on port ${PORT}`));
