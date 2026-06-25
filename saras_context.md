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
> **FOR ALL OTHER QUESTIONS**: use HubSpot MCP tools directly (`query_crm_data`, `search_properties`, `search_crm_objects`, `get_crm_objects`, `get_properties`). You are NOT limited to properties or queries listed here.
>
> **Example of how to combine both:**
> *"List CXOs my team has spoken to in the last 3 months who are ICP with their brand name and LinkedIn"*
> → ICP definition = this file: `is_the_company_icp_` = `Yes` on Company
> → "spoken to" = `notes_last_contacted` on Contact, filter last 90 days
> → CXO filter = `jobtitle` contains CEO/CFO/CTO/CMO/COO on Contact
> → LinkedIn = `hs_linkedin_url` on Contact; brand = associated Company `name`
> → This file gives ICP context; figure out the rest from HubSpot directly.

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
| **Churn** | Deal | `dealstage` = `175526434` (Churn) or Company `lifecyclestage` = `1140600340` | `dealstage`, `churn_reason` |

> For questions not listed here, compose queries using `query_crm_data` and `search_properties` directly.

---

## SECTION 1B — TERM ALIASES & COMMON MISTAKES

When a user uses natural language terms, map them as follows. The **Do NOT** rules are critical — these are the wrong properties Claude would otherwise guess.

| User Says | Correct Property | Object | Do NOT Use |
|---|---|---|---|
| "revenue" / "annual revenue" / "estimated yearly sales" / "yearly sales" | `estimated_yearly_sales__2025_` | Company | `amount`, `revenue`, `annual_revenue` |
| "source" / "source 1" / "standard source 1" / "original source" | `standard_source_1` | Company | `source_1`, `hs_analytics_source` |
| "deal source" / "how the deal came in" | `deal_source` | Deal | `standard_source_1`, `source_1` |
| "MQL" / "marketing qualified lead" | `mql_date` IS NOT NULL (`HAS_PROPERTY`) | Company | **Do NOT** filter by `lifecyclestage = 'marketingqualifiedlead'` — that stage triggers `mql_date` but is not the source of truth |
| "ICP" / "ICP company" | `is_the_company_icp_` = `Yes` | Company | **Do NOT** use `icp`, `hs_ideal_customer_profile`, or any other field — only `is_the_company_icp_` is authoritative |
| "ICP contact" | `is_the_company_icp` = `Yes` | Contact | Note: one fewer trailing underscore than the Company version |
| "ICP deal" | `is_the_company_icp__` = `Yes` | Deal | Note: two trailing underscores |
| "marketing source" / "marketing sourced" | `standard_source_1` = `Marketing` on Company; then `standard_source_2` for sub-channel breakdown | Company | `deal_source = 'Inbound'` is the deal-level equivalent, not the same thing |

---

## SECTION 2 — PROPERTY QUICK LOOKUP

Full alphabetical index of all Saras HubSpot properties. **Tags**: `[AUTO]` = system-set, `[ICP_GATE]` = ICP workflow criterion, `[IMMEDIATE]` = immediate priority trigger, `[ICP_FLAG]` = ICP boolean, `[MQL]` = MQL-related, `[SCORING]` = lead scoring signal, `[PIPELINE]` = pipeline metric.

| Internal Name | Label | Object | Type | Tags |
|---|---|---|---|---|
| `account_growth_type` | Revenue Type | Deal | Enum | |
| `account_ownership` | Account Ownership | Deal | Enum | |
| `account_type` | Account Type | Deal | Enum | |
| `amount` | Amount | Deal | Number | `[PIPELINE]` |
| `call_conducted` | Discovery Call | Company, Contact | Enum | |
| `churn_date` | Churn Date | Deal | Date | |
| `churn_reason` | Churn Reason | Deal | Enum | |
| `churn_type` | Churn Type | Deal | Enum | |
| `city` | City | Company, Contact | String | |
| `closedate` | Close Date | Deal | Datetime | |
| `closed_lost_reason` | Closed Lost Reason | Deal | Enum | |
| `closed_lost_reason_descriptive` | Closed Lost Reason (Descriptive) | Deal | String | |
| `closed_won_reason` | Closed Won Reason | Deal | String | |
| `company` | Company | Contact | String | |
| `company_address` | Company Address | Contact | String | |
| `company_city` | Company City | Contact | String | |
| `company_country` | Company Country | Contact | String | |
| `company_linkedin_url` | Company LinkedIn URL | Contact | String | |
| `company_phone` | Company Phone | Contact | String | |
| `company_state` | Company State | Contact | String | |
| `contract_duration` | Contract Duration | Deal | String | |
| `corporate_phone` | Corporate Phone | Contact | String | |
| `country` | Country/Region | Company, Contact | String | `[ICP_GATE]` (Company) |
| `createdate` | Create Date | Deal | Datetime | `[AUTO]` |
| `customer_employee_moved_here` | Customer employee moved here | Company | Enum | `[IMMEDIATE]` |
| `daton_subscription` | Saras Offering | Deal | Enum | |
| `deal_source` | Deal Source | Deal | Enum | `[PIPELINE]` |
| `deal_source___2` | Deal Source 2 | Deal | Enum | |
| `dealname` | Deal Name | Deal | String | |
| `dealstage` | Deal Stage | Deal | Enum | `[AUTO]` |
| `demo_call_completed` | Demo Call Completed | Deal | Enum | |
| `department` | Department | Contact | String | |
| `discovery_call_completed` | Discovery Call Completed | Deal | Enum | |
| `domain_url` | Domain URL | Company | String | |
| `dq_observation_notes` | DQ Observation Notes | Deal | String | |
| `email` | Email | Contact | String | |
| `email_status` | Email Status | Contact | String | |
| `employee_count` | Employee Count | Company | Number | |
| `employee_moved_from_here_to_customer` | Employee moved from here to customer | Company | Enum | `[IMMEDIATE]` |
| `engagements_last_meeting_booked` | Date of Last Meeting Booked | Deal, Company | Datetime | `[AUTO]` |
| `estimated_yearly_sales__2025_` | estimated_yearly_sales (2025) | Company | Number | `[ICP_GATE]` |
| `first_meeting` | First Meeting Date | Deal | Date | |
| `firstname` | First Name | Contact | String | |
| `has_a_ceo_who_joined_in_the_last_3_12_months` | Has a CEO (joined 3–12 mo) | Company | Enum | `[IMMEDIATE]` |
| `has_a_cfo_who_joined_in_the_last_3_12_months` | Has a CFO (joined 3–12 mo) | Company | Enum | `[IMMEDIATE]` |
| `has_a_cmo_who_joined_in_the_last_3_12_months` | Has a CMO (joined 3–12 mo) | Company | Enum | `[SCORING]` |
| `has_a_head_of_data_who_joined_in_the_last_3_12_months` | Has a Head of Data (joined 3–12 mo) | Company | Enum | `[SCORING]` |
| `has_migrated_to_shopify_platform_in_the_last_3_6_months` | Migrated to Shopify (3–6 mo) | Company | Enum | `[SCORING]` |
| `has_our_competitors__northbeam__triplewhale__polar_analytics` | Has competitor tech | Company | Enum | `[SCORING]` |
| `has_our_partner_tech__klaviyo__recharge__blotout__skio__stayai__loop` | Has partner tech | Company | Enum | `[SCORING]` |
| `has_tech_stack_fit__tiktok_shop__applovin__fulfil__fairing__gorgias__postscript__netsuite` | Has tech-stack fit | Company | Enum | `[SCORING]` |
| `hs_analytics_source` | Original Traffic Source | Contact | Enum | `[AUTO]` |
| `hs_analytics_source_data_1` | Original Traffic Source Drill-Down 1 | Contact | String | `[AUTO]` |
| `hs_analytics_source_data_2` | Original Traffic Source Drill-Down 2 | Contact | String | `[AUTO]` |
| `hs_deal_score` | Deal Score | Deal | Number | `[AUTO]` |
| `hs_deal_stage_probability` | Deal Probability | Deal | Number | `[AUTO]` |
| `hs_forecast_amount` | Forecast Amount | Deal | Number | `[AUTO]` |
| `hs_is_target_account` | Target Account | Company | Bool | |
| `hs_latest_sequence_enrolled` | Last Sequence Enrolled | Contact | Enum | `[AUTO]` |
| `hs_lead_status` | Lead Status | Contact | Enum | |
| `hs_linkedin_url` | LinkedIn URL | Contact | String | |
| `hs_manual_forecast_category` | Forecast Category | Deal | Enum | |
| `hs_projected_amount` | Weighted Amount | Deal | Number | `[AUTO]` |
| `hs_reason_to_reach_out` | Reason To Reach Out | Company | String | |
| `hs_sequences_enrolled_count` | Number of Sequences Enrolled | Contact | Number | `[AUTO]` |
| `hs_sequences_is_enrolled` | Currently in Sequence | Contact | Bool | `[AUTO]` |
| `hs_tcv` | Total Contract Value | Deal | Number | `[AUTO]` |
| `hs_why_this_contact` | Why This Contact | Contact | String | |
| `hubspot_owner_id` | Company Owner / Deal Owner | Company, Deal | Enum | |
| `icp_fit_score` | ICP Fit Score | Company | Number | `[AUTO]` |
| `industry` | Industry | Company, Contact | Enum | |
| `is_the_company_icp_` | Is the company ICP? | **Company** | Enum | `[ICP_FLAG]` `[AUTO]` |
| `is_the_company_icp` | Is the company ICP? | Contact | Enum | `[ICP_FLAG]` |
| `is_the_company_icp__` | Is the company ICP? | Deal | Enum | `[ICP_FLAG]` |
| `jobtitle` | Job Title | Contact | String | |
| `lastname` | Last Name | Contact | String | |
| `lead_priority` | Lead Priority | Company, Contact | Enum | `[AUTO]` |
| `lifecyclestage` | Lifecycle Stage | Company, Contact | Enum | `[AUTO]` |
| `linkedin_url` | LinkedIn URL | Company | String | |
| `linkedinjobdaterange` | linkedinJobDateRange | Contact | String | |
| `linkedinpreviousjobdaterange` | linkedinPreviousJobDateRange | Contact | String | |
| `linkedinpreviousjobdescription` | linkedinPreviousJobDescription | Contact | String | |
| `linkedinpreviousjoblocation` | linkedinPreviousJobLocation | Contact | String | |
| `linkedinpreviousjobtitle` | linkedinPreviousJobTitle | Contact | String | |
| `linkedinpreviousschooldegree` | linkedinPreviousSchoolDegree | Contact | String | |
| `linkedinpreviousschoolname` | linkedinPreviousSchoolName | Contact | String | |
| `linkedinschooldaterange` | linkedinSchoolDateRange | Contact | String | |
| `linkedinschooldegree` | linkedinSchoolDegree | Contact | String | |
| `linkedinschoolname` | linkedinSchoolName | Contact | String | |
| `linkedinschoolurl` | linkedinSchoolUrl | Contact | String | |
| `middlemen_identified_for_introductions` | Middlemen identified for introductions | Company | Enum | `[IMMEDIATE]` |
| `mql_date` | MQL Date | **Company** | Date | `[MQL]` `[AUTO]` |
| `mqo_observation` | MQO - Reason (detail) | Deal | String | |
| `mqo_reason` | MQO Observation | Deal | Enum | |
| `n1st_meeting` | 1st Meeting Status | Deal | Enum | |
| `name` | Company Name | Company | String | |
| `notes_last_contacted` | Last Contacted | Company, Deal, Contact | Datetime | `[AUTO]` |
| `notes_last_updated` | Last Activity Date | Company, Deal, Contact | Datetime | `[AUTO]` |
| `nurture_reason` | Nurture Reason | Deal | String | |
| `pb_no_longer_at_company` | No Longer at Company | Contact | Bool | |
| `pipeline` | Pipeline | Deal | Enum | |
| `previouscompanyname` | previousCompanyName | Contact | String | |
| `product_amount` | Product Amount | Deal | Number | |
| `product_name` | Product Name | Company, Deal | Enum | |
| `reason_for_immediate` | Reason for Immediate | Company, Contact | Enum | `[IMMEDIATE]` |
| `renewal_date` | Renewal Date | Deal | Date | |
| `sales_channels` | sales_channels | Company | Enum (multi) | `[ICP_GATE]` |
| `sales_nurture__reason` | Sales Nurture - Reason (detail) | Deal | String | |
| `sales_nurture_reason` | Sales Nurture Reason | Deal | Enum | |
| `saras_competitors` | Saras Competitors | Company | String | |
| `saras_icp` | ICP Fit Score | Contact | Number | `[ICP_FLAG]` |
| `seniority` | Seniority | Contact | String | |
| `sl_last_platform` | Last Platform | Company | String | |
| `sl_plan` | Ecommerce Plan | Company | String | |
| `sl_platform` | Ecommerce Platform | Company | String | |
| `sl_status` | Store Status | Company | Enum | |
| `source_1` | Source 1 | Contact | Enum | |
| `source_2` | Source 2 | Contact | Enum | |
| `source_3` | Source 3 | Contact | Enum | |
| `standard_source_1` | Standard Source 1 | Company | Enum | `[AUTO]` |
| `standard_source_2` | Standard Source 2 | Company | Enum | |
| `standard_source_3` | Standard Source 3 | Company | String | |
| `state` | State/Region | Company, Contact | String | |
| `storeleads_platform_rank` | storeleads_platform_rank | Company | Number | |
| `technologies` | technologies | Company | String | |
| `title` | Title | Company | String | |
| `unsubscribed` | Unsubscribed | Contact | Bool | |
| `website` | Website | Contact | String | |

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
SUCCESS PATH:
  Objective Win → Functional Win (SQL) → Value Win → Commercial Win → Legal Win → Closed Won

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

## SECTION 10 — COMMON HUBSPOT QUERIES

Example queries using Saras metric definitions. Adapt as needed. Use `query_crm_data` tool.

```sql
-- Count MQLs this month
SELECT COUNT(*) FROM COMPANY
WHERE mql_date >= '2026-06-01' AND mql_date <= '2026-06-30'

-- Count ICP MQLs this year
SELECT COUNT(*) FROM COMPANY
WHERE mql_date >= '2026-01-01' AND is_the_company_icp_ = 'Yes'

-- Marketing-sourced pipeline (open deals only)
SELECT SUM(amount) FROM DEAL
WHERE deal_source = 'Inbound' AND pipeline = 'default'
  AND dealstage NOT IN ('closedlost', '152224771', '217786505', '28023967', '175509306')

-- Active deals by stage in Sales Pipeline
SELECT dealstage, COUNT(*), SUM(amount) FROM DEAL
WHERE pipeline = 'default'
GROUP BY dealstage

-- Immediate priority companies with contact owner
SELECT name, lead_priority, reason_for_immediate, hubspot_owner_id FROM COMPANY
WHERE lead_priority = 'Immediate'

-- Companies that are ICP but not yet MQL
SELECT name, icp_fit_score, lead_priority FROM COMPANY
WHERE is_the_company_icp_ = 'Yes' AND mql_date IS NULL

-- SQLs created this quarter
SELECT dealname, amount, createdate, hubspot_owner_id FROM DEAL
WHERE pipeline = 'default' AND dealstage = 'qualifiedtobuy'
  AND createdate >= '2026-04-01'
```

> For questions not listed here, compose queries directly using `query_crm_data`. Use `search_properties` to discover the right property names when unsure.

---

## SECTION 11 — FULL PROPERTY REFERENCE

### Company Properties

| Property Label | Internal Name | Type | Valid Values / Notes |
|---|---|---|---|
| Company Name | `name` | String | |
| Industry | `industry` | Enum | HubSpot standard industry list |
| Domain URL | `domain_url` | String | Enriched |
| Title | `title` | String | Company descriptor |
| Employee Count | `employee_count` | Number | Enriched |
| estimated_yearly_sales (2025) | `estimated_yearly_sales__2025_` | Number (USD) | Annual GMV — ICP gate: $15M–$500M |
| Product Name | `product_name` | Enum | `Pulse` / `Daton` / `iQ` / `Daton Embed` |
| Lifecycle Stage | `lifecyclestage` | Enum | See Section 6 |
| storeleads_platform_rank | `storeleads_platform_rank` | Number | Store Leads revenue rank proxy |
| City | `city` | String | |
| State/Region | `state` | String | |
| Country/Region | `country` | String | ICP gate — see Section 4 for accepted values |
| sales_channels | `sales_channels` | Enum (multi) | ICP gate — must include `Shopify`; also: Amazon, TikTok Shop, Walmart Marketplace, eBay, Etsy, BigCommerce, WooCommerce, Others, etc. |
| technologies | `technologies` | String | Tech stack |
| LinkedIn URL | `linkedin_url` | String | |
| Saras Competitors | `saras_competitors` | String | Competitor tools in use |
| Company Owner | `hubspot_owner_id` | Enum | |
| MQL Date | `mql_date` | Date | `[AUTO]` — set by workflow; if populated = company is MQL |
| ICP Fit Score | `icp_fit_score` | Number | `[AUTO]` — 0 = DQ; higher = better fit |
| Is the company ICP? | `is_the_company_icp_` | Enum | `Yes` / `No` — set by automated ICP workflow |
| Lead Priority | `lead_priority` | Enum | `Immediate` / `High` / `Medium` / `Low` / `Disqualified` |
| Reason for Immediate | `reason_for_immediate` | Enum | `Exec Change` / `Warm Path` / `Referral` |
| Discovery Call | `call_conducted` | Enum | `Yes` / `No` |
| Standard Source 1 | `standard_source_1` | Enum | `Referral` / `Events` / `Marketing` |
| Standard Source 2 | `standard_source_2` | Enum | `Customer` / `Partner` / `Internal` / `Email` / `SEO` / `Webinar` / `Social Media` / `PPC` / `Sponsorship` / `Direct Traffic` / `Others` |
| Standard Source 3 | `standard_source_3` | String | Free text detail |
| Ecommerce Platform | `sl_platform` | String | Store Leads: e.g., `shopify`, `magento` |
| Last Platform | `sl_last_platform` | String | Store Leads: platform before migration |
| Ecommerce Plan | `sl_plan` | String | Store Leads: e.g., `Shopify Plus` |
| Store Status | `sl_status` | Enum | `Active` / `Inactive` / `Password Protected` / `Redirects` / `Duplicate` / `Demo` |
| Target Account | `hs_is_target_account` | Bool | `true` / `false` — ABM flag |
| Reason To Reach Out | `hs_reason_to_reach_out` | String | AI or manual note on timing |
| Has a CFO (joined 3–12 mo) | `has_a_cfo_who_joined_in_the_last_3_12_months` | Enum | `Yes` / `No` — `[IMMEDIATE]`; auto-clears after 3 months |
| Has a CEO (joined 3–12 mo) | `has_a_ceo_who_joined_in_the_last_3_12_months` | Enum | `Yes` / `No` — `[IMMEDIATE]`; auto-clears after 3 months |
| Has a Head of Data (joined 3–12 mo) | `has_a_head_of_data_who_joined_in_the_last_3_12_months` | Enum | `Yes` / `No` — +6 scoring |
| Has a CMO (joined 3–12 mo) | `has_a_cmo_who_joined_in_the_last_3_12_months` | Enum | `Yes` / `No` — +5 scoring |
| Migrated to Shopify (3–6 mo) | `has_migrated_to_shopify_platform_in_the_last_3_6_months` | Enum | `Yes` / `No` — +6 scoring; auto-clears |
| Has partner tech | `has_our_partner_tech__klaviyo__recharge__blotout__skio__stayai__loop` | Enum | `Yes` / `No` — +5 scoring |
| Has competitor tech | `has_our_competitors__northbeam__triplewhale__polar_analytics` | Enum | `Yes` / `No` — +5 scoring |
| Has tech-stack fit | `has_tech_stack_fit__tiktok_shop__applovin__fulfil__fairing__gorgias__postscript__netsuite` | Enum | `Yes` / `No` — +3 scoring |
| Customer employee moved here | `customer_employee_moved_here` | Enum | `Yes` / `No` — `[IMMEDIATE]` warm path trigger |
| Employee moved from here to customer | `employee_moved_from_here_to_customer` | Enum | `Yes` / `No` — `[IMMEDIATE]` warm path trigger |
| Middlemen identified | `middlemen_identified_for_introductions` | Enum | `Yes` / `No` — warm path signal |

### Contact Properties

| Property Label | Internal Name | Type | Valid Values / Notes |
|---|---|---|---|
| First Name | `firstname` | String | |
| Last Name | `lastname` | String | |
| Email | `email` | String | |
| Job Title | `jobtitle` | String | |
| Company | `company` | String | |
| LinkedIn URL | `hs_linkedin_url` | String | |
| Industry | `industry` | Enum | |
| Seniority | `seniority` | String | |
| Department | `department` | String | |
| Corporate Phone | `corporate_phone` | String | |
| City | `city` | String | |
| State/Region | `state` | String | |
| Country/Region | `country` | String | |
| Website | `website` | String | |
| Company LinkedIn URL | `company_linkedin_url` | String | |
| Company Address | `company_address` | String | |
| Company City | `company_city` | String | |
| Company State | `company_state` | String | |
| Company Country | `company_country` | String | |
| Company Phone | `company_phone` | String | |
| Lifecycle Stage | `lifecyclestage` | Enum | See Section 6 |
| Lead Status | `hs_lead_status` | Enum | See Section 7 |
| Is the company ICP? | `is_the_company_icp` | Enum | `Yes` / `No` — set by marketing |
| ICP Fit Score | `saras_icp` | Number | Mirror of company `icp_fit_score` |
| Lead Priority | `lead_priority` | Enum | `Immediate` / `High` / `Medium` / `Low` / `Disqualified` |
| Reason for Immediate | `reason_for_immediate` | Enum | `Exec Change` / `Warm Path` / `Referral` |
| Source 1 | `source_1` | Enum | `Inbound` / `Outbound` |
| Source 2 | `source_2` | Enum | `referral` / `SEO` / `Webinar` / `Email` / `Social Media` / `PPC` / `Sponsorship` / `Mark` / `Brian` |
| Source 3 | `source_3` | Enum | `Customer` / `Partner` / `website, LLM` / `Saras, LT` / `LinkedIn, Google` / `Operators Pod` |
| Discovery Call | `call_conducted` | Enum | `Yes` / `No` |
| Original Traffic Source | `hs_analytics_source` | Enum | `[AUTO]` — first known web source |
| Original Traffic Source Drill-Down 1 | `hs_analytics_source_data_1` | String | `[AUTO]` |
| Original Traffic Source Drill-Down 2 | `hs_analytics_source_data_2` | String | `[AUTO]` |
| Currently in Sequence | `hs_sequences_is_enrolled` | Bool | `true` / `false` |
| Number of Sequences Enrolled | `hs_sequences_enrolled_count` | Number | |
| Last Sequence Enrolled | `hs_latest_sequence_enrolled` | Enum | Sequence name/ID |
| Why This Contact | `hs_why_this_contact` | String | Free text — outreach rationale |
| No Longer at Company | `pb_no_longer_at_company` | Bool | `true` / `false` — PhantomBuster enrichment |
| Email Status | `email_status` | String | Deliverability / validation status |
| Unsubscribed | `unsubscribed` | Bool | `true` / `false` |

### Deal Properties

| Property Label | Internal Name | Type | Valid Values / Notes |
|---|---|---|---|
| Deal Name | `dealname` | String | |
| Create Date | `createdate` | Datetime | `[AUTO]` |
| Close Date | `closedate` | Datetime | Expected or actual close |
| Last Activity Date | `notes_last_updated` | Datetime | `[AUTO]` |
| Last Contacted | `notes_last_contacted` | Datetime | `[AUTO]` |
| Deal Owner | `hubspot_owner_id` | Enum | Assigned AE / rep |
| Pipeline | `pipeline` | Enum | `default` (Sales) / `2296560372` (Daton) / `10303360` (Renewals) / `638550298` (Renewal & Expansion) |
| Deal Stage | `dealstage` | Enum | See Section 5 for internal values |
| Amount | `amount` | Number | Contract value / ARR |
| Product Amount | `product_amount` | Number | Product-specific amount |
| Total Contract Value | `hs_tcv` | Number | `[AUTO]` |
| Weighted Amount | `hs_projected_amount` | Number | `[AUTO]` Amount × stage probability |
| Forecast Amount | `hs_forecast_amount` | Number | `[AUTO]` Amount × forecast probability |
| Forecast Category | `hs_manual_forecast_category` | Enum | `Not forecasted` / `Future Pipe` / `Upside` / `Commit` / `Closed won` |
| Deal Score | `hs_deal_score` | Number | `[AUTO]` — HubSpot AI deal health |
| Deal Probability | `hs_deal_stage_probability` | Number | `[AUTO]` — win probability % |
| Deal Source | `deal_source` | Enum | `Inbound` / `Events` / `Outbound` / `Referral` / `Sales Led` / `Founders Led` / `Affiliates` |
| Deal Source 2 | `deal_source___2` | Enum | Sub-source picklist (100+ values — query live) |
| Account Type | `account_type` | Enum | `AA : Amazon Agency` / `FBAA: FBA Aggregator` / `Brand` / `Partnership` |
| Saras Offering | `daton_subscription` | Enum | Daton Enterprise / Daton Business / Saras Pulse / Saras IQ / Pulse Essentials / Daton Growth / ChargeBee – Business / ChargeBee – Growth / ChargeBee – Starter / ChargeBee – Lite / Consulting / DE / Pulse Implementation / Product Referral |
| Product Name | `product_name` | Enum | `Pulse` / `Others` / `NA` |
| Is the company ICP? | `is_the_company_icp__` | Enum | `Yes` / `No` — set by sales rep on call |
| Discovery Call Completed | `discovery_call_completed` | Enum | `Yes` / `No` |
| Demo Call Completed | `demo_call_completed` | Enum | `Yes` |
| First Meeting Date | `first_meeting` | Date | |
| 1st Meeting Status | `n1st_meeting` | Enum | `Yes` / `No` / `Rescheduled` |
| Date of Last Meeting Booked | `engagements_last_meeting_booked` | Datetime | `[AUTO]` — via HubSpot meetings tool |
| Closed Lost Reason | `closed_lost_reason` | Enum | `Competitor` / `No Decision` / `Ghost` / `Feature Mismatch` / `Budget` / `Internal Build` / `Existing vendor` / `Others` |
| Closed Lost Reason (Descriptive) | `closed_lost_reason_descriptive` | String | AE free-text elaboration |
| Closed Won Reason | `closed_won_reason` | String | Free text |
| MQO Observation | `mqo_reason` | Enum | `No response/Cold` / `Marketing Nurture` / `Not qualified` / `BANT Issues - Nurture` |
| MQO - Reason (detail) | `mqo_observation` | String | Free text elaboration |
| DQ Observation Notes | `dq_observation_notes` | String | Free text — why deal was DQ'd |
| Sales Nurture Reason | `sales_nurture_reason` | Enum | `Ghosting post meeting` / `BANT Issues - Multithread` / `BANT Issues - Nurture` |
| Sales Nurture - Reason (detail) | `sales_nurture__reason` | String | Free text elaboration |
| Nurture Reason | `nurture_reason` | String | General nurture context |
| Churn Reason | `churn_reason` | Enum | `Product fit` / `Pricing` / `Competitor` / `Inhouse build` / `Support issue` / `less usage` |
| Churn Type | `churn_type` | Enum | `Churned` / `Contraction` / `Paused` |
| Churn Date | `churn_date` | Date | |
| Revenue Type | `account_growth_type` | Enum | `Grow B/Expansion` (Net new revenue) / `Renewal` (Net new growth) / `Net new growth - Year 1` / `Net retained revenue` |
| Account Ownership | `account_ownership` | Enum | `Consulting` / `Consulting + DE` / `DE` / `Customer Success` / `DE + CS` |
| Renewal Date | `renewal_date` | Date | |
| Contract Duration | `contract_duration` | String | e.g., `12 months` |
