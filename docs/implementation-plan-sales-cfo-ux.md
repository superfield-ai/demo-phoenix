# Implementation Plan — Sales Rep & CFO UX

**Scope:** Excellent UX for Sales Rep and CFO Office roles as defined in `docs/prd.md`  
**Last updated:** 2026-04-28  
**Strategy:** Foundation first, then two parallel UX surfaces, then polish. Each phase ships independently and is usable on its own.

---

## Design Principles

1. **Zero cognitive overhead for the Sales Rep.** The system does the scoring work; the rep sees a queue ranked by opportunity quality and opens leads already loaded with context. No hunting, no manual research.
2. **The CFO dashboard is a decision surface, not a report.** Every chart is interactive. Macro scenario inputs change the numbers live. Export is a secondary action, not the primary use case.
3. **Score transparency is a trust feature.** Both Sales Reps and CFOs must see why a score is what it is — not just the number. Black-box scoring destroys adoption.
4. **Role-gated views.** Sales Reps never see raw financials. CFO sees aggregates, not individual contact records. Permissions are structural, not bolted on.

---

## Phase 0 — Foundation (prerequisite for all UX phases)

Everything in Phase 1 and Phase 2 depends on this. Ship it first and validate the data model before building surfaces on top.

### P0-1: Data schema and migrations

- Implement all entities from PRD Section 5: `Prospect`, `KYCRecord`, `CLTVScore`, `Customer`, `Deal`, `Invoice`, `Payment`, `DunningAction`, `CollectionCase`, `PaymentPlan`, `Intervention`, `MacroIndicator`, `IndustryBenchmark`
- Enforce all state transition constraints at the database level (check constraints or enum types)
- Role-based access control: `sales_rep`, `collections_agent`, `finance_controller`, `cfo`, `account_manager` roles with row-level or query-level enforcement

### P0-2: KYC integration (pluggable stub)

- Abstract KYC provider behind an interface: `verify(prospect_id) → KYCRecord`
- Ship a deterministic stub that returns synthetic KYC results for development and testing
- Wire the real provider (Dun & Bradstreet / Experian / TBD) behind the same interface — swap without touching application code
- Trigger KYC automatically on Prospect creation; update status asynchronously

### P0-3: CLTV scoring engine

- Versioned scoring model: each computation stores `score_version`, `macro_inputs_snapshot`, `industry_inputs_snapshot`, `company_inputs_snapshot`, and `composite_score`
- Inputs:
  - **Macro:** interest rate index, GDP growth signal, inflation indicator — sourced from `MacroIndicator` table, updated via scheduled import job
  - **Industry:** growth rate, default rate, payment norm days — sourced from `IndustryBenchmark` by SIC code
  - **Company:** revenue growth trajectory, funding stage, debt load, market share signal — sourced from KYC record + enrichment
- Weighted composite formula (initial weights configurable, not hardcoded)
- Re-score trigger: fires within 24 hours when `MacroIndicator` or `IndustryBenchmark` rows are updated
- Score tier classification: `A` (top quartile), `B`, `C`, `D` (disqualified) — threshold configurable per environment

### P0-4: Lead qualification routing

- Routing rule: `KYCRecord.verification_status = verified AND CLTVScore.composite_score ≥ threshold → push to sales queue`
- Disqualified leads parked with `disqualification_reason` and eligible for scheduled re-score
- Queue assignment: round-robin or manual assignment (configurable)

---

## Phase 1 — Sales Rep UX

**Goal:** A rep opens the app and immediately knows exactly which lead to call next and why.

### P1-1: Lead queue

**The primary surface. A rep's entire day starts here.**

- List view sorted by composite score descending (highest-value, most-liquid first)
- Each row shows:
  - Company name, industry, SIC code
  - Score tier badge (A / B / C) with color coding
  - CLTV estimate (range, not a point — communicates uncertainty honestly)
  - KYC status pill (`verified`, `pending`, `manual review`)
  - Days in queue (urgency signal — older qualified leads risk going cold)
  - Assigned rep (for managers viewing team queues)
- Filters: score tier, industry, days in queue, assigned rep
- Sort: by score (default), by CLTV estimate, by days in queue
- Empty state: if queue is empty, show a message confirming it is empty because scoring is working — not a bug
- Disqualified tab: lets reps see what was filtered out and why (read-only, no actions)

**UX decisions:**

- No pagination — virtual scroll. Reps should not have to page; the list is the funnel.
- No search by company name in the primary queue — if you are searching, you are not working the queue. Search lives in a global lookup, separate from the queue.
- Score tier badge is the most visually prominent element in each row — it is the whole point.

---

### P1-2: Lead detail view

**A rep clicks a lead. This view must answer: "Should I call this person right now, and what do I say?"**

#### Score rationale panel

- Composite score gauge (0–100) with tier label
- Three sub-scores broken out as horizontal bar segments:
  - **Macro health** — e.g., "Low interest rate environment, stable GDP: favorable"
  - **Industry signal** — e.g., "SaaS sector: 18% growth, 2.1% default rate, net-30 norms"
  - **Company signal** — e.g., "Series B, 3x revenue growth YoY, debt/revenue ratio: 0.4"
- Each segment has a one-line plain-English explanation (generated at score time, stored, not re-generated on view)
- Score computed timestamp + model version shown (trust signal)

#### KYC summary panel

- Verification status with timestamp
- Funding stage, estimated annual revenue, debt load (shown as ranges, not exact figures — respects data sensitivity)
- Link to re-trigger KYC (for manual review cases)

#### CLTV estimate panel

- Estimated 3-year customer value (range: low / mid / high scenario)
- Scenario toggle: shows how CLTV shifts under a macro stress scenario (e.g., rate rise +200bps)
- "Why this matters" tooltip: explains CLTV to reps who are not financially trained

#### Contact and activity panel

- Pipeline stage selector (Contacted → Qualified → Proposal → Closed Won / Closed Lost)
- Stage change requires a note (one sentence minimum — enforces discipline)
- Timeline of all activity: stage changes, notes, KYC events, score updates
- Quick actions: Log call, Send email, Schedule follow-up

**UX decisions:**

- Score rationale is always visible above the fold — reps should never have to scroll to find it.
- Pipeline stage change is the primary action button, always pinned to the bottom of the view.
- No form fields for data the system already knows. Pre-populate everything derivable.

---

### P1-3: Pipeline board (optional rep view)

- Kanban columns: Contacted / Qualified / Proposal / Closed Won / Closed Lost
- Cards show: company name, score tier badge, CLTV estimate, days in stage
- Cards are not draggable — stage changes happen in the detail view with a required note. Kanban is read-only visualization.
- Column value totals (sum of CLTV estimates per stage) give reps a personal pipeline value view

---

### P1-4: Notifications and nudges

- In-app notification when a new qualified lead enters the rep's queue
- In-app notification when a lead's score drops (e.g., macro conditions shift, company signal weakens) while it is in the rep's pipeline
- Nudge: if a lead has been in `Contacted` for more than N days with no activity, surface a "follow up?" prompt in the queue row

---

## Phase 2 — CFO UX

**Goal:** A CFO opens the dashboard, understands the health of the revenue portfolio in under 60 seconds, and can stress-test assumptions before a board meeting.

### P2-1: Executive summary bar

**Always visible at the top of the CFO dashboard. Numbers, not charts.**

| Metric                   | Description                                                            |
| ------------------------ | ---------------------------------------------------------------------- |
| Qualified pipeline value | Sum of CLTV estimates for all leads in Sales Rep queues, by tier       |
| Weighted close rate      | Historical close rate weighted by score tier                           |
| AR aging summary         | Total outstanding by bucket (current / 30 / 60 / 90 / 120+)            |
| Collection recovery rate | % of in-collection invoices resolved paid or settled, trailing 90 days |
| Score model version      | Which CLTV model version is active (trust signal)                      |

Each number is clickable and drills into the chart below it.

---

### P2-2: CLTV portfolio view

**The "revenue quality" chart. The CFO's most important read.**

- Primary visualization: treemap or bubble chart
  - X-axis: industry segment
  - Y-axis (bubble size): total CLTV in that segment
  - Color: average score tier (green A → red D)
- Secondary view toggle: stacked bar by company segment (SMB / Mid-Market / Enterprise)
- 12-month trend line overlay: shows how portfolio CLTV composition has shifted
- Hover tooltip: segment name, total CLTV, lead count, average composite score, dominant industry signal

**Macro scenario modeler (the CFO's killer feature):**

- Panel with three sliders:
  - Interest rate delta (−200bps to +300bps from current)
  - GDP growth assumption (recession / flat / moderate / strong)
  - Industry stress toggle (select one or more industries to apply a sector shock)
- As sliders move, the CLTV portfolio chart and executive summary bar update live (client-side recomputation using cached score inputs — no server round-trip needed for the visualization layer)
- "Reset to actuals" button snaps back to the real computed scores
- "Save scenario" exports the current slider state + resulting numbers as a PDF/CSV for board presentation

---

### P2-3: Lead score tier trend

**"Is our pipeline quality improving?"**

- Line chart: X-axis = week, Y-axis = % of qualified leads per tier (A / B / C)
- Secondary line: total qualified lead volume per week
- The two together answer: are we getting more leads, and are they better leads?
- Comparison toggle: current quarter vs. prior quarter

---

### P2-4: AR aging dashboard

**The cash flow risk view.**

- Stacked bar chart: AR balance by aging bucket (current / 30 / 60 / 90 / 120+)
- Each bar is colored by risk (green → red)
- Drilldown: click a bucket → see the invoice list sorted by amount descending
- Table columns: Customer, Invoice amount, Due date, Days overdue, Status, Assigned agent
- From the table, CFO can see (read-only) whether a CollectionCase is open and what the escalation level is
- Trend line: AR aging profile over the trailing 12 months — is the 90+ bucket growing?

---

### P2-5: Collections performance panel

- Recovery rate by agent (anonymized in the default view; names visible to Finance Controller role only)
- Average days to resolution by escalation level
- Write-off rate and total write-off amount, trailing 12 months
- Payment plan success rate: % of plans that complete vs. breach

---

### P2-6: Report export and scheduling

- Any chart or table is exportable to CSV or PDF with one click
- Scheduled report: CFO configures a weekly/monthly email with a snapshot of the executive summary bar and CLTV portfolio chart
- Export always includes the macro scenario state so the recipient knows what assumptions the numbers reflect

---

## Phase 3 — Polish and Trust

Do not skip this phase. CFOs and Sales Reps will not adopt a tool that feels unfinished. These items directly determine whether the product gets used.

### P3-1: Loading and empty states

- Every data surface has a skeleton loader — no spinners, no blank white screens
- Every empty state has an explanation: "No qualified leads yet — KYC checks are running for N prospects" is better than a blank queue
- Score computation in progress: show a "Scoring..." state in the lead card rather than hiding the row

### P3-2: Score explanation tooltips

- Every score badge, score component bar, and CLTV figure has a `?` tooltip in plain English
- Target audience: a Sales Rep who has never heard of CLTV, and a CFO who wants to know the formula
- Two tooltip variants: summary (one sentence) and detail (expandable, shows the formula and inputs)

### P3-3: Onboarding flows

- **Sales Rep first login:** three-step walkthrough — "Here is your queue. Here is what the score means. Here is how to move a lead forward."
- **CFO first login:** three-step walkthrough — "Here is your portfolio view. Here is how to use the scenario modeler. Here is where to export for your board deck."
- Walkthroughs are dismissible and re-triggerable from the help menu

### P3-4: Mobile responsiveness (CFO priority)

- CFO dashboard executive summary bar and CLTV portfolio chart must render correctly on a tablet (1024px) for board meeting use
- Sales Rep queue must be usable on mobile (reps call leads from their phones)
- Full feature parity on mobile is out of scope — these are the minimum viable breakpoints

### P3-5: Keyboard shortcuts (Sales Rep priority)

- `J` / `K`: navigate up/down the lead queue
- `Enter`: open lead detail
- `N`: log a note on the current lead
- `S`: change pipeline stage
- Shortcuts shown in a help overlay (`?` key)

---

## Sequencing Summary

```
Phase 0 (Foundation)
  ├── P0-1: Schema & migrations
  ├── P0-2: KYC integration stub
  ├── P0-3: CLTV scoring engine
  └── P0-4: Lead routing logic
        │
        ├── Phase 1 (Sales Rep UX)
        │     ├── P1-1: Lead queue
        │     ├── P1-2: Lead detail view  ← highest UX leverage
        │     ├── P1-3: Pipeline board
        │     └── P1-4: Notifications
        │
        └── Phase 2 (CFO UX)
              ├── P2-1: Executive summary bar
              ├── P2-2: CLTV portfolio + scenario modeler  ← highest UX leverage
              ├── P2-3: Score tier trend
              ├── P2-4: AR aging dashboard
              ├── P2-5: Collections performance
              └── P2-6: Export and scheduling
                    │
                    └── Phase 3 (Polish)
                          ├── P3-1: Loading & empty states
                          ├── P3-2: Score explanation tooltips
                          ├── P3-3: Onboarding flows
                          ├── P3-4: Mobile responsiveness
                          └── P3-5: Keyboard shortcuts
```

Phase 1 and Phase 2 can run in parallel once Phase 0 is complete. Phase 3 runs alongside the tail of Phase 2.

---

## Open Decisions Before Phase 0 Starts

| #   | Decision                                                                        | Blocks           |
| --- | ------------------------------------------------------------------------------- | ---------------- |
| 1   | KYC provider selection (determines API contract for P0-2)                       | P0-2, P1-2       |
| 2   | Initial CLTV scoring weights and qualification threshold                        | P0-3, P0-4, P1-1 |
| 3   | MacroIndicator data source (Fed API? Bloomberg? Manual import?)                 | P0-3, P2-2       |
| 4   | Technology stack for CFO charting (Recharts, Nivo, Observable Plot, D3 direct?) | P2-2, P2-3, P2-4 |
| 5   | Client-side vs. server-side scenario recomputation for macro modeler            | P2-2             |

---

## Success Metrics

| Metric                                  | Target                                              | Measurement       |
| --------------------------------------- | --------------------------------------------------- | ----------------- |
| Sales Rep queue-to-call time            | < 30 seconds from login to first outreach           | Session analytics |
| Lead score rationale viewed per session | > 80% of leads opened                               | Event tracking    |
| CFO dashboard time-to-insight           | CFO identifies top AR risk segment in < 60s         | Usability test    |
| Macro scenario modeler usage            | > 50% of CFO sessions include at least one scenario | Event tracking    |
| Sales Rep qualification rate            | Qualified leads / total leads submitted             | CRM funnel data   |
| Pipeline quality trend                  | Score tier A % increases quarter-over-quarter       | CLTV scoring data |
