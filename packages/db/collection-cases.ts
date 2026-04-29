/**
 * @file collection-cases.ts
 *
 * Database query functions for the Collections Agent case queue and contact
 * logging feature (issue #49).
 *
 * Exports:
 *   listCollectionCases    — list cases assigned to an agent (with status filter)
 *   getCollectionCaseDetail — full case detail: invoice, customer, payments, contacts, dunning
 *   createContactLog       — insert a contact attempt record
 *   assignAgentToCase      — set agent_id on a collection case
 *   getAgentWithFewestOpenCases — load-balance: find agent with fewest open cases
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/49
 */

import type postgres from 'postgres';
import { sql as defaultSql } from './index';
import { listPaymentPlansForCase, type PaymentPlanSummary } from './payment-plans';
import { getLatestWriteOffApprovalForCase, type WriteOffApproval } from './write-off-approvals';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CollectionCaseStatus = 'open' | 'resolved' | 'escalated' | 'written_off';
export type ContactType = 'call' | 'email' | 'portal';

export interface CollectionCaseRow {
  id: string;
  invoice_id: string;
  agent_id: string | null;
  status: CollectionCaseStatus;
  escalation_level: number;
  resolution_type: string | null;
  opened_at: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  /** Joined from rl_invoices */
  invoice_amount: number;
  invoice_currency: string;
  invoice_due_date: string | null;
  invoice_status: string;
  /** Computed: days since invoice due_date */
  days_overdue: number;
  /** Joined from rl_customers */
  customer_name: string;
  customer_id: string;
}

export interface ContactLog {
  id: string;
  collection_case_id: string;
  agent_id: string;
  contact_type: ContactType;
  outcome: string;
  notes: string | null;
  contacted_at: string;
  created_at: string;
}

export interface CollectionCaseDetail {
  id: string;
  invoice_id: string;
  agent_id: string | null;
  status: CollectionCaseStatus;
  escalation_level: number;
  resolution_type: string | null;
  opened_at: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  /** Full invoice record */
  invoice: {
    id: string;
    customer_id: string;
    amount: number;
    currency: string;
    due_date: string | null;
    status: string;
    issued_at: string | null;
    created_at: string;
  };
  /** Customer info */
  customer: {
    id: string;
    company_name: string;
    segment: string | null;
  };
  /** Payments recorded against this invoice */
  payments: {
    id: string;
    amount: number;
    method: string | null;
    received_at: string | null;
  }[];
  /** Contact attempts logged by agents on this case */
  contact_logs: ContactLog[];
  /** Dunning actions for the linked invoice */
  dunning_actions: {
    id: string;
    action_type: string;
    scheduled_at: string | null;
    sent_at: string | null;
    response: string | null;
    created_at: string;
  }[];
  /** Payment plans configured on this collection case. */
  payment_plans: PaymentPlanSummary[];
  /** Most recent write-off approval or rejection linked to this case. */
  latest_write_off_approval: WriteOffApproval | null;
}

// ---------------------------------------------------------------------------
// listCollectionCases
// ---------------------------------------------------------------------------

/**
 * Returns collection cases assigned to the given agent, optionally filtered
 * by status. Cases are sorted by escalation_level DESC, then by days overdue DESC.
 */
export async function listCollectionCases(
  opts: {
    agent_id: string;
    status?: CollectionCaseStatus | Array<CollectionCaseStatus>;
  },
  sqlClient: postgres.Sql = defaultSql,
): Promise<CollectionCaseRow[]> {
  const { agent_id, status } = opts;

  // Build a normalized array of statuses. Default: open + escalated.
  const statuses: string[] =
    status === undefined ? ['open', 'escalated'] : Array.isArray(status) ? status : [status];

  const rows = await sqlClient<
    {
      id: string;
      invoice_id: string;
      agent_id: string | null;
      status: string;
      escalation_level: string;
      resolution_type: string | null;
      opened_at: string;
      resolved_at: string | null;
      created_at: string;
      updated_at: string;
      invoice_amount: string;
      invoice_currency: string;
      invoice_due_date: string | null;
      invoice_status: string;
      days_overdue: string;
      customer_name: string;
      customer_id: string;
    }[]
  >`
    SELECT
      cc.id,
      cc.invoice_id,
      cc.agent_id,
      cc.status,
      cc.escalation_level::text,
      cc.resolution_type,
      cc.opened_at::text AS opened_at,
      cc.resolved_at::text AS resolved_at,
      cc.created_at::text AS created_at,
      cc.updated_at::text AS updated_at,
      i.amount::text AS invoice_amount,
      i.currency AS invoice_currency,
      i.due_date::text AS invoice_due_date,
      i.status AS invoice_status,
      GREATEST(0, EXTRACT(DAY FROM (NOW() - i.due_date::timestamptz))::int)::text AS days_overdue,
      c.company_name AS customer_name,
      c.id AS customer_id
    FROM rl_collection_cases cc
    JOIN rl_invoices i ON i.id = cc.invoice_id
    JOIN rl_customers c ON c.id = i.customer_id
    WHERE cc.agent_id = ${agent_id}
      AND cc.status = ANY(${statuses}::text[])
    ORDER BY cc.escalation_level DESC, days_overdue DESC
  `;

  return rows.map((r) => ({
    id: r.id,
    invoice_id: r.invoice_id,
    agent_id: r.agent_id,
    status: r.status as CollectionCaseStatus,
    escalation_level: Number(r.escalation_level),
    resolution_type: r.resolution_type,
    opened_at: r.opened_at,
    resolved_at: r.resolved_at ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    invoice_amount: parseFloat(r.invoice_amount),
    invoice_currency: r.invoice_currency,
    invoice_due_date: r.invoice_due_date ?? null,
    invoice_status: r.invoice_status,
    days_overdue: Number(r.days_overdue),
    customer_name: r.customer_name,
    customer_id: r.customer_id,
  }));
}

// ---------------------------------------------------------------------------
// getCollectionCaseDetail
// ---------------------------------------------------------------------------

/**
 * Returns full case detail for the given collection case ID.
 * Includes invoice, customer, payments, contact logs, and dunning actions.
 *
 * Returns null if the case does not exist.
 */
export async function getCollectionCaseDetail(
  caseId: string,
  sqlClient: postgres.Sql = defaultSql,
): Promise<CollectionCaseDetail | null> {
  // Fetch the core case + invoice + customer in one query.
  const caseRows = await sqlClient<
    {
      id: string;
      invoice_id: string;
      agent_id: string | null;
      status: string;
      escalation_level: string;
      resolution_type: string | null;
      opened_at: string;
      resolved_at: string | null;
      created_at: string;
      updated_at: string;
      inv_id: string;
      inv_customer_id: string;
      inv_amount: string;
      inv_currency: string;
      inv_due_date: string | null;
      inv_status: string;
      inv_issued_at: string | null;
      inv_created_at: string;
      cust_id: string;
      cust_company_name: string;
      cust_segment: string | null;
    }[]
  >`
    SELECT
      cc.id,
      cc.invoice_id,
      cc.agent_id,
      cc.status,
      cc.escalation_level::text,
      cc.resolution_type,
      cc.opened_at::text AS opened_at,
      cc.resolved_at::text AS resolved_at,
      cc.created_at::text AS created_at,
      cc.updated_at::text AS updated_at,
      i.id AS inv_id,
      i.customer_id AS inv_customer_id,
      i.amount::text AS inv_amount,
      i.currency AS inv_currency,
      i.due_date::text AS inv_due_date,
      i.status AS inv_status,
      i.issued_at::text AS inv_issued_at,
      i.created_at::text AS inv_created_at,
      c.id AS cust_id,
      c.company_name AS cust_company_name,
      c.segment AS cust_segment
    FROM rl_collection_cases cc
    JOIN rl_invoices i ON i.id = cc.invoice_id
    JOIN rl_customers c ON c.id = i.customer_id
    WHERE cc.id = ${caseId}
    LIMIT 1
  `;

  if (caseRows.length === 0) return null;
  const cr = caseRows[0];

  // Fetch payments for this invoice.
  const paymentRows = await sqlClient<
    { id: string; amount: string; method: string | null; received_at: string | null }[]
  >`
    SELECT id, amount::text, method, received_at::text AS received_at
    FROM rl_payments
    WHERE invoice_id = ${cr.inv_id}
    ORDER BY received_at ASC NULLS LAST
  `;

  // Fetch contact logs for this case.
  const contactRows = await sqlClient<
    {
      id: string;
      collection_case_id: string;
      agent_id: string;
      contact_type: string;
      outcome: string;
      notes: string | null;
      contacted_at: string;
      created_at: string;
    }[]
  >`
    SELECT
      id,
      collection_case_id,
      agent_id,
      contact_type,
      outcome,
      notes,
      contacted_at::text AS contacted_at,
      created_at::text AS created_at
    FROM rl_contact_logs
    WHERE collection_case_id = ${caseId}
    ORDER BY contacted_at ASC
  `;

  // Fetch dunning actions for the linked invoice.
  const dunningRows = await sqlClient<
    {
      id: string;
      action_type: string;
      scheduled_at: string | null;
      sent_at: string | null;
      response: string | null;
      created_at: string;
    }[]
  >`
    SELECT
      id,
      action_type,
      scheduled_at::text AS scheduled_at,
      sent_at::text AS sent_at,
      response,
      created_at::text
    FROM rl_dunning_actions
    WHERE invoice_id = ${cr.inv_id}
    ORDER BY created_at ASC
  `;

  const paymentPlans = await listPaymentPlansForCase(caseId, sqlClient);
  const latestWriteOffApproval = await getLatestWriteOffApprovalForCase(sqlClient, caseId);

  return {
    id: cr.id,
    invoice_id: cr.invoice_id,
    agent_id: cr.agent_id,
    status: cr.status as CollectionCaseStatus,
    escalation_level: Number(cr.escalation_level),
    resolution_type: cr.resolution_type,
    opened_at: cr.opened_at,
    resolved_at: cr.resolved_at ?? null,
    created_at: cr.created_at,
    updated_at: cr.updated_at,
    invoice: {
      id: cr.inv_id,
      customer_id: cr.inv_customer_id,
      amount: parseFloat(cr.inv_amount),
      currency: cr.inv_currency,
      due_date: cr.inv_due_date ?? null,
      status: cr.inv_status,
      issued_at: cr.inv_issued_at ?? null,
      created_at: cr.inv_created_at,
    },
    customer: {
      id: cr.cust_id,
      company_name: cr.cust_company_name,
      segment: cr.cust_segment ?? null,
    },
    payments: paymentRows.map((p) => ({
      id: p.id,
      amount: parseFloat(p.amount),
      method: p.method ?? null,
      received_at: p.received_at ?? null,
    })),
    contact_logs: contactRows.map((r) => ({
      id: r.id,
      collection_case_id: r.collection_case_id,
      agent_id: r.agent_id,
      contact_type: r.contact_type as ContactType,
      outcome: r.outcome,
      notes: r.notes ?? null,
      contacted_at: r.contacted_at,
      created_at: r.created_at,
    })),
    dunning_actions: dunningRows.map((r) => ({
      id: r.id,
      action_type: r.action_type,
      scheduled_at: r.scheduled_at ?? null,
      sent_at: r.sent_at ?? null,
      response: r.response ?? null,
      created_at: r.created_at,
    })),
    payment_plans: paymentPlans,
    latest_write_off_approval: latestWriteOffApproval,
  };
}

// ---------------------------------------------------------------------------
// createContactLog
// ---------------------------------------------------------------------------

/**
 * Inserts a contact log record for a collection case.
 * The server assigns the timestamp (contacted_at = NOW()) unless explicitly provided.
 *
 * Returns the created ContactLog.
 */
export async function createContactLog(
  opts: {
    collection_case_id: string;
    agent_id: string;
    contact_type: ContactType;
    outcome: string;
    notes?: string | null;
    contacted_at?: string;
  },
  sqlClient: postgres.Sql = defaultSql,
): Promise<ContactLog> {
  const { collection_case_id, agent_id, contact_type, outcome, notes = null, contacted_at } = opts;

  const [row] = await sqlClient<
    {
      id: string;
      collection_case_id: string;
      agent_id: string;
      contact_type: string;
      outcome: string;
      notes: string | null;
      contacted_at: string;
      created_at: string;
    }[]
  >`
    INSERT INTO rl_contact_logs
      (collection_case_id, agent_id, contact_type, outcome, notes, contacted_at)
    VALUES (
      ${collection_case_id},
      ${agent_id},
      ${contact_type},
      ${outcome},
      ${notes},
      COALESCE(${contacted_at ? contacted_at : null}::timestamptz, NOW())
    )
    RETURNING
      id,
      collection_case_id,
      agent_id,
      contact_type,
      outcome,
      notes,
      contacted_at::text AS contacted_at,
      created_at::text AS created_at
  `;

  return {
    id: row.id,
    collection_case_id: row.collection_case_id,
    agent_id: row.agent_id,
    contact_type: row.contact_type as ContactType,
    outcome: row.outcome,
    notes: row.notes ?? null,
    contacted_at: row.contacted_at,
    created_at: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// assignAgentToCase
// ---------------------------------------------------------------------------

/**
 * Assigns an agent to a collection case by setting agent_id.
 * Used by the auto-assignment logic.
 */
export async function assignAgentToCase(
  caseId: string,
  agentId: string,
  sqlClient: postgres.Sql = defaultSql,
): Promise<void> {
  await sqlClient`
    UPDATE rl_collection_cases
    SET agent_id = ${agentId}, updated_at = NOW()
    WHERE id = ${caseId}
  `;
}

// ---------------------------------------------------------------------------
// getAgentWithFewestOpenCases
// ---------------------------------------------------------------------------

/**
 * Given a list of agent user IDs, returns the ID of the agent currently
 * assigned the fewest open (status='open' or 'escalated') collection cases.
 *
 * If all agents have the same count, returns the first in the list.
 * Returns null if the agentIds list is empty.
 */
export async function getAgentWithFewestOpenCases(
  agentIds: string[],
  sqlClient: postgres.Sql = defaultSql,
): Promise<string | null> {
  if (agentIds.length === 0) return null;

  const rows = await sqlClient<{ agent_id: string; open_count: string }[]>`
    SELECT
      a.agent_id,
      COUNT(cc.id)::text AS open_count
    FROM (
      SELECT unnest(${agentIds}::text[]) AS agent_id
    ) a
    LEFT JOIN rl_collection_cases cc
      ON cc.agent_id = a.agent_id
      AND cc.status IN ('open', 'escalated')
    GROUP BY a.agent_id
    ORDER BY open_count ASC, a.agent_id ASC
    LIMIT 1
  `;

  return rows[0]?.agent_id ?? agentIds[0];
}
