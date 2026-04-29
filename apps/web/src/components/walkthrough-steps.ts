/**
 * @file walkthrough-steps.ts
 *
 * Pure data: role-specific first-login walkthrough step definitions.
 *
 * Extracted from WalkthroughModal so unit tests can import step data without
 * pulling in React.
 *
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/57
 */

export interface WalkthroughStep {
  title: string;
  description: string;
}

export const SALES_REP_STEPS: WalkthroughStep[] = [
  {
    title: 'Lead Queue',
    description:
      'Your lead queue lists all active prospects ranked by their composite score. Higher-scored leads convert at a greater rate — always prioritise from the top.',
  },
  {
    title: 'Tier Badge & Score Rationale',
    description:
      'Each lead carries a tier badge (A / B / C) derived from its CLTV estimate. Click the badge or score to open the score rationale panel, which explains the main factors driving the rank.',
  },
  {
    title: 'Stage Selector & Required Notes',
    description:
      'Use the stage selector pin in the lead detail view to progress a deal through the pipeline. Each stage transition requires a note so your team keeps full context.',
  },
];

export const CFO_STEPS: WalkthroughStep[] = [
  {
    title: 'Executive Summary Bar',
    description:
      'The summary bar at the top of the CFO dashboard shows five live portfolio metrics: pipeline by tier, weighted close rate, AR aging, collection recovery rate, and active score model version.',
  },
  {
    title: 'Scenario Modeler',
    description:
      'Use the scenario modeler sliders to stress-test your portfolio under different macro conditions — interest rate changes and GDP growth scenarios — and see CLTV estimates recomputed instantly.',
  },
  {
    title: 'Export Button',
    description:
      'Click Export to download a CSV of the current portfolio view, including any active scenario overrides. Useful for offline analysis or board presentations.',
  },
];

export const COLLECTIONS_AGENT_STEPS: WalkthroughStep[] = [
  {
    title: 'Case Queue',
    description:
      'Your case queue lists all active collection cases assigned to you, sorted by days overdue. Click any row to open the full case detail — invoice amount, customer info, and contact history.',
  },
  {
    title: 'Contact Log',
    description:
      'Inside each case you can log every contact attempt — email, phone, or written notice. Choose the contact type, record the outcome, and add notes. The full history stays attached to the case so your team has complete context.',
  },
  {
    title: 'Payment Plan Panel',
    description:
      'When a customer agrees to pay in instalments, use the Payment Plan panel to record the schedule. Each instalment is tracked separately, and the case stays open until all instalments are marked paid or the case is resolved.',
  },
];

export const ACCOUNT_MANAGER_STEPS: WalkthroughStep[] = [
  {
    title: 'Customer Health Dashboard',
    description:
      'The health dashboard shows a real-time composite health score for every customer in your portfolio. Scores are computed from payment behaviour, invoice aging, and open collection cases — giving you an at-a-glance view of which accounts need attention.',
  },
  {
    title: 'Health Alerts & Signal Labels',
    description:
      'When a customer\'s health score drops below the alert threshold, an alert card appears with colour-coded signal labels explaining the contributing factors — for example "Overdue invoice", "Open collection case", or "Payment plan active". Use these signals to prioritise outreach.',
  },
  {
    title: 'Intervention Form',
    description:
      'Click "Log Intervention" on any alert to open the intervention form. Record the action taken, outcome, and any follow-up notes. Logged interventions feed back into the health score computation, so proactive contact is reflected in the customer\'s trajectory.',
  },
];

export const BDM_STEPS: WalkthroughStep[] = [
  {
    title: 'Campaign Analysis',
    description:
      'The Campaign Analysis page gives you a view of anonymised corpus chunks across your asset manager and fund entities. Use the entity picker tabs to switch between asset managers and funds, then select an entity to explore the associated data chunks.',
  },
  {
    title: 'Entity Picker',
    description:
      'Switch between the Asset Manager and Fund tabs to filter the entity list. Selecting an entity loads its anonymised corpus chunks — no customer identifiers are exposed, only chunk metadata like token count and index.',
  },
  {
    title: 'Chunk Results',
    description:
      'Each chunk result shows the relevant segment of anonymised content for the selected entity. Use these results to understand the data landscape before launching outreach campaigns.',
  },
];

export const FINANCE_CONTROLLER_STEPS: WalkthroughStep[] = [
  {
    title: 'AR Aging Dashboard',
    description:
      'The AR Aging dashboard groups all outstanding invoices by age bucket: current, 1-30 days, 31-60 days, 61-90 days, and 90+ days overdue. Use this view to understand your overall receivables exposure and identify which buckets carry the most risk.',
  },
  {
    title: 'Invoice Drilldown',
    description:
      "Click any invoice row to open the drilldown panel. You'll see the full invoice details, customer profile, payment history, and the current collection case status if one is open. Use this to investigate specific accounts before making write-off decisions.",
  },
  {
    title: 'Write-off Approvals Queue',
    description:
      'Collections Agents propose settlement amounts that exceed their approval threshold. Those proposals land here for your review. Approve or reject each request — your decision is recorded in the audit log and the case status updates automatically.',
  },
];
