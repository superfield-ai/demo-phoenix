# Product Requirements Document — Revenue Lifecycle Intelligence Platform

**Status:** Draft  
**Last updated:** 2026-04-28

---

## 1. Overview

The Revenue Lifecycle Intelligence Platform is a unified system that manages the full commercial journey from prospecting through invoice payment and debt recovery. Its core function is to score incoming leads on liquidity and lifetime value before they ever reach a Sales Rep, route work to the people best equipped to do it (sales to reps, collections to agents), and proactively intervene when customers show signs of churn or payment risk. The result is a sales team that closes more by working fewer, better leads, and an AR process that does not depend on account managers to chase money.

---

## 2. User Roles

| Role                     | Description                                 | Primary job                                                        |
| ------------------------ | ------------------------------------------- | ------------------------------------------------------------------ |
| Sales Rep                | Quota-carrying seller                       | Work pre-qualified leads and close deals                           |
| Collections Agent        | AR recovery specialist                      | Contact customers with overdue invoices and resolve balances       |
| Finance Controller       | Owns AR/AP ledger and reporting             | Monitor cash flow, aging buckets, and escalate write-off decisions |
| Customer                 | Prospect or paying entity                   | Onboard, use the product, pay invoices                             |
| CFO Office               | Strategic financial oversight               | View portfolio health, CLTV trends, macro risk exposure            |
| Internal Account Manager | Enterprise relationship owner (large firms) | Grow and retain accounts; not responsible for collections          |

### User Stories

**Sales Rep**

- As a Sales Rep, I want to see only leads that have passed liquidity and KYC scoring so that I don't waste time on prospects who cannot pay.
- As a Sales Rep, I want to see a CLTV estimate and score rationale for each lead so that I can prioritize highest-value opportunities.

**Collections Agent**

- As a Collections Agent, I want invoices automatically routed to my queue when they breach the dunning threshold so that I don't need account managers to hand them off to me.
- As a Collections Agent, I want a full payment and contact history for each debtor so that I can open conversations with context rather than cold.
- As a Collections Agent, I want to offer and track payment plans and settlements so that I can resolve balances without full write-offs.

**Finance Controller**

- As a Finance Controller, I want an aging bucket view (current, 30, 60, 90, 120+ days) so that I can assess collection risk at a glance.
- As a Finance Controller, I want to approve write-off decisions above a configurable threshold so that large losses have a human gate.
- As a Finance Controller, I want a real-time AR dashboard so that I can report accurate cash position to the CFO office.

**CFO Office**

- As a CFO, I want a portfolio-level CLTV trend view segmented by industry and macro scenario so that I can assess revenue quality and forward exposure.
- As a CFO, I want to see the ratio of leads by score tier over time so that I can evaluate whether the scoring model is improving pipeline quality.

**Internal Account Manager**

- As an Account Manager, I want customer health scores surfaced in my account view so that I can intervene before a customer churns or goes delinquent.
- As an Account Manager, I want collections to be handled by specialists once an invoice is overdue so that I can stay focused on growth.

**Customer**

- As a Customer, I want clear invoice statements with payment options so that I can pay without friction.
- As a Customer, I want to request a payment plan through the platform so that I can resolve a balance I cannot pay in full immediately.

---

## 3. Jobs to Be Done

Ranked by business criticality.

1. **Score and route incoming leads** — Scoring engine or AI agent, triggered on lead creation, before any Sales Rep sees the record. Determines whether a rep's time should be spent.
2. **Manage the invoice-to-cash cycle** — Finance Controller and Collections Agent, triggered on invoice issuance, daily cadence. Keeps AR aging controlled.
3. **Intervene on at-risk customers** — Account Manager or automated agent, triggered by health score drop, proactive cadence. Prevents churn and pre-empts delinquency.
4. **Recover overdue balances** — Collections Agent, triggered by dunning breach, case-by-case. Maximizes recovery rate while preserving customer relationship where viable.
5. **Report portfolio health to CFO** — CFO Office, weekly/monthly cadence. Feeds strategic decisions on credit policy and market exposure.

---

## 4. Core Workflows

### 4.1 Lead Qualification and Routing

**Actor:** Scoring engine (automated) + Sales Rep  
**Trigger:** New lead created (manual entry or inbound integration)

**Happy path:**

1. Lead record created with company name, industry, and contact details.
2. KYC check triggered automatically — identity verification, credit bureau pull, funding stage, balance sheet signals.
3. Macro and industry CLTV inputs fetched (interest rate environment, sector growth index, SIC-code default rates).
4. Composite liquidity + CLTV score computed and attached to the lead.
5. If score ≥ qualification threshold → lead pushed to Sales Rep queue with score rationale visible.
6. Sales Rep works the lead through standard pipeline stages (Contacted → Qualified → Proposal → Closed Won/Lost).

**Exception paths:**

- If KYC check fails or returns insufficient data, lead is flagged for manual review and held out of rep queues until resolved.
- If score < threshold, lead is disqualified and parked in a low-priority pool; a scheduled re-score runs if macro conditions improve.

---

### 4.2 Customer Health Monitoring and Intervention

**Actor:** Platform (automated) + Account Manager  
**Trigger:** Customer onboarded; health score drops below configured warning threshold

**Happy path:**

1. Customer record created on deal close; product usage, support ticket volume, and payment behavior feed a continuous health score.
2. Health score displayed on Account Manager dashboard; drops trigger an alert.
3. Account Manager reviews the health signal and selects or is assigned an intervention playbook (e.g., success call, training session, executive sponsor outreach).
4. Intervention logged with outcome; health score updated based on subsequent behavior.

**Exception paths:**

- If health score reaches critical threshold and no intervention is logged within N days, an escalation alert fires to the team lead.
- If the customer is already in a collections case, intervention responsibility transfers to the Collections Agent.

---

### 4.3 Invoice Lifecycle and Dunning

**Actor:** Finance Controller (oversight) + automated dunning engine  
**Trigger:** Invoice issued to customer

**Happy path:**

1. Invoice generated (manual or via billing integration) with amount, due date, and payment instructions.
2. Invoice delivered to customer via email/portal on issuance.
3. Payment received before due date → invoice marked Paid; payment recorded.

**Exception paths:**

- If unpaid at due date → dunning sequence starts automatically:
  - D+1: Friendly reminder (email)
  - D+7: Second notice with payment link
  - D+14: Firm notice; Account Manager notified
  - D+30: Invoice routed to Collections Agent queue; status set to In Collection
- If partially paid, the dunning sequence continues on the residual balance.
- If customer requests a payment plan before D+30, a Collections Agent can configure a plan that pauses the dunning clock while installments are current.

---

### 4.4 Collections and Recovery

**Actor:** Collections Agent  
**Trigger:** Invoice reaches In Collection status (D+30 overdue)

**Happy path:**

1. Collections case opened automatically; assigned to available Collections Agent based on load balancing rules.
2. Agent reviews payment history, KYC record, and prior contact log.
3. Agent initiates outreach (call, email, portal message) — all contact logged.
4. Customer pays in full → case closed; invoice marked Paid.

**Exception paths:**

- Customer requests payment plan → Agent configures installment schedule; plan acceptance recorded; case remains open until fully paid.
- Customer offers partial settlement → Finance Controller approval required above write-off threshold; if approved, remainder written off and case closed.
- No response or payment after escalation ladder (D+60, D+90) → case escalated to legal referral or write-off decision gate.
- Write-off above threshold requires Finance Controller approval.

---

### 4.5 Portfolio Reporting (CFO View)

**Actor:** CFO Office  
**Trigger:** Scheduled (weekly/monthly) or on-demand

**Happy path:**

1. CFO opens portfolio dashboard.
2. Views CLTV distribution by segment (industry, company size, geography).
3. Views AR aging summary and collection recovery rate trend.
4. Views lead score tier distribution over time (pipeline quality signal).
5. Exports report or schedules recurring delivery.

---

## 5. Data Model

### Entities

| Entity            | Key fields                                                                                                          | Relationships                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Prospect          | id, company_name, industry, sic_code, stage, assigned_rep_id, disqualified_at                                       | has one KYCRecord, has one CLTVScore, has many DunningActions      |
| KYCRecord         | id, prospect_id, verification_status, credit_score, funding_stage, annual_revenue_est, debt_load_est, checked_at    | belongs to Prospect                                                |
| CLTVScore         | id, entity_id, entity_type, macro_score, industry_score, company_score, composite_score, score_version, computed_at | polymorphic: belongs to Prospect or Customer                       |
| Customer          | id, prospect_id, company_name, segment, health_score, account_manager_id, created_at                                | has many Invoices, has many Interventions, has one CLTVScore       |
| Deal              | id, prospect_id, stage, value, close_date, owner_rep_id                                                             | belongs to Prospect                                                |
| Invoice           | id, customer_id, amount, currency, due_date, status, issued_at                                                      | has many Payments, has one CollectionCase, has many DunningActions |
| Payment           | id, invoice_id, amount, method, received_at, recorded_by                                                            | belongs to Invoice                                                 |
| DunningAction     | id, invoice_id, action_type, scheduled_at, sent_at, response                                                        | belongs to Invoice                                                 |
| CollectionCase    | id, invoice_id, agent_id, status, escalation_level, resolution_type, opened_at, resolved_at                         | belongs to Invoice                                                 |
| PaymentPlan       | id, collection_case_id, total_amount, installment_count, installment_amount, next_due_date, status                  | belongs to CollectionCase                                          |
| Intervention      | id, customer_id, trigger_type, playbook, assigned_to, status, outcome, created_at, resolved_at                      | belongs to Customer                                                |
| MacroIndicator    | id, indicator_type, value, effective_date, source                                                                   | referenced by CLTVScore computation                                |
| IndustryBenchmark | id, sic_code, growth_rate, default_rate, payment_norm_days, effective_date                                          | referenced by CLTVScore computation                                |

### Constraints

- A Prospect may have at most one active KYCRecord; re-checks create a new record and archive the previous.
- A Prospect may only enter a Sales Rep queue when KYC status is `verified` and composite_score ≥ system-configured threshold.
- An Invoice may have at most one open CollectionCase.
- A CollectionCase write-off requires `approved_by` from a user with Finance Controller role when amount exceeds `write_off_approval_threshold` (configurable).
- Invoice status transitions are strictly ordered: `draft → sent → (partial_paid | overdue) → in_collection → (paid | settled | written_off)`.
- A PaymentPlan pauses the dunning clock while its status is `current`; a missed installment resumes the dunning sequence.
- CLTVScore.score_version tracks the model version used; old scores are not deleted when the model updates.

---

## 6. Acceptance Criteria

### Lead Scoring and Routing

- [ ] Given a new Prospect is created, when all required KYC fields are present, then a KYCRecord is created and verification is initiated within 60 seconds.
- [ ] Given KYC verification completes, when the composite CLTV score is computed, then the Prospect record is updated with the score and a score rationale summary before it is visible in any Sales Rep queue.
- [ ] Given composite_score < qualification_threshold, when a Sales Rep views their lead queue, then the disqualified Prospect does not appear in that queue.
- [ ] Given a KYC check returns insufficient data, when the system attempts to compute a score, then the Prospect is flagged `kyc_manual_review` and removed from all rep queues until the flag is cleared by an authorized user.
- [ ] Given composite_score ≥ qualification_threshold, when a Sales Rep opens the lead, then the score, macro inputs, industry inputs, and company-level signals are all visible with source labels.

### CLTV Score Computation

- [ ] Given a CLTVScore is computed, when the underlying MacroIndicator or IndustryBenchmark data is updated, then a re-score is triggered for all affected Prospects and Customers within 24 hours.
- [ ] Given a CLTVScore is computed, then the record stores the score_version and computed_at so that score drift over time is auditable.

### Invoice and Dunning

- [ ] Given an Invoice is issued, when the due date is reached and no Payment exists, then a DunningAction of type `reminder_d1` is created and the communication sent within 1 hour.
- [ ] Given the dunning sequence reaches D+30, when no full payment exists, then a CollectionCase is automatically opened and the invoice status transitions to `in_collection`.
- [ ] Given a CollectionCase is opened, when load balancing assigns an agent, then the assigned Collections Agent receives a notification and the case appears in their queue within 5 minutes.
- [ ] Given a PaymentPlan is active and all installments are current, when the dunning engine evaluates the invoice, then no further dunning actions are created while the plan is in `current` status.
- [ ] Given a PaymentPlan installment is missed, when the system detects the missed payment, then the plan status transitions to `breached` and the dunning sequence resumes from the current overdue age.

### Collections and Recovery

- [ ] Given a Collections Agent proposes a settlement, when the settlement amount results in a write-off above `write_off_approval_threshold`, then the action is blocked until a Finance Controller approves it.
- [ ] Given a Finance Controller approves a write-off, then the Invoice status transitions to `written_off` and the CollectionCase is closed with resolution_type `settlement` within 5 minutes.
- [ ] Given a Collections Agent logs a contact attempt, then the contact type, timestamp, and outcome are recorded on the CollectionCase and are visible to all users with access to that case.

### Customer Health and Intervention

- [ ] Given a Customer's health_score drops below the warning threshold, when the Account Manager views the account, then a health alert is visible with the contributing signals labelled.
- [ ] Given a health alert has been open for N days with no Intervention created, then an escalation notification is sent to the Account Manager's team lead.
- [ ] Given a Customer has an open CollectionCase, when an Account Manager attempts to create an Intervention, then the system surfaces a notice that collections is the primary contact owner for this customer.

### Finance Controller and CFO Reporting

- [ ] Given the Finance Controller opens the AR dashboard, then all invoices are displayed segmented by aging bucket (current, 30, 60, 90, 120+ days) with totals per bucket, refreshed within 5 minutes of the latest payment event.
- [ ] Given the CFO Office opens the portfolio dashboard, then CLTV distribution is shown segmented by industry and company segment, with a 12-month trend line, computed from the most recent CLTVScore per entity.
- [ ] Given the CFO Office selects a macro scenario filter, then the CLTV distribution updates to reflect the selected MacroIndicator values without requiring a page reload.

---

## 7. Constraints

### Must do

- KYC verification must be completed and score computed before a lead is visible to any Sales Rep.
- All contact attempts in collections must be logged with timestamp and outcome — required for regulatory defensibility.
- Write-offs above the configured threshold must have a Finance Controller approval gate.
- CLTV scores must store the model version and inputs used, so score changes are auditable.
- All dunning communications must include a clear payment link and an opt-out/dispute mechanism for the customer.

### Must not do

- Sales Reps must never see leads that have not passed KYC and scoring.
- Account Managers must not be assigned collection tasks — the platform routes overdue invoices to Collections Agents only.
- The system must not allow a write-off to be executed without the appropriate approval where the threshold is breached.
- Score rationale must not expose raw third-party credit bureau data to users who do not have explicit data access permission.

### Regulatory / compliance

- KYC processes must comply with applicable AML/KYC regulations in the jurisdictions of operation.
- Collections outreach must comply with FDCPA (US) and equivalent regulations in other jurisdictions — contact frequency limits, permitted hours, required disclosures.
- Customer personal and financial data must be handled in compliance with GDPR (EU) and equivalent data protection laws.
- Credit bureau data usage must comply with FCRA (US) or equivalent — permissible purpose, adverse action notices.

### Technical constraints

- KYC and credit data must be sourced from a third-party provider via API (specific provider TBD); the platform does not store raw bureau data, only derived scores and flags.
- CLTV scoring must support pluggable model versions so the scoring logic can be updated without migrating historical score records.
- The dunning engine must be idempotent — duplicate triggers must not result in duplicate communications to the customer.

---

## 8. Out of Scope

The following are explicitly excluded from this PRD. They may be addressed in future PRDs.

- Direct lending or credit facility management — the platform assesses liquidity but does not originate loans.
- Full ERP accounting (general ledger, multi-entity consolidation) — AR/AP is in scope; the full accounting layer is not.
- Customer-facing self-service portal UI — customer payment links and plan requests are in scope; a full customer portal is a separate initiative.
- Outbound dialer / telephony integration — Collections Agents log calls manually; automated dialer is out of scope.
- Legal case management — escalation to legal referral is in scope; tracking litigation is not.
- Outbound vendor AP (accounts payable to suppliers) — this PRD covers customer invoicing only, not outbound vendor payments.

---

## 9. Open Questions

| #   | Question                                                                                                     | Owner              | Target resolution date     |
| --- | ------------------------------------------------------------------------------------------------------------ | ------------------ | -------------------------- |
| 1   | Which KYC/credit bureau provider will be integrated? (Experian, Equifax, Dun & Bradstreet, etc.)             | Product Owner      | Before architecture review |
| 2   | What is the initial qualification threshold for composite score — and is it configurable per market segment? | Product Owner      | Before implementation      |
| 3   | What are the write-off approval thresholds for Finance Controller sign-off?                                  | Finance Controller | Before implementation      |
| 4   | Are there multiple jurisdictions at launch, and which FDCPA/GDPR variants apply?                             | Legal/Compliance   | Before implementation      |
| 5   | What billing system generates invoices — integration with existing system, or native invoice generation?     | Product Owner      | Before architecture review |
| 6   | What constitutes a health score drop — which product usage signals and weights define the health score?      | Product Owner      | Before implementation      |

---

## 10. Revision History

| Date       | Author                                        | Change                                                |
| ---------- | --------------------------------------------- | ----------------------------------------------------- |
| 2026-04-28 | Product Owner interview (sduvignau@gmail.com) | Initial draft from structured product owner interview |
