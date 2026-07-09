---
title: Saras HubSpot Context Layer
purpose: Semantic context layer for the Saras HubSpot CRM Agent
version: 2.0
objects: [Company, Contact, Deal]
key_metrics: [MQL, ICP_MQL, SQL, MQO, ICP, Pipeline, ARR]
last_verified: 2026-06-20
---

# Saras HubSpot Context Layer

> **AGENT INSTRUCTIONS — READ FIRST**
>
> This file is a **semantic context layer**, not a capability boundary.
>
> **USE THIS FILE** to interpret Saras-specific business terms (MQL, ICP, SQL, etc.) and to know the correct internal property names and enum values for custom Saras properties.
>
> **FOR ALL OTHER QUESTIONS**: use whichever of your available HubSpot tools fits the question. This file does not gate or limit which tools or properties you can use — it only adds business-term definitions for Saras-specific concepts that aren't otherwise obvious from the CRM data itself.
>
> **Example of how to combine both:**
> *"List CXOs my team has spoken to in the last 3 months who are ICP with their brand name and LinkedIn"*
> → ICP definition = this file: `is_the_company_icp` = `true` on Contact (or `is_the_company_icp_` on Company)
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
| **ICP MQL** | Company | `mql_date` IS NOT NULL AND `is_the_company_icp_` = `true` | `mql_date`, `is_the_company_icp_` |
| **SQL** | Deal | `dealstage` IN (`qualifiedtobuy`, `presentationscheduled`, `28218292`, `contractsent`, `closedwon`, `closedlost`, `217786505`, `175526434`) in Sales Pipeline — any stage reached AFTER Objective Win, including Closed Lost/Sales Nurture/Churn; excludes Objective Win itself, MQO, and DQ | `dealstage`, `pipeline` = `default` |
| **ICP (company)** | Company | `is_the_company_icp_` = `true` | `is_the_company_icp_` |
| **ICP (contact)** | Contact | `is_the_company_icp` = `true` | `is_the_company_icp` |
| **ICP (deal)** | Deal | `is_the_company_icp__` = `true` | `is_the_company_icp__` |
| **Marketing Pipeline** | Deal | `deal_source` = `Inbound`, `pipeline` = `default`, stage ≠ closed lost | `deal_source`, `amount` |
| **ARR / Deal Value** | Deal | `amount` on deal | `amount` |

> For questions not listed here, compose queries using `search_objects`, `count_objects`, or `get_object_properties` directly.

---

## SECTION 1B — TERM ALIASES & COMMON MISTAKES

When a user uses natural language terms, map them as follows. The **Do NOT** rules are critical — these are the wrong properties Claude would otherwise guess. These aliases are for natural-language phrasing — if the user's wording looks like it's quoting an exact property label (specific casing, units like "(USD)", quotation marks), verify that literal property exists via `get_object_properties` first (once per object type for this question — reuse the result, don't re-check it); a real matching HubSpot property wins over the heuristic mapping below.

| User Says | Correct Property | Object | Do NOT Use |
|---|---|---|---|
| "revenue" / "annual revenue" / "estimated yearly sales" / "yearly sales" | `estimated_yearly_sales__2025_` | Company | `amount`, `revenue`, `annual_revenue` |
| "source" / "company source" / "standard source 1" (asking about a Company) | `standard_source_1` (then `standard_source_2` for sub-channel breakdown) | Company | Do NOT use for a Contact-level source question |
| "source" / "original source" / "contact source" (asking about a Contact) | `hs_analytics_source` (native first-touch web attribution) or `source_1` (Saras custom Inbound/Outbound categorization) — pick based on what's actually being asked | Contact | Do NOT use `standard_source_1` — that's Company-only |
| "deal source" / "how the deal came in" | `deal_source` | Deal | `standard_source_1`, `source_1` |
| "MQL" / "marketing qualified lead" / "MQLs" | `mql_date` IS NOT NULL (`HAS_PROPERTY`) | **Company only** — always query the Company object, never Contact | **Do NOT** filter by `lifecyclestage = 'marketingqualifiedlead'` — that stage triggers `mql_date` but is not the source of truth |
| "ICP" / "ICP company" | `is_the_company_icp_` = `true` | Company | **Do NOT** use `icp`, `hs_ideal_customer_profile`, or any other field — only `is_the_company_icp_` is authoritative. **Do NOT** filter with the string `"Yes"` — HubSpot displays this checkbox as "Yes"/"No" but the real filterable value is `true`/`false`. |
| "ICP contact" | `is_the_company_icp` = `true` | Contact | Note: one fewer trailing underscore than the Company version |
| "ICP deal" | `is_the_company_icp__` = `true` | Deal | Note: two trailing underscores |
| "marketing source" / "marketing sourced" | `standard_source_1` = `Marketing` on Company; then `standard_source_2` for sub-channel breakdown | Company | `deal_source = 'Inbound'` is the deal-level equivalent, not the same thing |
| "CXO" / "C-level" / "C-suite" / "executives" | `jobtitle` CONTAINS_TOKEN each of: `CEO`, `CFO`, `CTO`, `CMO`, `COO`, `Chief` | Contact | Search per title separately, combine and deduplicate by contact ID |
| "spoken to" / "contacted" / "reached out to" | `notes_last_contacted` with date range filter | Contact, Company | Use GTE for start date |
| "brand" / "brand name" / "company name" (in contact context) | Get associated Company `name` via `get_contacts_with_company_properties` | Contact→Company | Do NOT use the Contact `company` field — it's a free-text string, not a live association |
| "owner" / "who owns this deal/company" / "[rep name]'s deals" | `hubspot_owner_id` (confirm via `get_object_properties`) | Contact, Company, Deal | Resolve rep name → ID via `list_owners` first, then filter |
| "meetings booked" / "meeting booked date" | `hs_last_booked_meeting_date` (Company) / `engagements_last_meeting_booked` (Contact) | Contact, Company | Do NOT default to the raw Meetings engagement object's `hs_timestamp` — it includes non-sales meetings and can wildly overcount |

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
- **Rule**: `mql_date` IS NOT NULL **AND** `is_the_company_icp_` = `true`
- **Not a property** — applied as a combined filter
- **Count query**: `SELECT COUNT(*) FROM COMPANY WHERE mql_date IS NOT NULL AND is_the_company_icp_ = 'true'`

---

### SQL — Sales Qualified Lead

- **Object**: Deal
- **Rule**: `dealstage` IN (`qualifiedtobuy`, `presentationscheduled`, `28218292`, `contractsent`, `closedwon`, `closedlost`, `217786505`, `175526434`) in `pipeline` = `default`
- **Excludes**: Objective Win itself (`appointmentscheduled` — still at discovery call), MQO (`152224771` — no-show, never qualified), DQ (`175509306` — disqualified on the discovery call itself, never reached Functional Win)
- **Meaning**: The deal reached Functional Win at some point — qualified fit confirmed, real buying intent established — even if it later moved to Closed Lost, Sales Nurture, or Churn. Do NOT treat SQL as "currently in Functional Win only" — a deal currently in Value Win, Commercial Win, Legal Win, Closed Won, Closed Lost, Sales Nurture, or Churn still counts as SQL.

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

Values: `true` / `false` (HubSpot's UI displays these as "Yes"/"No", but the API/filter value is the boolean-style string, on all three ICP properties — Company, Contact, and Deal alike)

**ICP Workflow Decision Tree** — Company must pass ALL three:

```
ICP CHECK (company must pass ALL THREE):
  1. country IN:
       US: "United States" | "US" | "USA" | "U.S." | "America"
       UK: "United Kingdom" | "UK" | "Great Britain" | "Britain" | "England"
       Canada: "Canada" | "CA" | "CAN"
  2. sales_channels INCLUDES "Shopify"
  3. estimated_yearly_sales__2025_ BETWEEN 15,000,000 AND 500,000,000

PASS ALL → is_the_company_icp_ = true
FAIL ANY → is_the_company_icp_ = false
```

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
  Obj/Func/Value Win → Sales Nurture   (not ready; long-term nurture)
  Any active stage → Closed Lost
```

Note: junk leads never get a deal created, so there is no dealstage transition to "Junk" — it's a lifecycle/lead-status outcome only, not part of deal-stage logic.

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

## SECTION 8 — SOURCE ATTRIBUTION

> **Agent disambiguation**: When a user says "source" without specifying an object, use `standard_source_1` for Company, `deal_source` for Deal, and `hs_analytics_source` (native) or `source_1` (Saras custom Inbound/Outbound) for Contact — never `standard_source_1` for a Contact, it's Company-only. "Marketing sources" means `standard_source_1 = 'Marketing'` on Company — the specific channel breakdown is in `standard_source_2` (Email, SEO, Webinar, PPC, etc.).

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
| Product Name | `product_name` | Company | Pulse / Daton / iQ / Daton Embed |

Check `product_name` on the Company first for "what product/offering" questions. Only if it's unavailable, fall back to Saras Offering (`daton_subscription`) on the Deal.

**Revenue / ARR**: `amount` on Deal = contract value / ARR per deal. Billing source of truth is Chargebee (not directly synced to HubSpot).

---

> For any property not listed in this file, use `get_object_properties` to discover the exact name and type.
