#!/usr/bin/env node
/**
 * HubSpot MCP Server (stdio)
 * Exposes all HubSpot CRM tools for the Claude Agent SDK to consume.
 */

const https = require('https');
const { log } = require('./logger');

// ─── HubSpot API Client ───────────────────────────────────────────────────────

const HUBSPOT_MAX_RETRIES = 3;
const HUBSPOT_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function hubspotBackoffDelay(attempt, retryAfterMs = 0) {
  const base = Math.min(1000 * 2 ** attempt, 8000) + Math.floor(Math.random() * 250);
  return Math.max(base, retryAfterMs);
}

function parseRetryAfterMs(headerValue) {
  if (!headerValue) return 0;
  const seconds = Number(headerValue);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 0;
}

function hubspotRequest(method, path, body = null, _attempt = 0) {
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

    let settled = false;
    const retry = (reason, retryAfterMs = 0) => {
      if (settled) return;
      settled = true;
      if (_attempt < HUBSPOT_MAX_RETRIES) {
        const delay = hubspotBackoffDelay(_attempt, retryAfterMs);
        log('WARN', 'hubspot_retry', { path, attempt: _attempt + 1, delay, reason });
        setTimeout(() => hubspotRequest(method, path, body, _attempt + 1).then(resolve, reject), delay);
      } else {
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      }
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (settled) return;
        try {
          const parsed = JSON.parse(raw);
          if (HUBSPOT_RETRYABLE_STATUS.has(res.statusCode)) {
            retry(`HubSpot ${res.statusCode}: ${parsed.message}`, parseRetryAfterMs(res.headers['retry-after']));
            return;
          }
          if (res.statusCode >= 400) settle(reject, new Error(`HubSpot ${res.statusCode}: ${parsed.message}`));
          else settle(resolve, parsed);
        } catch (e) { settle(reject, e); }
      });
    });

    req.on('error', (err) => retry(err));
    req.setTimeout(15000, () => { req.destroy(); retry(new Error('HubSpot timeout')); });
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

// Drops null/empty-string property values before a HubSpot record is
// returned to Claude — these carry no signal but otherwise get resent in
// full on every loop iteration of a multi-step query.
function compactProps(props) {
  const out = {};
  for (const [k, v] of Object.entries(props || {})) {
    if (v !== null && v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Drops IN filters with no value instead of forwarding them to HubSpot,
// which rejects the entire request with "operator IN requires values".
function buildHubSpotFilters(filterList) {
  return (filterList || [])
    .map(f => {
      if (f.operator === 'IN' && !f.value) return null;
      return {
        propertyName: f.property,
        operator: f.operator,
        ...(f.value !== undefined ? { value: f.operator === 'IN' ? f.value.replace(/,\s*/g, ';') : toHubSpotValue(f.value) } : {}),
        ...(f.high_value !== undefined ? { highValue: toHubSpotValue(f.high_value) } : {})
      };
    })
    .filter(Boolean);
}

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_owners',
    description: 'List HubSpot owners (the sales reps/users assignable as hubspot_owner_id on contacts, companies, and deals). There is no name-based owner filter on HubSpot\'s API — use this to fetch the owner list and match a name to its numeric ID yourself before filtering by ownership. Optionally filter to one owner by exact email.',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Optional — return only the owner with this exact email address.' }
      },
      required: []
    }
  },
  {
    name: 'get_object_properties',
    description: 'List all available properties (including custom ones) for a HubSpot object type. Call this first when you need to filter or retrieve a property whose name you don\'t know (e.g. MQL date, lifecycle stage, source).',
    inputSchema: {
      type: 'object',
      properties: {
        object_type: { type: 'string', enum: ['contacts', 'companies', 'deals', 'meetings'], description: 'The CRM object type' },
        query: { type: 'string', description: 'Optional search term to filter properties by name or label.' },
        include_internal: { type: 'boolean', description: 'Include HubSpot internal (hs_) properties. Default false.', default: false }
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
        object_type: { type: 'string', enum: ['contacts', 'companies', 'deals', 'meetings'], description: 'The CRM object type to search' },
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
    name: 'get_companies_with_deal_properties',
    description: 'Efficiently fetch companies AND their associated deals\' properties in a single batch operation — the reverse direction of get_deals_with_company_properties. Use this when the MOST SELECTIVE filters are on the company side (e.g. "non-ICP companies MQL\'d in 2026 sourced from marketing") rather than the deal side. A company can have multiple deals, so each result has a "deals" array. For cross-object MISMATCH questions (e.g. "deal marked ICP but company marked non-ICP"), pick whichever side (this tool vs get_deals_with_company_properties) has the more selective filters as the search anchor, then check the other side\'s condition on the returned batch yourself — do NOT call get_deal/get_company repeatedly to check records one at a time.',
    inputSchema: {
      type: 'object',
      properties: {
        company_filters: {
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
        company_properties: { type: 'array', items: { type: 'string' } },
        deal_properties: { type: 'array', items: { type: 'string' } },
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
        object_type: { type: 'string', enum: ['contacts', 'companies', 'deals', 'meetings'] },
        object_id: { type: 'string' },
        to_object_type: { type: 'string', enum: ['contacts', 'companies', 'deals', 'meetings'] }
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
    name: 'get_contacts_with_company_properties',
    description: 'Fetch contacts AND their associated company properties in a single batch. Use for questions involving contacts with company-level filters (ICP, revenue, industry) or when you need company name/details alongside contact records. Examples: "CXOs at ICP companies", "contacts spoken to at companies with revenue > $X".',
    inputSchema: {
      type: 'object',
      properties: {
        contact_filters: {
          type: 'array',
          description: 'Filters for contacts — all AND\'d together',
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
        contact_properties: { type: 'array', items: { type: 'string' }, description: 'Contact properties to return.' },
        company_properties: { type: 'array', items: { type: 'string' }, description: 'Company properties to return for each contact\'s associated company.' },
        limit: { type: 'integer', description: 'Max results 1-100 (default 100)', default: 100 },
        after: { type: 'string', description: 'Pagination cursor from a previous response.' }
      },
      required: []
    }
  },
  {
    name: 'get_companies_with_contact_properties',
    description: 'Efficiently fetch companies AND their associated contacts\' properties in a single batch operation — the contact-side mirror of get_companies_with_deal_properties. Use this when the most selective filters are on the company side (e.g. "ICP companies and their key contacts", "non-ICP companies and who we\'ve talked to there") rather than the contact side — for contact-side filters with company context, use get_contacts_with_company_properties instead. A company can have many contacts; each result\'s "contacts" array is capped (default 10, max 25 via max_contacts_per_company) with a "contacts_truncated" flag if more exist. This is an unordered sample, not a "most important" ranking.',
    inputSchema: {
      type: 'object',
      properties: {
        company_filters: {
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
        company_properties: { type: 'array', items: { type: 'string' } },
        contact_properties: { type: 'array', items: { type: 'string' } },
        max_contacts_per_company: { type: 'integer', description: 'Max contacts to return per company, 1-25 (default 10).', default: 10 },
        limit: { type: 'integer', default: 100 },
        after: { type: 'string', description: 'Pagination cursor from a previous response.' }
      },
      required: []
    }
  },
  {
    name: 'count_objects',
    description: 'Get the exact count of objects matching filters WITHOUT returning records. Use for any "how many" question or monthly/periodic breakdown. Returns the accurate total from HubSpot (not capped at 100). Much faster than search_objects when you only need a number.',
    inputSchema: {
      type: 'object',
      properties: {
        object_type: { type: 'string', enum: ['contacts', 'companies', 'deals', 'meetings'], description: 'The CRM object type to count' },
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

async function executeTool(name, input, context = {}) {
  try {
    switch (name) {

      case 'list_owners': {
        const qs = input.email ? `?email=${encodeURIComponent(input.email)}&limit=100` : '?limit=100';
        const res = await hubspotRequest('GET', `/crm/v3/owners${qs}`);
        const owners = (res.results || [])
          .filter(o => !o.archived)
          .map(o => ({ id: o.id, email: o.email, firstName: o.firstName, lastName: o.lastName }));
        return { total: owners.length, owners };
      }

      case 'get_object_properties': {
        const res = await hubspotRequest('GET', `/crm/v3/properties/${input.object_type}`);
        let props = (res.results || [])
          .map(p => ({
            name: p.name,
            label: p.label,
            type: p.type,
            fieldType: p.fieldType,
            // Surfaces real filterable value/label pairs for checkbox and
            // enum properties (e.g. { value: "true", label: "Yes" }) — the
            // display label alone is not always the value HubSpot expects
            // in a filter.
            ...(p.options?.length ? { options: p.options.map(o => ({ value: o.value, label: o.label })) } : {})
          }));
        if (!input.include_internal) {
          props = props.filter(p => !p.name.startsWith('hs_'));
        }
        if (input.query) {
          const q = input.query.toLowerCase();
          props = props.filter(p => p.name.includes(q) || p.label.toLowerCase().includes(q));
        }
        props.sort((a, b) => a.name.localeCompare(b.name));
        return { total: props.length, properties: props };
      }

      case 'search_objects': {
        const filters = buildHubSpotFilters(input.filters);
        const defaultProps = {
          contacts: ['firstname', 'lastname', 'email', 'createdate', 'lifecyclestage', 'hs_lead_status'],
          companies: ['name', 'domain', 'createdate', 'lifecyclestage', 'mql_date', 'is_the_company_icp_'],
          deals: ['dealname', 'dealstage', 'amount', 'closedate', 'pipeline'],
          meetings: ['hs_timestamp', 'hs_meeting_title', 'hs_meeting_start_time', 'hs_meeting_end_time']
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
          results: res.results?.map(r => ({ id: r.id, ...compactProps(r.properties) }))
        };
      }

      case 'get_deals_with_company_properties': {
        const filters = buildHubSpotFilters(input.deal_filters);
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
            companyData[c.id] = { id: c.id, ...compactProps(c.properties) };
          }
        }

        return {
          total: dealSearch.total || deals.length,
          returned: deals.length,
          truncated: (dealSearch.total || 0) > deals.length,
          after: dealSearch.paging?.next?.after || null,
          results: deals.map(d => ({
            deal: { id: d.id, ...compactProps(d.properties) },
            company: dealToCompany[d.id] ? companyData[dealToCompany[d.id]] || null : null
          }))
        };
      }

      case 'get_companies_with_deal_properties': {
        const filters = buildHubSpotFilters(input.company_filters);
        const companyProps = input.company_properties?.length
          ? input.company_properties
          : ['name', 'is_the_company_icp_', 'domain'];
        const companySearch = await hubspotRequest('POST', '/crm/v3/objects/companies/search', {
          limit: Math.min(input.limit || 100, 100),
          properties: companyProps,
          sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
          ...(filters.length > 0 ? { filterGroups: [{ filters }] } : {}),
          ...(input.after ? { after: input.after } : {})
        });
        const companies = companySearch.results || [];
        if (companies.length === 0) return { total: 0, results: [] };

        const assocRes = await hubspotRequest('POST', '/crm/v4/associations/companies/deals/batch/read', {
          inputs: companies.map(c => ({ id: c.id }))
        });
        const companyToDeals = {};
        for (const result of (assocRes.results || [])) {
          companyToDeals[result.from.id] = (result.to || []).map(t => t.toObjectId);
        }
        const dealIds = [...new Set(Object.values(companyToDeals).flat())];

        const dealData = {};
        if (dealIds.length > 0) {
          const dealProps = input.deal_properties?.length
            ? input.deal_properties
            : ['dealname', 'dealstage', 'amount', 'closedate', 'createdate'];
          const dealRes = await hubspotRequest('POST', '/crm/v3/objects/deals/batch/read', {
            inputs: dealIds.map(id => ({ id })),
            properties: dealProps
          });
          for (const d of (dealRes.results || [])) {
            dealData[d.id] = { id: d.id, ...compactProps(d.properties) };
          }
        }

        return {
          total: companySearch.total || companies.length,
          returned: companies.length,
          truncated: (companySearch.total || 0) > companies.length,
          after: companySearch.paging?.next?.after || null,
          results: companies.map(c => ({
            company: { id: c.id, ...compactProps(c.properties) },
            deals: (companyToDeals[c.id] || []).map(id => dealData[id]).filter(Boolean)
          }))
        };
      }

      case 'get_contacts_with_company_properties': {
        const filters = buildHubSpotFilters(input.contact_filters);
        const contactProps = input.contact_properties?.length
          ? input.contact_properties
          : ['firstname', 'lastname', 'email', 'jobtitle', 'createdate', 'hs_linkedin_url'];
        const contactSearch = await hubspotRequest('POST', '/crm/v3/objects/contacts/search', {
          limit: Math.min(input.limit || 100, 100),
          properties: contactProps,
          sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
          ...(filters.length > 0 ? { filterGroups: [{ filters }] } : {}),
          ...(input.after ? { after: input.after } : {})
        });
        const contacts = contactSearch.results || [];
        if (contacts.length === 0) return { total: 0, results: [] };

        const assocRes = await hubspotRequest('POST', '/crm/v4/associations/contacts/companies/batch/read', {
          inputs: contacts.map(c => ({ id: c.id }))
        });
        const contactToCompany = {};
        for (const result of (assocRes.results || [])) {
          const companyIds = (result.to || []).map(t => t.toObjectId);
          if (companyIds.length > 0) contactToCompany[result.from.id] = companyIds[0];
        }
        const companyIds = [...new Set(Object.values(contactToCompany))];

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
            companyData[c.id] = { id: c.id, ...compactProps(c.properties) };
          }
        }

        return {
          total: contactSearch.total || contacts.length,
          returned: contacts.length,
          truncated: (contactSearch.total || 0) > contacts.length,
          after: contactSearch.paging?.next?.after || null,
          results: contacts.map(c => ({
            contact: { id: c.id, ...compactProps(c.properties) },
            company: contactToCompany[c.id] ? companyData[contactToCompany[c.id]] || null : null
          }))
        };
      }

      case 'get_companies_with_contact_properties': {
        const filters = buildHubSpotFilters(input.company_filters);
        const companyProps = input.company_properties?.length
          ? input.company_properties
          : ['name', 'is_the_company_icp_', 'domain'];
        const companySearch = await hubspotRequest('POST', '/crm/v3/objects/companies/search', {
          limit: Math.min(input.limit || 100, 100),
          properties: companyProps,
          sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
          ...(filters.length > 0 ? { filterGroups: [{ filters }] } : {}),
          ...(input.after ? { after: input.after } : {})
        });
        const companies = companySearch.results || [];
        if (companies.length === 0) return { total: 0, results: [] };

        const assocRes = await hubspotRequest('POST', '/crm/v4/associations/companies/contacts/batch/read', {
          inputs: companies.map(c => ({ id: c.id }))
        });
        const maxPerCompany = Math.min(Math.max(input.max_contacts_per_company || 10, 1), 25);
        const companyToContacts = {};
        const contactsTruncated = {};
        for (const result of (assocRes.results || [])) {
          const ids = (result.to || []).map(t => t.toObjectId);
          companyToContacts[result.from.id] = ids.slice(0, maxPerCompany);
          contactsTruncated[result.from.id] = ids.length > maxPerCompany;
        }
        const contactIds = [...new Set(Object.values(companyToContacts).flat())];

        const contactData = {};
        if (contactIds.length > 0) {
          const contactProps = input.contact_properties?.length
            ? input.contact_properties
            : ['firstname', 'lastname', 'email', 'jobtitle'];
          for (const idsChunk of chunk(contactIds, 100)) {
            const contactRes = await hubspotRequest('POST', '/crm/v3/objects/contacts/batch/read', {
              inputs: idsChunk.map(id => ({ id })),
              properties: contactProps
            });
            for (const c of (contactRes.results || [])) {
              contactData[c.id] = { id: c.id, ...compactProps(c.properties) };
            }
          }
        }

        return {
          total: companySearch.total || companies.length,
          returned: companies.length,
          truncated: (companySearch.total || 0) > companies.length,
          after: companySearch.paging?.next?.after || null,
          results: companies.map(c => ({
            company: { id: c.id, ...compactProps(c.properties) },
            contacts: (companyToContacts[c.id] || []).map(id => contactData[id]).filter(Boolean),
            contacts_truncated: !!contactsTruncated[c.id]
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
        return { id: res.id, ...compactProps(res.properties) };
      }

      case 'get_deal': {
        const baseProps = ['dealname', 'dealstage', 'amount', 'closedate', 'pipeline', 'description'];
        const props = [...new Set([...baseProps, ...(input.properties || [])])].join(',');
        const res = await hubspotRequest('GET', `/crm/v3/objects/deals/${input.deal_id}?properties=${props}`);
        return { id: res.id, ...compactProps(res.properties) };
      }

      case 'get_company': {
        const baseProps = ['name', 'domain', 'industry', 'website', 'city', 'country', 'lifecyclestage', 'is_the_company_icp_', 'mql_date', 'lead_priority'];
        const props = [...new Set([...baseProps, ...(input.properties || [])])].join(',');
        const res = await hubspotRequest('GET', `/crm/v3/objects/companies/${input.company_id}?properties=${props}`);
        return { id: res.id, ...compactProps(res.properties) };
      }

      case 'count_objects': {
        const filters = buildHubSpotFilters(input.filters);
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
    log('ERROR', 'hubspot_tool_error', { tool: name, error: err.message, correlation_id: context.correlation_id });
    return { error: err.message };
  }
}

// ─── MCP Server (only when run directly) ────────────────────────────────────

if (require.main === module) {
  const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
  const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

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

  const transport = new StdioServerTransport();
  server.connect(transport).catch(err => {
    log('ERROR', 'mcp_stdio_start_failed', { error: err.message });
    process.exit(1);
  });
}

module.exports = { TOOLS, executeTool };
