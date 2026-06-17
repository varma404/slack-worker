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
        // Return name, label, type — skip internal hs_ prefixed calculated fields to keep response small
        const props = (res.results || [])
          .map(p => ({ name: p.name, label: p.label, type: p.type, fieldType: p.fieldType }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return { total: props.length, properties: props };
      }

      case 'search_objects': {
        // Auto-convert ISO date strings to HubSpot ms-since-epoch format
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

async function askClaude(question) {
  const messages = [{ role: 'user', content: question }];
  const now = new Date().toISOString();

  for (let i = 0; i < 6; i++) {
    const response = await claude.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 2048,
      system: `You are a HubSpot CRM assistant for Saras Analytics. Responses are shown in Slack.

SARAS ANALYTICS — HUBSPOT PROPERTY MAPPINGS:
${process.env.HUBSPOT_CONTEXT || '(none configured)'}
Always use the mapped property name when a user asks about a business term listed above.

SLACK FORMATTING RULES — follow strictly:
- Bold: *text* (single asterisk, NOT double **)
- Bullet lists: start lines with •
- Numbered lists: 1. 2. 3.
- NO markdown tables (no | pipes) — use numbered lists instead
- NO ## or # headers — use *Bold Title* on its own line
- Keep responses concise and scannable

Current date/time: ${now}
Always use tools to fetch actual data — never say you "don't have access".`,
      tools: TOOL_DEFINITIONS,
      messages
    });

    if (response.stop_reason === 'end_turn') {
      const text = response.content.find(b => b.type === 'text');
      return text?.text || 'Done.';
    }

    if (response.stop_reason !== 'tool_use') {
      const text = response.content.find(b => b.type === 'text');
      return text?.text || 'Done.';
    }

    // Execute all tool calls
    const toolCalls = response.content.filter(b => b.type === 'tool_use');
    const toolResults = [];

    for (const call of toolCalls) {
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

  // Hourglass while thinking
  await slackRequest('/reactions.add', { channel: event.channel, timestamp: event.ts, name: 'hourglass_flowing_sand' }, slackToken).catch(() => {});

  let answer;
  try {
    answer = await askClaude(question);
  } catch (err) {
    console.error('[PROCESS] Claude error:', err.message);
    answer = `Sorry, I ran into an error: ${err.message}`;
  }

  // Post reply in thread
  await slackRequest('/chat.postMessage', {
    channel: event.channel,
    thread_ts: event.thread_ts || event.ts,
    text: answer,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: answer } }]
  }, slackToken);

  // Remove hourglass
  await slackRequest('/reactions.remove', { channel: event.channel, timestamp: event.ts, name: 'hourglass_flowing_sand' }, slackToken).catch(() => {});

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
