#!/usr/bin/env node
/**
 * HubSpot MCP Server (stdio)
 * Exposes all HubSpot CRM tools for the Claude Agent SDK to consume.
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const https = require('https');

// ─── HubSpot API Client ───────────────────────────────────────────────────────

function hubspotRequest(method, path, body = null, _retry = false) {
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
          if (res.statusCode === 429 && !_retry) {
            setTimeout(() => hubspotRequest(method, path, body, true).then(resolve, reject), 1000);
            return;
          }
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

function toHubSpotValue(v) {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return String(new Date(v + 'T00:00:00Z').getTime());
  }
  return v;
}

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'get_object_properties',
    description: 'List all available properties (including custom ones) for a HubSpot object type. Call this first when you need to filter or retrieve a property whose name you don\'t know (e.g. MQL date, lifecycle stage, source).',
    inputSchema: {
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
    inputSchema: {
      type: 'object',
      properties: {
        object_type: { type: 'string', enum: ['contacts', 'companies', 'deals'], description: 'The CRM object type to search' },
        filters: {
          type: 'array',
          description: 'Filters — all AND\'d together',
          items: {
            type: 'object',
            properties: {
              property: { type: 'string' },
              operator: { type: 'string', enum: ['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'IN', 'HAS_PROPERTY', 'NOT_HAS_PROPERTY', 'CONTAINS_TOKEN', 'NOT_CONTAINS_TOKEN'] },
              value: { type: 'string' },
              high_value: { type: 'string' }
            },
            required: ['property', 'operator']
          }
        },
        properties: { type: 'array', items: { type: 'string' }, description: 'Property names to return in results.' },
        sort_by: { type: 'string', description: 'Property to sort by (default: createdate)' },
        sort_direction: { type: 'string', enum: ['ASCENDING', 'DESCENDING'] },
        limit: { type: 'integer', description: 'Max results 1-100 (default 100)', default: 100 },
        after: { type: 'string', description: 'Pagination cursor from a previous response to get the next page of results.' }
      },
      required: ['object_type']
    }
  },
  {
    name: 'get_deals_with_company_properties',
    description: 'Efficiently fetch deals AND their associated company properties in a single batch operation. Use this for ANY cross-object question involving deals and companies — e.g. "deals where company is ICP", "deals where company revenue > X". Far more efficient than fetching associations one-by-one.',
    inputSchema: {
      type: 'object',
      properties: {
        deal_filters: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              property: { type: 'string' },
              operator: { type: 'string', enum: ['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'IN', 'HAS_PROPERTY', 'NOT_HAS_PROPERTY', 'CONTAINS_TOKEN', 'NOT_CONTAINS_TOKEN'] },
              value: { type: 'string' },
              high_value: { type: 'string' }
            },
            required: ['property', 'operator']
          }
        },
        deal_properties: { type: 'array', items: { type: 'string' } },
        company_properties: { type: 'array', items: { type: 'string' } },
        limit: { type: 'integer', default: 100 },
        after: { type: 'string', description: 'Pagination cursor from a previous response to get the next page.' }
      },
      required: []
    }
  },
  {
    name: 'get_associations',
    description: 'Get objects associated with a given HubSpot record (e.g. find the company linked to a deal, or contacts linked to a company).',
    inputSchema: {
      type: 'object',
      properties: {
        object_type: { type: 'string', enum: ['contacts', 'companies', 'deals'] },
        object_id: { type: 'string' },
        to_object_type: { type: 'string', enum: ['contacts', 'companies', 'deals'] }
      },
      required: ['object_type', 'object_id', 'to_object_type']
    }
  },
  {
    name: 'get_contact',
    description: 'Get full details for a specific contact by HubSpot ID.',
    inputSchema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string' },
        properties: { type: 'array', items: { type: 'string' } }
      },
      required: ['contact_id']
    }
  },
  {
    name: 'get_deal',
    description: 'Get full details for a specific deal by HubSpot ID.',
    inputSchema: {
      type: 'object',
      properties: {
        deal_id: { type: 'string' },
        properties: { type: 'array', items: { type: 'string' } }
      },
      required: ['deal_id']
    }
  },
  {
    name: 'get_company',
    description: 'Get full details for a specific company by HubSpot ID.',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: { type: 'string' },
        properties: { type: 'array', items: { type: 'string' } }
      },
      required: ['company_id']
    }
  },
  {
    name: 'count_objects',
    description: 'Get the exact count of objects matching filters WITHOUT returning records. Use for any "how many" question or monthly/periodic breakdown. Returns the accurate total from HubSpot (not capped at 100). Much faster than search_objects when you only need a number.',
    inputSchema: {
      type: 'object',
      properties: {
        object_type: { type: 'string', enum: ['contacts', 'companies', 'deals'], description: 'The CRM object type to count' },
        filters: {
          type: 'array',
          description: 'Filters — all AND\'d together',
          items: {
            type: 'object',
            properties: {
              property: { type: 'string' },
              operator: { type: 'string', enum: ['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'IN', 'HAS_PROPERTY', 'NOT_HAS_PROPERTY', 'CONTAINS_TOKEN', 'NOT_CONTAINS_TOKEN'] },
              value: { type: 'string' },
              high_value: { type: 'string' }
            },
            required: ['property', 'operator']
          }
        }
      },
      required: ['object_type']
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
        const filters = (input.filters || []).map(f => ({
          propertyName: f.property,
          operator: f.operator,
          ...(f.value !== undefined ? { value: f.operator === 'IN' ? f.value.replace(/,\s*/g, ';') : toHubSpotValue(f.value) } : {}),
          ...(f.high_value !== undefined ? { highValue: toHubSpotValue(f.high_value) } : {})
        }));
        const defaultProps = {
          contacts: ['firstname', 'lastname', 'email', 'createdate', 'lifecyclestage', 'hs_lead_status'],
          companies: ['name', 'domain', 'createdate', 'lifecyclestage', 'mql_date', 'is_the_company_icp_'],
          deals: ['dealname', 'dealstage', 'amount', 'closedate', 'pipeline']
        };
        const properties = input.properties?.length
          ? input.properties
          : defaultProps[input.object_type] || ['createdate'];
        const body = {
          limit: Math.min(input.limit || 100, 100),
          properties,
          sorts: [{ propertyName: input.sort_by || 'createdate', direction: input.sort_direction || 'DESCENDING' }],
          ...(filters.length > 0 ? { filterGroups: [{ filters }] } : {}),
          ...(input.after ? { after: input.after } : {})
        };
        const res = await hubspotRequest('POST', `/crm/v3/objects/${input.object_type}/search`, body);
        const total = res.total || 0;
        const returned = res.results?.length || 0;
        return {
          total,
          returned,
          truncated: total > returned,
          after: res.paging?.next?.after || null,
          results: res.results?.map(r => ({ id: r.id, ...r.properties }))
        };
      }

      case 'get_deals_with_company_properties': {
        const filters = (input.deal_filters || []).map(f => ({
          propertyName: f.property,
          operator: f.operator,
          ...(f.value !== undefined ? { value: f.operator === 'IN' ? f.value.replace(/,\s*/g, ';') : toHubSpotValue(f.value) } : {}),
          ...(f.high_value !== undefined ? { highValue: toHubSpotValue(f.high_value) } : {})
        }));
        const dealProps = input.deal_properties?.length
          ? input.deal_properties
          : ['dealname', 'dealstage', 'amount', 'closedate', 'createdate'];
        const dealSearch = await hubspotRequest('POST', '/crm/v3/objects/deals/search', {
          limit: Math.min(input.limit || 100, 100),
          properties: dealProps,
          sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
          ...(filters.length > 0 ? { filterGroups: [{ filters }] } : {}),
          ...(input.after ? { after: input.after } : {})
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

        return {
          total: dealSearch.total || deals.length,
          returned: deals.length,
          truncated: (dealSearch.total || 0) > deals.length,
          after: dealSearch.paging?.next?.after || null,
          results: deals.map(d => ({
            deal: { id: d.id, ...d.properties },
            company: dealToCompany[d.id] ? companyData[dealToCompany[d.id]] || null : null
          }))
        };
      }

      case 'get_associations': {
        const res = await hubspotRequest('GET', `/crm/v3/objects/${input.object_type}/${input.object_id}/associations/${input.to_object_type}`);
        return { total: (res.results || []).length, ids: (res.results || []).map(r => r.id) };
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
        const baseProps = ['name', 'domain', 'industry', 'website', 'city', 'country', 'lifecyclestage', 'is_the_company_icp_', 'mql_date', 'lead_priority'];
        const props = [...new Set([...baseProps, ...(input.properties || [])])].join(',');
        const res = await hubspotRequest('GET', `/crm/v3/objects/companies/${input.company_id}?properties=${props}`);
        return { id: res.id, ...res.properties };
      }

      case 'count_objects': {
        const filters = (input.filters || []).map(f => ({
          propertyName: f.property,
          operator: f.operator,
          ...(f.value !== undefined ? { value: f.operator === 'IN' ? f.value.replace(/,\s*/g, ';') : toHubSpotValue(f.value) } : {}),
          ...(f.high_value !== undefined ? { highValue: toHubSpotValue(f.high_value) } : {})
        }));
        const body = {
          limit: 1,
          properties: ['hs_object_id'],
          ...(filters.length > 0 ? { filterGroups: [{ filters }] } : {})
        };
        const res = await hubspotRequest('POST', `/crm/v3/objects/${input.object_type}/search`, body);
        return { total: res.total || 0 };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    process.stderr.write(`[MCP] Tool error ${name}: ${err.message}\n`);
    return { error: err.message };
  }
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'hubspot', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const result = await executeTool(name, args || {});
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    isError: !!result.error
  };
});

if (require.main === module) {
  const transport = new StdioServerTransport();
  server.connect(transport).catch(err => {
    process.stderr.write(`[MCP] Failed to start: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { TOOLS, executeTool };
