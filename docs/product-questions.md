# Product Owner Interview — Revenue Lifecycle Intelligence Platform

---

## Questions & Answers

**1. What is this product/feature?**
A system that ensures sales teams spend time only on leads that convert and are liquid, and that can offer interventions along the customer journey to help them succeed at using the product and ultimately pay their invoices.

**2. Who are the users?**

- Sales Rep — qualifies and closes leads
- Collections Agent — chases unpaid invoices and manages recovery
- Finance Controller — manages AR/AP and financial reporting
- Customer — the prospect or paying entity
- CFO Office — strategic portfolio view, CLTV, and macro risk
- Internal Account Manager (large firms) — manages ongoing relationship for enterprise accounts

**3. What problem does it solve?**
Sales people chase bogus leads because they are not funded. Account managers spend too much time collecting invoices (they are good at sales, not collections). The system enables more targeted sales, spreading the team less thin across more leads by routing work to the right people.

**4. What are the top three user actions?**

1. Score and route a sales lead by ability to pay — someone other than the Sales Rep (or an AI agent) determines liquidity and scores the target before it reaches the rep.
2. Balance that score against Customer Lifetime Value — CLTV has macro-economy inputs, micro per-industry inputs, and company-level market share growth signals.
3. KYC of the customer matters for liquidity — KYC data feeds the scoring engine.

**5. What are the hard constraints?**
_(To be confirmed — KYC regulatory compliance implied; FDCPA/GDPR likely applicable for collections and data handling)_

---

## CLTV Comp Inputs (clarified in session)

**Macro:**

- Interest rates / credit conditions
- GDP growth / recession signals
- Inflation / input cost pressure

**Industry (micro):**

- Industry growth rate
- Competitive intensity
- Payment norms by sector (net-30 vs net-90, default rates by SIC code)

**Company-level:**

- Revenue growth trajectory
- Funding stage / balance sheet (runway, debt load)
- Market share movement
- Historical payment behavior / credit bureau data
