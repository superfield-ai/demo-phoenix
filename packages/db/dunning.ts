/**
 * @file dunning.ts
 *
 * Database query functions for the automated dunning engine (issue #48).
 *
 * Exports:
 *   listOverdueInvoicesForDunning  — invoices eligible for dunning (no active payment plan)
 *   listDunningActions             — dunning actions for a given invoice
 *   createDunningAction            — insert a new DunningAction (idempotent via skip-if-exists)
 *   createCollectionCase           — open a CollectionCase for an invoice (idempotent)
 *   transitionInvoiceToCollection  — atomically move invoice to in_collection + open case
 *
 * The rl_dunning_actions and rl_collection_cases tables already exist in the schema.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/48
 */

import type postgres from 'postgres';
import { sql as defaultSql } from './index';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DunningActionType =
  | 'reminder_d1'
  | 'second_notice_d7'
  | 'firm_notice_d14'
  | 'collection_d30';

export interface DunningAction {
  id: string;
  invoice_id: string;
  action_type: DunningActionType;
  scheduled_at: string | null;
  sent_at: string | null;
  response: string | null;
  created_at: string;
}

export interface CollectionCase {
  id: string;
  invoice_id: string;
  agent_id: string | null;
  status: 'open' | 'resolved' | 'escalated' | 'written_off';
  escalation_level: number;
  resolution_type: string | null;
  opened_at: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Row returned from the overdue-invoices query. */
export interface OverdueInvoiceRow {
  id: string;
  customer_id: string;
  amount: number;
  due_date: string;
  status: string;
  /** Days since the invoice due_date. */
  days_overdue: number;
  /** True when there is an active (status=current) payment plan linked to any
   * open collection case for this invoice. */
  has_active_payment_plan: boolean;
}

// ---------------------------------------------------------------------------
// listOverdueInvoicesForDunning
// ---------------------------------------------------------------------------

/**
 * Returns invoices that are overdue (or in_collection) and potentially need a
 * new dunning action.
 *
 * A payment plan with status=current on the linked open collection case acts
 * as a "pause" signal — those invoices are returned with
 * has_active_payment_plan=true so the caller can skip them.
 *
 * Invoices with status 'paid', 'settled', or 'written_off' are excluded.
 */
export async function listOverdueInvoicesForDunning(
  sqlClient: postgres.Sql = defaultSql,
): Promise<OverdueInvoiceRow[]> {
  const rows = await sqlClient<
    {
      id: string;
      customer_id: string;
      amount: string;
      due_date: string;
      status: string;
      days_overdue: string;
      has_active_payment_plan: boolean;
    }[]
  >`
    SELECT
      i.id,
      i.customer_id,
      i.amount::text,
      i.due_date::text,
      i.status,
      GREATEST(0, EXTRACT(DAY FROM (NOW() - i.due_date::timestamptz))::int) AS days_overdue,
      EXISTS (
        SELECT 1
        FROM rl_collection_cases cc
        JOIN rl_payment_plans pp ON pp.collection_case_id = cc.id
        WHERE cc.invoice_id = i.id
          AND cc.status = 'open'
          AND pp.status = 'current'
      ) AS has_active_payment_plan
    FROM rl_invoices i
    WHERE i.due_date IS NOT NULL
      AND i.due_date::date < CURRENT_DATE
      AND i.status NOT IN ('paid', 'settled', 'written_off', 'draft')
    ORDER BY i.due_date ASC
  `;

  return rows.map((r) => ({
    id: r.id,
    customer_id: r.customer_id,
    amount: parseFloat(r.amount),
    due_date: r.due_date,
    status: r.status,
    days_overdue: Number(r.days_overdue),
    has_active_payment_plan: r.has_active_payment_plan,
  }));
}

// ---------------------------------------------------------------------------
// listDunningActions
// ---------------------------------------------------------------------------

/**
 * Returns all dunning actions for a given invoice, ordered chronologically.
 */
export async function listDunningActions(
  invoiceId: string,
  sqlClient: postgres.Sql = defaultSql,
): Promise<DunningAction[]> {
  const rows = await sqlClient<
    {
      id: string;
      invoice_id: string;
      action_type: string;
      scheduled_at: string | null;
      sent_at: string | null;
      response: string | null;
      created_at: string;
    }[]
  >`
    SELECT
      id,
      invoice_id,
      action_type,
      scheduled_at::text AS scheduled_at,
      sent_at::text AS sent_at,
      response,
      created_at::text
    FROM rl_dunning_actions
    WHERE invoice_id = ${invoiceId}
    ORDER BY created_at ASC
  `;

  return rows.map((r) => ({
    id: r.id,
    invoice_id: r.invoice_id,
    action_type: r.action_type as DunningActionType,
    scheduled_at: r.scheduled_at ?? null,
    sent_at: r.sent_at ?? null,
    response: r.response ?? null,
    created_at: r.created_at,
  }));
}

// ---------------------------------------------------------------------------
// hasDunningAction
// ---------------------------------------------------------------------------

/**
 * Returns true if a DunningAction of the given type already exists for the
 * invoice. Used by the idempotency guard in the dunning engine.
 */
export async function hasDunningAction(
  invoiceId: string,
  actionType: DunningActionType,
  sqlClient: postgres.Sql = defaultSql,
): Promise<boolean> {
  const rows = await sqlClient<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM rl_dunning_actions
      WHERE invoice_id = ${invoiceId}
        AND action_type = ${actionType}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

// ---------------------------------------------------------------------------
// createDunningAction
// ---------------------------------------------------------------------------

/**
 * Inserts a DunningAction record and marks it as sent (sent_at = NOW()).
 *
 * The caller must first verify idempotency via `hasDunningAction`.
 *
 * Returns the created DunningAction.
 */
export async function createDunningAction(
  opts: {
    invoice_id: string;
    action_type: DunningActionType;
    scheduled_at?: string;
    response?: string;
  },
  sqlClient: postgres.Sql = defaultSql,
): Promise<DunningAction> {
  const { invoice_id, action_type, scheduled_at = null, response = null } = opts;

  const [row] = await sqlClient<
    {
      id: string;
      invoice_id: string;
      action_type: string;
      scheduled_at: string | null;
      sent_at: string | null;
      response: string | null;
      created_at: string;
    }[]
  >`
    INSERT INTO rl_dunning_actions
      (invoice_id, action_type, scheduled_at, sent_at, response)
    VALUES (
      ${invoice_id},
      ${action_type},
      ${scheduled_at ? scheduled_at : null}::timestamptz,
      NOW(),
      ${response}
    )
    RETURNING
      id,
      invoice_id,
      action_type,
      scheduled_at::text AS scheduled_at,
      sent_at::text AS sent_at,
      response,
      created_at::text
  `;

  return {
    id: row.id,
    invoice_id: row.invoice_id,
    action_type: row.action_type as DunningActionType,
    scheduled_at: row.scheduled_at ?? null,
    sent_at: row.sent_at ?? null,
    response: row.response ?? null,
    created_at: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// transitionInvoiceToCollection
// ---------------------------------------------------------------------------

/**
 * Atomically transitions an invoice to 'in_collection' status and opens a
 * new CollectionCase. Both operations occur inside a single transaction.
 *
 * Idempotent: if the invoice is already 'in_collection', only the collection
 * case creation is attempted. The unique partial index
 * (rl_collection_cases_one_open_per_invoice) prevents duplicate open cases.
 *
 * Returns the newly created or already-existing open CollectionCase.
 */
export async function transitionInvoiceToCollection(
  invoiceId: string,
  sqlClient: postgres.Sql = defaultSql,
): Promise<CollectionCase> {
  let result: CollectionCase | null = null;

  await sqlClient.begin(async (tx) => {
    const txSql = tx as unknown as postgres.Sql;

    // Fetch current invoice status.
    const [invRow] = await txSql<{ status: string }[]>`
      SELECT status FROM rl_invoices WHERE id = ${invoiceId} FOR UPDATE
    `;

    if (!invRow) {
      throw new Error(`Invoice ${invoiceId} not found`);
    }

    // Transition to in_collection if not already there.
    if (invRow.status !== 'in_collection') {
      await txSql`
        UPDATE rl_invoices
        SET status = 'in_collection', updated_at = NOW()
        WHERE id = ${invoiceId}
      `;
    }

    // Open a collection case (idempotent via unique partial index).
    const existing = await txSql<
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
      }[]
    >`
      SELECT
        id, invoice_id, agent_id, status, escalation_level::text,
        resolution_type, opened_at::text, resolved_at::text,
        created_at::text, updated_at::text
      FROM rl_collection_cases
      WHERE invoice_id = ${invoiceId} AND status = 'open'
      LIMIT 1
    `;

    if (existing.length > 0) {
      const r = existing[0];
      result = {
        id: r.id,
        invoice_id: r.invoice_id,
        agent_id: r.agent_id,
        status: r.status as CollectionCase['status'],
        escalation_level: Number(r.escalation_level),
        resolution_type: r.resolution_type,
        opened_at: r.opened_at,
        resolved_at: r.resolved_at ?? null,
        created_at: r.created_at,
        updated_at: r.updated_at,
      };
      return;
    }

    const [caseRow] = await txSql<
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
      }[]
    >`
      INSERT INTO rl_collection_cases (invoice_id)
      VALUES (${invoiceId})
      RETURNING
        id, invoice_id, agent_id, status, escalation_level::text,
        resolution_type, opened_at::text, resolved_at::text,
        created_at::text, updated_at::text
    `;

    result = {
      id: caseRow.id,
      invoice_id: caseRow.invoice_id,
      agent_id: caseRow.agent_id,
      status: caseRow.status as CollectionCase['status'],
      escalation_level: Number(caseRow.escalation_level),
      resolution_type: caseRow.resolution_type,
      opened_at: caseRow.opened_at,
      resolved_at: caseRow.resolved_at ?? null,
      created_at: caseRow.created_at,
      updated_at: caseRow.updated_at,
    };
  });

  if (!result) {
    throw new Error(`transitionInvoiceToCollection: transaction completed but result is null`);
  }
  return result;
}
