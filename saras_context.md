---
title: Saras HubSpot Context Layer
purpose: Semantic context layer for the Saras HubSpot CRM Agent
version: 2.0
objects: [Company, Contact, Deal]
key_metrics: [MQL, ICP_MQL, SQL, MQO, ICP, Lead_Priority, Pipeline, ARR]
last_verified: 2026-06-20
---

# Saras HubSpot Context Layer

> **AGENT INSTRUCTIONS — READ FIRST**
>
> This file is a **semantic context layer**, not a capability boundary.
>
> **USE THIS FILE** to interpret Saras-specific business terms (MQL, ICP, SQL, Lead Priority, etc.) and to know the correct internal property names and enum values for custom Saras properties.
>
> **FOR ALL OTHER QUESTIONS**: use your tools directly (`search_objects`, `count_objects`, `get_object_properties`, `get_deals_with_company_properties`, `get_contacts_with_company_properties`, `get_company`, `get_contact`, `get_deal`, `get_associations`). You are NOT limited to properties or queries listed here.
>
> **Example of how to combine both:**
> *"List CXOs my team has spoken to in the last 3 months who are ICP with their brand name and LinkedIn"*
> → ICP definition = this file: `is_the_company_icp` = `Yes` on Contact (or `is_the_company_icp_` on Company)
> → "spoken to" = `notes_last_contacted` on Contact, filter last 90 days
> → CXO filter = `jobtitle` CONTAINS_TOKEN CEO/CFO/CTO/CMO/COO on Contact
> → Use `get_contacts_with_company_properties` to get contacts with company `name` and `is_the_company_icp_` in one call
> → LinkedIn = `hs_linkedin_url` on Contact; brand = associated Company `name`

---

## SECTION 1 — AGENT QUICK REFERENCE

Saras business metrics and their exact HubSpot filter rules. Start here for any metric question.

| Metric | Object | HubSpot Rule | Key Properties |
|---|---|---|---|
| **MQL** | Company | `mql_date` IS NOT NULL | `mql_date` |
| **ICP MQL** | Company | `mql_date` IS NOT NULL AND `is_the_company_icp_` = `Yes` | `mql_date`, `is_the_company_icp_` |
| **SQL** | Deal | `dealstage` = `qualifiedtobuy` (Functional Win) in Sales Pipeline | `dealstage`, `pipeline` = `default` |
| **MQO** | Deal | `dealstage` = `152224771` (MQO stage) in Sales Pipeline | `dealstage` |
| **ICP (company)** | Company | `is_the_company_icp_` = `Yes` | `is_the_company_icp_` |
| **ICP (contact)** | Contact | `is_the_company_icp` = `Yes` | `is_the_company_icp` |
| **ICP (deal)** | Deal | `is_the_company_icp__` = `Yes` | `is_the_company_icp__` |
| **Marketing Pipeline** | Deal | `deal_source` = `Inbound`, `pipeline` = `default`, stage ≠ closed lost | `deal_source`, `amount` |
| **Lead Priority** | Company/Contact | `lead_priority` enum | `lead_priority` |
| **Immediate Priority** | Company/Contact | `lead_priority` = `Immediate` | `lead_priority`, `reason_for_immediate` |
| **ARR / Deal Value** | Deal | `amount` on deal | `amount` |
| **Churn** | Deal | `dealstage` = `175526434` (Churn) — prefer this deal-level check; only use Company `lifecyclestage` = `1140600340` if asking about the company's overall relationship status, not a specific deal | `dealstage`, `churn_reason` |

> For questions not listed here, compose queries using `search_objects`, `count_objects`, or `get_object_properties` directly.

---

## SECTION 1B — TERM ALIASES & COMMON MISTAKES

When a user uses natural language terms, map them as follows. The **Do NOT** rules are critical — these are the wrong properties Claude would otherwise guess. These aliases are for natural-language phrasing — if the user's wording looks like it's quoting an exact property label (specific casing, units like "(USD)", quotation marks), verify that literal property exists via `get_object_properties` first (once per object type for this question — reuse the result, don't re-check it); a real matching HubSpot property wins over the heuristic mapping below.

| User Says | Correct Property | Object | Do NOT Use |
|---|---|---|---|
| "revenue" / "annual revenue" / "estimated yearly sales" / "yearly sales" | `estimated_yearly_sales__2025_` | Company | `amount`, `revenue`, `annual_revenue` |
| "source" / "source 1" / "standard source 1" / "original source" | `standard_source_1` | Company | `source_1`, `hs_analytics_source` |
| "deal source" / "how the deal came in" | `deal_source` | Deal | `standard_source_1`, `source_1` |
| "MQL" / "marketing qualified lead" / "MQLs" | `mql_date` IS NOT NULL (`HAS_PROPERTY`) | **Company only** — always query the Company object, never Contact | **Do NOT** filter by `lifecyclestage = 'marketingqualifiedlead'` — that stage triggers `mql_date` but is not the source of truth |
| "ICP" / "ICP company" | `is_the_company_icp_` = `Yes` | Company | **Do NOT** use `icp`, `hs_ideal_customer_profile`, or any other field — only `is_the_company_icp_` is authoritative |
| "ICP contact" | `is_the_company_icp` = `Yes` | Contact | Note: one fewer trailing underscore than the Company version |
| "ICP deal" | `is_the_company_icp__` = `Yes` | Deal | Note: two trailing underscores |
| "marketing source" / "marketing sourced" | `standard_source_1` = `Marketing` on Company; then `standard_source_2` for sub-channel breakdown | Company | `deal_source = 'Inbound'` is the deal-level equivalent, not the same thing |
| "CXO" / "C-level" / "C-suite" / "executives" | `jobtitle` CONTAINS_TOKEN each of: `CEO`, `CFO`, `CTO`, `CMO`, `COO`, `Chief` | Contact | Search per title separately, combine and deduplicate by contact ID |
| "spoken to" / "contacted" / "reached out to" | `notes_last_contacted` with date range filter | Contact, Company | Use GTE for start date |
| "brand" / "brand name" / "company name" (in contact context) | Get associated Company `name` via `get_contacts_with_company_properties` | Contact→Company | Do NOT use the Contact `company` field — it's a free-text string, not a live association |
| "owner" / "who owns this deal/company" / "[rep name]'s deals" | `hubspot_owner_id` (confirm via `get_object_properties`) | Contact, Company, Deal | Resolve rep name → ID via `list_owners` first, then filter |
| "meetings booked" / "meeting booked date" | Curated Contact/Company property (verify via `get_object_properties`, query "meeting" — look for "Last Booked Meeting Date" / "Date of last meeting booked in meetings tool") | Contact, Company | Do NOT default to the raw Meetings engagement object's `hs_timestamp` — it includes non-sales meetings and can wildly overcount; see Funnel Milestone playbook for the full fallback order |

---

## SECTION 3 — HUBSPOT OBJECTS

| Object | Represents | Primary Use | Authoritative Field |
|---|---|---|---|
| **Company** | An organization / brand | Primary qualification unit; company `lifecyclestage` is authoritative | `lifecyclestage`, `is_the_company_icp_` |
| **Contact** | An individual person at a company | Outreach execution and communication tracking | `hs_lead_status` |
| **Deal** | A commercial opportunity | Revenue, pipeline, forecasting, win/loss | `dealstage`, `amount` |

Associations are critical: contacts must be linked to their company; deals must reference the correct company; relevant contacts must be on each deal.

**Products**: Pulse / Saras IQ (BI for D2C/e-commerce brands) · Daton (data pipeline, separate pipeline)

---

## SECTION 4 — METRIC DEFINITIONS

### MQL — Marketing Qualified Lead

- **Object**: Company
- **Rule**: `mql_date` IS NOT NULL
- **Set by**: Automated workflow — stamps `mql_date` when `lifecyclestage` transitions to any of: `marketingqualifiedlead`, `2883794641` (First Meeting Booked), `opportunity`
- **Count query**: `SELECT COUNT(*) FROM COMPANY WHERE mql_date IS NOT NULL`
- **Note**: MQL is tracked at company level, not contact level

---

### ICP MQL

- **Object**: Company
- **Rule**: `mql_date` IS NOT NULL **AND** `is_the_company_icp_` = `Yes`
- **Not a property** — applied as a combined filter
- **Count query**: `SELECT COUNT(*) FROM COMPANY WHERE mql_date IS NOT NULL AND is_the_company_icp_ = 'Yes'`

---

### SQL — Sales Qualified Lead

- **Object**: Deal
- **Rule**: `dealstage` = `qualifiedtobuy` (Functional Win) in `pipeline` = `default`
- **Trigger**: Deal advances from Objective Win → Functional Win
- **Meaning**: Qualified fit confirmed; real buying intent established

---

### MQO — Marketing Qualified Opportunity

- **Object**: Deal
- **Rule**: `dealstage` = `152224771` (MQO stage) in `pipeline` = `default`
- **Business meaning**: Prospect had a meeting booked (Objective Win) but did not show up
- **Lifecycle impact**: Company `lifecyclestage` → `1140527923` (Nurture); Lead Status → `New` or `Future Interest`
- **Reason captured in**: `mqo_reason` (enum) + `mqo_observation` (free text)

---

### ICP — Ideal Customer Profile

**ICP Flag Properties** (three levels — same question, different object):

| Object | Internal Name | Set By |
|---|---|---|
| **Company** | `is_the_company_icp_` | Automated ICP workflow |
| Contact | `is_the_company_icp` | Marketing team |
| Deal | `is_the_company_icp__` | Sales rep (verified on call) |

Values: `Yes` / `No`

**ICP Workflow Decision Tree** — Company must pass ALL three:

```
ICP CHECK (company must pass ALL THREE):
  1. country IN:
       US: "United States" | "US" | "USA" | "U.S." | "America"
       UK: "United Kingdom" | "UK" | "Great Britain" | "Britain" | "England"
       Canada: "Canada" | "CA" | "CAN"
  2. sales_channels INCLUDES "Shopify"
  3. estimated_yearly_sales__2025_ BETWEEN 15,000,000 AND 500,000,000

PASS ALL → is_the_company_icp_ = Yes  → proceed to scoring
FAIL ANY → is_the_company_icp_ = No   → icp_fit_score = 0, lead_priority = Disqualified
```

---

### ICP Fit Score & Lead Scoring

- **Company property**: `icp_fit_score` (Number, auto-set)
- **Contact property**: `saras_icp` (Number)

**Consolidated Scoring Table**:

| Category | Signal | Points | Property |
|---|---|---|---|
| **Immediate Triggers** (skip scoring, set priority = Immediate) | New CFO joined (3–12 mo) | — | `has_a_cfo_who_joined_in_the_last_3_12_months` |
| | New CEO joined (3–12 mo) | — | `has_a_ceo_who_joined_in_the_last_3_12_months` |
| | Employee came from Saras customer | — | `customer_employee_moved_here` |
| | Employee left to Saras customer | — | `employee_moved_from_here_to_customer` |
| | Middleman intro identified | — | `middlemen_identified_for_introductions` |
| | Referral | — | `reason_for_immediate` = `Referral` |
| **Industry** | Health & Wellness | +15 | `industry` |
| | Apparel | +12 | `industry` |
| | Home & Kitchen | +12 | `industry` |
| | Sports Apparel | +10 | `industry` |
| | Food & Beverages | +10 | `industry` |
| | Beauty / Cosmetics | +8 | `industry` |
| | Subscription Brand | +8 | `industry` |
| **Firmographic** | Sells on Amazon / Walmart / TikTok alongside Shopify | +12 | `sales_channels` |
| | YoY revenue growth > 8% | +10 | `estimated_yearly_sales__2025_` |
| | Product Bundles / Personalization | +8 | — |
| | More than 100 SKUs | +6 | — |
| **Secondary Signals** | Head of Data joined (3–12 mo) | +6 | `has_a_head_of_data_who_joined_in_the_last_3_12_months` |
| | Migrated to Shopify (3–6 mo) | +6 | `has_migrated_to_shopify_platform_in_the_last_3_6_months` |
| | CMO joined (3–12 mo) | +5 | `has_a_cmo_who_joined_in_the_last_3_12_months` |
| | Partner tech: Klaviyo, Recharge, Blotout, Skio, StayAI, Loop | +5 | `has_our_partner_tech__klaviyo__recharge__blotout__skio__stayai__loop` |
| | Competitor tech: Northbeam, TripleWhale, Polar Analytics | +5 | `has_our_competitors__northbeam__triplewhale__polar_analytics` |
| | Tech-stack fit: TikTok Shop, Applovin, Fulfil, Fairing, Gorgias, Postscript, Netsuite | +3 | `has_tech_stack_fit__tiktok_shop__applovin__fulfil__fairing__gorgias__postscript__netsuite` |

**Freshness guard**: ~15 point decay if no new signal in 45–90 days. Exec change signals auto-clear after 3–6 months.

---

### Lead Priority

| Property | Internal Name | Object | Values |
|---|---|---|---|
| Lead Priority | `lead_priority` | Company, Contact | `Immediate` / `High` / `Medium` / `Low` / `Disqualified` |
| Reason for Immediate | `reason_for_immediate` | Company, Contact | `Exec Change` / `Warm Path` / `Referral` |

| Priority | Trigger | First Touch SLA |
|---|---|---|
| `Immediate` | Any Immediate Trigger (exec change / warm path / referral) | ≤ 2 business hours |
| `High` | `icp_fit_score` ≥ 60 OR high intent (demo booked, pricing inquiry, trial) | ≤ 8 business hours |
| `Medium` | Score 30–59 OR active evaluation (webinars, case studies) | ≤ 2 business days |
| `Low` | Score 10–29 OR passive (blog reads, light visits) | Newsletter / nurture only |
| `Disqualified` | Failed ICP gate | Suppressed |

---

## SECTION 5 — DEAL STAGE LOGIC

### Pipelines

| Pipeline Name | Internal Value | Purpose |
|---|---|---|
| Sales Pipeline | `default` | Primary new business pipeline |
| Daton Pipeline | `2296560372` | Product-led / trial-based (Daton product) |
| Product Renewals & Expansion | `10303360` | Renewal and expansion deals |
| Renewal & Expansion | `638550298` | Renewal and expansion deals |

### Stage Flow — Sales Pipeline (`pipeline = default`)

```
SUCCESS PATH (in order):
  Objective Win → Functional Win (SQL) → Value Win → Commercial Win → Legal Win → Closed Won

STAGE ORDERING (for "moved past X" / "after X" queries):
  "Past Objective Win"  = IN: qualifiedtobuy, presentationscheduled, 28218292, contractsent, closedwon
  "Past Functional Win" = IN: presentationscheduled, 28218292, contractsent, closedwon
  "Past Value Win"      = IN: 28218292, contractsent, closedwon
  "Past Commercial Win" = IN: contractsent, closedwon
  "Past Legal Win"      = IN: closedwon
  Do NOT include closedlost, MQO, DQ, Sales Nurture, Dead/Duplicate — those are exit paths, not progression.

EXCEPTION PATHS:
  Objective Win → MQO              (no-show; company → Nurture lifecycle)
  Objective Win → DQ               (disqualified on call)
  Objective Win → Junk             (invalid lead)
  Obj/Func/Value Win → Sales Nurture   (not ready; long-term nurture)
  Any active stage → Closed Lost
```

### Stage Definitions with Internal Values

| Deal Stage | Internal `dealstage` Value | Business Meaning |
|---|---|---|
| Objective Win | `appointmentscheduled` | First discovery call complete; prospect engaged |
| Functional Win | `qualifiedtobuy` | **SQL** — qualified fit confirmed; real buying intent |
| Value Win | `presentationscheduled` | Business case / ROI agreed |
| Commercial Win | `28218292` | Pricing and commercial terms agreed |
| Legal Win | `contractsent` | Contract / legal review complete |
| Closed Won | `closedwon` | Deal signed |
| Closed Lost | `closedlost` | Lost — competitor, no decision, budget, etc. |
| MQO | `152224771` | Meeting scheduled; prospect no-showed |
| Sales Nurture | `217786505` | Not ready now; long-term nurture |
| Dead/Duplicate | `28023967` | Stale or duplicate deal |
| DQ | `175509306` | Disqualified — not a fit |
| Churn | `175526434` | Customer churned deal |

> Trial/Signup belongs to the **Daton Pipeline** only — not used in Sales Pipeline.

### Stage ↔ Lifecycle Stage ↔ Lead Status Correlation

| Deal Stage | Lifecycle Stage | Lead Status |
|---|---|---|
| No deal; outreach active | `lead` / `marketingqualifiedlead` | New / In Progress / Attempted to Connect / Contacted / Interested / No response / Future Interest |
| Objective Win | `2883794641` (First Meeting Booked) | Call booked |
| Functional Win, Commercial Win, Legal Win | `opportunity` | Open Deal |
| Closed Won | `customer` | Customer |
| Closed Lost | `1140600339` (Closed Lost) | Closed Lost |
| MQO, Sales Nurture | `1140527923` (Nurture) | New / Future Interest / No response |
| DQ | `1140527924` (DQ/Duplicate) | Not interested/DQ |
| Dead/Duplicate | `1140527923` (Nurture) | Future Interest / No response |
| Churn | `1140600340` (Churn) | Churn |

> **Funnel counting note**: Both deal stage and lifecycle stage reflect current position, not history. A deal that was at Objective Win and moved to Sales Nurture or DQ still had its first meeting. A company that moved from opportunity to nurture lifecycle still had its first meeting.
>
> **First meeting happened** = company has a deal in Sales Pipeline (`pipeline = default`) at any stage EXCEPT: MQO (`152224771`) — no-show, meeting never occurred; Dead/Duplicate (`28023967`) — stale/invalid.
> Full dealstage IN list: `appointmentscheduled, qualifiedtobuy, presentationscheduled, 28218292, contractsent, closedwon, closedlost, 217786505, 175509306, 175526434`
>
> **MQO ≠ first meeting**: MQO means the meeting was booked (Objective Win) but the prospect no-showed. Never count MQO deals when answering "how many booked/had their first meeting."

---

## SECTION 6 — LIFECYCLE STAGES

Property `lifecyclestage` — same values on Company and Contact. **Company-level is authoritative.**

| Display Label | Internal Value | Notes |
|---|---|---|
| Lead | `lead` | Fresh lead; no qualification yet |
| Marketing Qualified Lead | `marketingqualifiedlead` | Triggers `mql_date` on company |
| First Meeting Booked | `2883794641` | Meeting scheduled — also triggers `mql_date` |
| Opportunity | `opportunity` | Active deal at FW/CW/LW — also triggers `mql_date` |
| Customer | `customer` | Closed Won |
| Closed Lost | `1140600339` | Lost deal |
| DQ/Duplicate | `1140527924` | Disqualified or duplicate |
| Nurture | `1140527923` | Long-term nurture (MQO / Sales Nurture outcomes) |
| Junk | `1140689223` | Invalid / spam |
| Churn | `1140600340` | Former customer churned |
| Partner/Advisor/Consultant | `2048777924` | Non-customer relationship |
| Event Outreach | `2242461411` | Sourced from an event |

---

## SECTION 7 — LEAD STATUS

Property `hs_lead_status` — **Contact level only**. Tracks outreach execution state, not funnel position.

| Display Label | Internal Value | Meaning |
|---|---|---|
| New | `New` | No outreach yet |
| In Progress | `In Progress` | BDR / SDR working the contact |
| Attempted to Connect | `Attempted to Connect` | Calls made; no connection yet |
| Contacted | `Contacted` | Spoken; conversation in progress |
| Interested | `Interested` | Interested; meeting not yet booked |
| Call booked | `Call booked` | Meeting / discovery call booked |
| Not interested/DQ | `Not interested/DQ` | Not interested or disqualified |
| No response | `No response` | No reply from lead |
| Junk | `Junk` | Invalid / junk lead |
| Future Interest | `Future Interest` | Asked to be contacted later |
| Open Deal | `Open Deal` | Active deal — auto-set |
| Customer | `Customer` | Closed Won — auto-set |
| Closed Lost | `Closed Lost` | Deal closed lost |
| Churn | `Churn` | Customer churned |
| Partner/Advisor/Consultant | `Partner/Advisor/Consultant` | Non-customer relationship |
| Disqualified | `Disqualified` | Formally disqualified |
| Nurture | `Nurture` | Long-term nurture |

---

## SECTION 8 — SOURCE ATTRIBUTION

> **Agent disambiguation**: When a user says "source" without specifying an object, use `standard_source_1` for Company and `deal_source` for Deal. "Marketing sources" means `standard_source_1 = 'Marketing'` on Company — the specific channel breakdown is in `standard_source_2` (Email, SEO, Webinar, PPC, etc.).

### Company Sources

Set at the **Company** level to track how a company entered the CRM.

| Property | Internal Name | Set By | Values |
|---|---|---|---|
| Standard Source 1 | `standard_source_1` | Automated workflow | `Referral` / `Events` / `Marketing` |
| Standard Source 2 | `standard_source_2` | Manually (Manas) | `Customer` / `Partner` / `Internal` / `Email` / `SEO` / `Webinar` / `Social Media` / `PPC` / `Sponsorship` / `Direct Traffic` / `Others` |
| Standard Source 3 | `standard_source_3` | Manually (Manas) | Free text — specific detail (event name, person, etc.) |

### Contact Sources

**HubSpot native** (first-touch web attribution):

| Property | Internal Name |
|---|---|
| Original Traffic Source | `hs_analytics_source` |
| Original Traffic Source Drill-Down 1 | `hs_analytics_source_data_1` |
| Original Traffic Source Drill-Down 2 | `hs_analytics_source_data_2` |

**Saras custom** (outbound vs. inbound categorization):

| Property | Internal Name | Values (exact case) |
|---|---|---|
| Source 1 | `source_1` | `Inbound` / `Outbound` |
| Source 2 | `source_2` | `referral` / `SEO` / `Webinar` / `Email` / `Social Media` / `PPC` / `Sponsorship` / `Mark` / `Brian` |
| Source 3 | `source_3` | `Customer` / `Partner` / `website, LLM` / `Saras, LT` / `LinkedIn, Google` / `Operators Pod` |

### Deal Sources

**Deal Source** (`deal_source`) — primary channel, set by sales rep at deal creation:

| Internal Value | Display Label | Meaning |
|---|---|---|
| `Inbound` | Mx - Inbound | Marketing-sourced |
| `Events` | Ex - Sales Led Events | Event or conference |
| `Outbound` | Outbound | SDR / AE outbound prospecting |
| `Referral` | Px - Referrals | Partner or customer referral |
| `Sales Led` | Sx - Sales Led | Direct sales outreach |
| `Founders Led` | Fx - Founders Led | Founder-led relationship |
| `Affiliates` | Affiliates | Affiliate channel |

**Deal Source 2** (`deal_source___2`) — specific sub-source (partner, event, or person name). Picklist includes: Recharge, Shopify, Loop, Klaviyo, Skio, Blotout, Shoptalk, SubSummit, Etail, Prosper Show, LinkedIn, Organic Search, Google Search Ads, Chat GPT/ AI search, and 100+ individual names. Query live for full list.

---

## SECTION 9 — PRODUCT OFFERING

Tracked at the **Deal** level — which Saras product is being sold.

| Property | Internal Name | Object | Values |
|---|---|---|---|
| Saras Offering | `daton_subscription` | Deal | Daton Enterprise / Daton Business / Saras Pulse / Saras IQ / Pulse Essentials / Daton Growth / ChargeBee – Business / ChargeBee – Growth / ChargeBee – Starter / ChargeBee – Lite / Consulting / DE / Pulse Implementation / Product Referral |
| Product Name | `product_name` | Company, Deal | Pulse / Daton / iQ / Daton Embed (Company); Pulse / Others / NA (Deal) |

**Revenue / ARR**: `amount` on Deal = contract value / ARR per deal. Billing source of truth is Chargebee (not directly synced to HubSpot).

---

> For any property not listed in this file, use `get_object_properties` to discover the exact name and type.
