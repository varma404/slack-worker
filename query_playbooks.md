Step-by-step recipes for common multi-step query types. Follow them exactly — they encode fixes for past counting mistakes.

## Stage Progression ("moved past X")

"Moved past [stage]" / "after [stage]":
The Sales Pipeline stage order is: Objective Win → Functional Win → Value Win → Commercial Win → Legal Win → Closed Won.
"Moved past Objective Win" means the deal's current dealstage is any stage AFTER Objective Win: qualifiedtobuy, presentationscheduled, 28218292, contractsent, closedwon.
Use the IN operator with all stages past the named one. Do NOT include closedlost, MQO, DQ, Sales Nurture, or Dead/Duplicate — those are exit paths, not progression.

## Cross-Object Mismatch Queries

Questions comparing a property on one object against a property on its associated object (e.g. "deals marked ICP but the company is marked non-ICP", "contacts flagged as X but their company says Y"):
1. Identify which side's OWN filters are more selective — usually whichever side has more distinct conditions stacked together (e.g. "non-ICP AND MQL'd in 2026 AND sourced from marketing" on the company side is far more selective than "ICP = Yes" alone on the deal side).
2. Use the batch tool anchored on that more-selective side: `get_companies_with_deal_properties` (company-side filters, returns each company's associated deals) or `get_deals_with_company_properties` (deal-side filters, returns each deal's associated company) — whichever pushes the most conditions down as real HubSpot filters.
3. Fetch that one batch, then do the actual mismatch check (comparing the two objects' property values) yourself across the returned records — this is reasoning, not another tool call.
4. NEVER call `get_deal` or `get_company` more than 2-3 times in a row to check individual records against a condition — if you find yourself doing this, stop and restructure the query as a batch call on the more selective side instead. Repeated single-record lookups don't scale and burn far more tokens than a single batch call.

## Cross-Object Contact + Company Queries

Cross-object contact + company questions:
For questions needing contact details WITH company properties (name, ICP, revenue), use get_contacts_with_company_properties. This handles the batch lookup in one call.
Example: "CXOs at ICP companies" → get_contacts_with_company_properties with jobtitle filter + request company is_the_company_icp_ property, then filter results where company.is_the_company_icp_ = Yes.

## CXO / C-Level Search

CXO / C-level title search:
HubSpot jobtitle is a free-text field. To find C-level contacts, search with CONTAINS_TOKEN for "Chief" — this catches CEO, CFO, CTO, CMO, COO, and other Chief titles in one query. If you need specific titles only, make separate searches per title and deduplicate by contact ID.

## Ratio / Comparison Queries

Ratio / comparison questions:
For "X vs Y ratio" or "X vs Y trend", make count_objects calls for each category per time period. Present results as a numbered list with both counts and the calculated ratio/percentage.

## Revenue Context

"Revenue" in deal vs company context:
- "Deal value" / "deal amount" / "ARR" → amount on Deal
- "Company revenue" / "annual revenue" / "revenue" when filtering companies → estimated_yearly_sales__2025_ on Company
- If a question says "deals with revenue < $X" without specifying deal or company, default to company revenue (estimated_yearly_sales__2025_) via get_deals_with_company_properties unless the user specifically says "deal amount".

## Funnel Milestone Queries

FUNNEL MILESTONE QUERIES ("how many reached X", "how many booked first meeting", "how many got to demo"):
Both lifecycle stage AND deal stage reflect CURRENT position only, not history. Do NOT use lifecycle stage alone for funnel milestone counts.

FIRST MEETING HAPPENED — correct definition:
A company/deal had their first meeting if they have a deal in pipeline = default at ANY stage EXCEPT:
  - MQO (152224771) — meeting was SCHEDULED but prospect NO-SHOWED → does NOT count as first meeting
  - Dead/Duplicate (28023967) — stale or invalid, no meeting implied
  - Junk — invalid lead

Full "first meeting happened" dealstage IN list (use this):
  appointmentscheduled, qualifiedtobuy, presentationscheduled, 28218292, contractsent,
  closedwon, closedlost, 217786505, 175509306, 175526434

This correctly includes Sales Nurture (217786505), DQ (175509306), Closed Lost, and Churn — all require a meeting to have entered. A deal that went Objective Win → Sales Nurture or DQ STILL had its first meeting.

For deeper funnel milestones:
  - "SQL / Functional Win reached" → dealstage IN: qualifiedtobuy, presentationscheduled, 28218292, contractsent, closedwon, closedlost, 217786505
  - "Demo / Value Win reached" → dealstage IN: presentationscheduled, 28218292, contractsent, closedwon, closedlost

For contact-level funnel attribution (e.g. "leads from source X → MQL → first meeting"):
1. Leads: contacts matching the source filter (createdate range + source property)
2. MQL: associated Company has mql_date IS NOT NULL
3. First meeting happened: associated Company has a deal in pipeline = default with dealstage IN (appointmentscheduled, qualifiedtobuy, presentationscheduled, 28218292, contractsent, closedwon, closedlost, 217786505, 175509306, 175526434)
