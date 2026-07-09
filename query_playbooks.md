Step-by-step recipes for common multi-step query types. Follow them exactly — they encode fixes for past counting mistakes.

## Stage Progression ("moved past X")

"Moved past [stage]" / "after [stage]":
The Sales Pipeline stage order is: Objective Win → Functional Win → Value Win → Commercial Win → Legal Win → Closed Won.
"Moved past Objective Win" means the deal's current dealstage is any stage AFTER Objective Win: qualifiedtobuy, presentationscheduled, 28218292, contractsent, closedwon.
Use the IN operator with all stages past the named one. Do NOT include closedlost, MQO, DQ, Sales Nurture, or Dead/Duplicate — those are exit paths, not progression.

## Cross-Object Mismatch Queries

Questions comparing a property on one object against a property on its associated object (e.g. "deals marked ICP but the company is marked non-ICP", "contacts flagged as X but their company says Y"):
1. Identify which side's OWN filters are more selective — usually whichever side has more distinct conditions stacked together (e.g. "non-ICP AND MQL'd in 2026 AND sourced from marketing" on the company side is far more selective than "ICP = true" alone on the deal side).
2. Use the batch tool anchored on that more-selective side: `get_companies_with_deal_properties` (company-side filters, returns each company's associated deals) or `get_deals_with_company_properties` (deal-side filters, returns each deal's associated company) — whichever pushes the most conditions down as real HubSpot filters.
3. Fetch that one batch, then do the actual mismatch check (comparing the two objects' property values) yourself across the returned records — this is reasoning, not another tool call.
4. NEVER call `get_deal` or `get_company` more than 2-3 times in a row to check individual records against a condition — if you find yourself doing this, stop and restructure the query as a batch call on the more selective side instead. Repeated single-record lookups don't scale and burn far more tokens than a single batch call.

## Cross-Object Contact + Company Queries

Cross-object contact + company questions:
For questions needing contact details WITH company properties (name, ICP, revenue), use get_contacts_with_company_properties. This handles the batch lookup in one call.
Example: "CXOs at ICP companies" → get_contacts_with_company_properties with jobtitle filter + request company is_the_company_icp_ property, then filter results where company.is_the_company_icp_ = true.

## Multi-Hop Association Chain Queries

"Contacts at companies that have open deals in stage X", "contacts at companies with an ICP-flagged deal", or any question chaining Contact → Company → Deal (or the reverse):
1. Anchor the FIRST hop on whichever batch tool lets the real condition run as a HubSpot filter:
   - If the condition is on the deal (e.g. "deals in stage X"), use get_deals_with_company_properties with deal_filters on dealstage, then take each result's company field.
   - If the condition is on the company (e.g. "ICP companies"), use get_companies_with_deal_properties with company_filters, then read each result's deals array directly — no second hop needed if that's all the question asks.
2. Collect the distinct company IDs that pass the condition from step 1.
3. For the CONTACT hop: there is no batch tool that accepts a company-ID list as input. Call get_associations with object_type: "companies", to_object_type: "contacts" once per qualifying company ID from step 2, then fetch contact details via get_contacts_with_company_properties (filtered by any contact-level condition) or get_contact for the final small set.
4. Efficient only when step 1's qualifying-company set is small (roughly under 20-30) — if larger, report the company-level count and ask before looping get_associations across dozens of companies. Never use get_associations as a substitute for step 1's batch filter itself (e.g. calling it per-deal or per-contact) — it's only for the final company→contact hop, after the set is already narrowed.

Note: there is no single-call three-hop batch tool (contacts + their company + that company's deals) — this recipe is the most efficient path with current tools.

## Company + Contact Batch Queries

For questions needing company details WITH their contacts (e.g. "ICP companies and their key contacts", "who have we talked to at non-ICP companies"), use get_companies_with_contact_properties. It returns up to max_contacts_per_company (default 10) contacts per company — raise this only if the user needs a near-exhaustive contact list per company. The returned contacts are an unordered sample, not ranked by importance — check contacts_truncated per company before claiming a complete list.

## CXO / C-Level Search

CXO / C-level title search:
HubSpot jobtitle is a free-text field. To find C-level contacts, search with CONTAINS_TOKEN for "Chief" — this catches CEO, CFO, CTO, CMO, COO, and other Chief titles in one query. If you need specific titles only, make separate searches per title and deduplicate by contact ID.

## Ratio / Comparison Queries

Ratio / comparison questions:
For "X vs Y ratio" or "X vs Y trend", make count_objects calls for each category per time period. Present results as a numbered list with both counts and the calculated ratio/percentage.

## Time-Window Trend / Cohort Queries

"Trend over the last N months/quarters", "month-over-month growth in X", "MQL volume by month":
1. Break the requested range into individual periods (months, quarters, or weeks) relative to TODAY'S DATE.
2. Make ONE count_objects call per period with GTE (period start) and LTE (period end) on the correct date property for that metric — never BETWEEN, never one wide-range query.
3. Pick the date property for the metric being trended, not just createdate:
   - "MQL volume" / "MQLs by month" → Company, mql_date (GTE/LTE), NOT createdate
   - "new leads" / "leads created" → Company or Contact, createdate
   - "deals created" → Deal, createdate
   - "ICP companies" (a snapshot count, not a dated event) → there is no "became ICP on" date property in this schema; a per-period trend of ICP status is not resolvable from createdate alone — state this limitation rather than approximating with createdate.
4. For "growth" or "change" between periods, run count_objects for each period being compared, then compute the delta/percentage yourself as reasoning — do not call a tool for the growth calculation itself.
5. Present the result as a list of period → count (and growth % if requested), using the "total" field from each count_objects response — never tally a results array.

## Group-By / Aggregate Queries

"Total X by Y", "count of X per Y", "Y breakdown" (e.g. "count of open deals per pipeline stage", "companies by industry"):
1. Enumerate the distinct values of the group-by property: use get_object_properties for a picklist/enum property (dealstage, pipeline, industry, lifecyclestage), or a small search_objects sample for a freeform text property.
2. Cap the number of distinct-value buckets at 15. If there are more, use the 15 with the highest counts and note in **Notes:** that results are limited to the top 15 — never drop values silently.
3. Make ONE count_objects call PER distinct value, combining the group-by filter (EQ) with any other filters from the question.
4. NEVER fetch all matching records in one wide search_objects call and tally the group-by property by reading each record — you will miscount past the 100-result cap, same as the monthly-breakdown rule above.
5. Present as a table or ranked list: value, count, percent of total if useful. Sort descending unless the user specifies an order.
6. SUM-based aggregates (e.g. "total deal amount by industry") are NOT currently supported — HubSpot's search API returns exact counts but not sums, and summing would require paginating every matching record client-side. Say so explicitly if asked rather than attempting a manual sum.

## Revenue Context

"Revenue" in deal vs company context:
- "Deal value" / "deal amount" / "ARR" → amount on Deal
- "Company revenue" / "annual revenue" / "revenue" when filtering companies → estimated_yearly_sales__2025_ on Company
- If a question says "deals with revenue < $X" without specifying deal or company, default to company revenue (estimated_yearly_sales__2025_) via get_deals_with_company_properties unless the user specifically says "deal amount".
- "Deals closed/won in [period]" / "customers acquired in [period]" → filter Deal `closedate` GTE/LTE the period AND `dealstage` = `closedwon` — do NOT use `createdate` (that's when the deal was opened, not when it closed).

## Funnel Milestone Queries

FUNNEL MILESTONE QUERIES ("how many reached X", "how many booked first meeting", "meetings booked", "booked a meeting", "scheduled a call", "how many got to demo"):
Both lifecycle stage AND deal stage reflect CURRENT position only, not history. Do NOT use lifecycle stage alone for funnel milestone counts.

FIRST MEETING HAPPENED — correct definition:
A company/deal had their first meeting if they have a deal in pipeline = default at ANY stage EXCEPT:
  - MQO (152224771) — meeting was SCHEDULED but prospect NO-SHOWED → does NOT count as first meeting
  - Dead/Duplicate (28023967) — stale or invalid, no meeting implied

Note: junk leads never get a deal created, so "Junk" is not a dealstage and doesn't need excluding here.

Full "first meeting happened" dealstage IN list (use this):
  appointmentscheduled, qualifiedtobuy, presentationscheduled, 28218292, contractsent,
  closedwon, closedlost, 217786505, 175509306, 175526434

This correctly includes Sales Nurture (217786505), DQ (175509306), Closed Lost, and Churn — all require a meeting to have entered. A deal that went Objective Win → Sales Nurture or DQ STILL had its first meeting.

MILESTONE REACHED IN A TIME WINDOW ("meetings booked in the last N days", "deals that reached Commercial Win this month"):
The definitions above tell you CURRENT status only, not WHEN a deal entered that stage — dealstage has no built-in transition timestamp, and deal-stage proxies only capture events that already have a deal record.
- "Meetings booked" / "first meeting happened" in [period] → this is an MQL-engagement concept for Saras, not a raw activity count. Check in this order, stopping at the first tier with real data — do NOT combine tiers in one answer, and say in **Notes:** which tier you used:
  1. CURATED PROPERTY (preferred): filter GTE/LTE the period on hs_last_booked_meeting_date (Company) or engagements_last_meeting_booked (Contact) — these are the confirmed properties for this metric, no need to search for them.
  2. RAW MEETINGS OBJECT (fallback): only if no curated property exists, call get_object_properties ONCE with object_type: "meetings", include_internal: true to confirm the timestamp property (commonly hs_timestamp), then filter GTE/LTE the period via search_objects/count_objects with object_type: "meetings". Sanity-check the result against a related trusted metric (MQL or open-deal count) in the same window before reporting it — if drastically higher, say so explicitly rather than presenting it as authoritative.
  3. DEAL-STAGE PROXY (last resort): hs_date_entered_appointmentscheduled on Deal — say explicitly that this only counts meetings that already have an associated deal.
- For other milestones ("reached Commercial Win", "hit Closed Won"), use that specific stage's own hs_date_entered_<stageId> — the Meetings-object preference above is specific to "meetings booked", not other pipeline milestones.
- If neither is available, do NOT silently substitute createdate (that's when the deal record was created, not when it reached the stage) — say so explicitly in **Notes:** and offer the closest honest alternative as an explicit choice.

For deeper funnel milestones:
  - "SQL / Functional Win reached" → dealstage IN: qualifiedtobuy, presentationscheduled, 28218292, contractsent, closedwon, closedlost, 217786505, 175526434
  - "Demo / Value Win reached" → dealstage IN: presentationscheduled, 28218292, contractsent, closedwon, closedlost

For contact-level funnel attribution (e.g. "leads from source X → MQL → first meeting"):
1. Leads: contacts matching the source filter (createdate range + source property)
2. MQL: associated Company has mql_date IS NOT NULL
3. First meeting happened: associated Company has a deal in pipeline = default with dealstage IN (appointmentscheduled, qualifiedtobuy, presentationscheduled, 28218292, contractsent, closedwon, closedlost, 217786505, 175509306, 175526434)

## Ownership / Attribution Queries

"How many open deals does [person] own?", "deals owned by [name]", "[name]'s pipeline":
1. Ownership is tracked via hubspot_owner_id on the relevant object (deals, contacts, or companies) — confirm the exact property name with get_object_properties if unsure.
2. To resolve a name (e.g. "Sarah") to an owner ID, call list_owners and match firstName/lastName or email — there is no name-based filter on HubSpot's owners API, so fetch the list and match yourself. If more than one owner matches ambiguously, ask the user to disambiguate rather than guessing.
3. Filter using the resolved ID: count_objects or search_objects with { property: "hubspot_owner_id", operator: "EQ", value: "<owner id>" }, combined with any other conditions (e.g. dealstage NOT IN closed stages, for "open deals").
4. Do not confuse hubspot_owner_id (record owner — a sales rep) with fields like hs_lead_status or notes_last_contacted, which describe outreach state, not ownership.
