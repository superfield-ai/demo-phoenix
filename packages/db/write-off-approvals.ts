/**
 * @file write-off-approvals
 *
 * Settlement proposal and Finance Controller approval workflow for write-offs.
 *
 * Collections Agents propose a settlement amount on an open CollectionCase.
 * When the implied write-off exceeds the configured threshold, the proposal
 * is stored as `pending_approval` for Finance Controller review. Otherwise
 * the settlement is applied immediately without creating an approval record.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/51
 */

import type postgres from 'postgres';
import { sql as defaultSql } from './index';

type SqlClient = postgres.Sql;

export type WriteOffApprovalStatus = 'pending_approval' | 'approved' | 'rejected';
export type WriteOffApprovalDecision = 'approved' | 'rejected';

export interface WriteOffApproval {
  id: string;
  collection_case_id: string;
  invoice_id: string;
  customer_id: string;
  customer_name: string;
  invoice_amount: number;
  proposed_by: string;
  reviewed_by: string | null;
  settlement_amount: number;
  implied_write_off_amount: number;
  status: WriteOffApprovalStatus;
  notes: string | null;
  review_notes: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SettlementApplication {
  case_id: string;
  invoice_id: string;
  invoice_status: 'settled' | 'written_off';
  case_status: 'resolved' | 'written_off';
  resolution_type: 'settlement';
}

export interface SettlementProposalOutcome {
  approval: WriteOffApproval | null;
  auto_approved: boolean;
  settlement: SettlementApplication | null;
}

export interface WriteOffApprovalAuditWriterFn {
  (event: {
    actor_id: string;
    action: string;
    entity_type: string;
    entity_id: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    ts: string;
  }): Promise<void>;
}

export function getWriteOffApprovalThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WRITE_OFF_APPROVAL_THRESHOLD?.trim();
  if (!raw) return Number.POSITIVE_INFINITY;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : Number.POSITIVE_INFINITY;
}

function mapApprovalRow(row: {
  id: string;
  collection_case_id: string;
  invoice_id: string;
  customer_id: string;
  customer_name: string;
  invoice_amount: string;
  proposed_by: string;
  reviewed_by: string | null;
  settlement_amount: string;
  implied_write_off_amount: string;
  status: string;
  notes: string | null;
  review_notes: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}): WriteOffApproval {
  return {
    id: row.id,
    collection_case_id: row.collection_case_id,
    invoice_id: row.invoice_id,
    customer_id: row.customer_id,
    customer_name: row.customer_name,
    invoice_amount: Number(row.invoice_amount),
    proposed_by: row.proposed_by,
    reviewed_by: row.reviewed_by,
    settlement_amount: Number(row.settlement_amount),
    implied_write_off_amount: Number(row.implied_write_off_amount),
    status: row.status as WriteOffApprovalStatus,
    notes: row.notes,
    review_notes: row.review_notes,
    reviewed_at: row.reviewed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function loadCaseAndInvoice(
  sqlClient: SqlClient,
  collectionCaseId: string,
): Promise<{
  case_id: string;
  case_status: string;
  resolution_type: string | null;
  agent_id: string | null;
  invoice_id: string;
  invoice_amount: string;
  invoice_status: string;
  customer_id: string;
  customer_name: string;
} | null> {
  const rows = await sqlClient<
    {
      case_id: string;
      case_status: string;
      resolution_type: string | null;
      agent_id: string | null;
      invoice_id: string;
      invoice_amount: string;
      invoice_status: string;
      customer_id: string;
      customer_name: string;
    }[]
  >`
    SELECT
      cc.id AS case_id,
      cc.status AS case_status,
      cc.resolution_type,
      cc.agent_id,
      i.id AS invoice_id,
      i.amount::text AS invoice_amount,
      i.status AS invoice_status,
      c.id AS customer_id,
      c.company_name AS customer_name
    FROM rl_collection_cases cc
    JOIN rl_invoices i ON i.id = cc.invoice_id
    JOIN rl_customers c ON c.id = i.customer_id
    WHERE cc.id = ${collectionCaseId}
    FOR UPDATE OF cc, i
    LIMIT 1
  `;

  return rows[0] ?? null;
}

async function applySettlement(
  tx: SqlClient,
  input: {
    collection_case_id: string;
    invoice_id: string;
    invoice_amount: number;
    settlement_amount: number;
    review_status: 'auto_approved' | 'approved';
    actor_id: string;
    auditWriter?: WriteOffApprovalAuditWriterFn;
  },
): Promise<SettlementApplication> {
  const remaining = Math.max(0, input.invoice_amount - input.settlement_amount);
  const invoiceStatus = remaining > 0 ? 'written_off' : 'settled';
  const caseStatus = remaining > 0 ? 'written_off' : 'resolved';

  await tx`
    UPDATE rl_invoices
    SET status = ${invoiceStatus},
        updated_at = NOW()
    WHERE id = ${input.invoice_id}
  `;

  await tx`
    UPDATE rl_collection_cases
    SET status = ${caseStatus},
        resolution_type = 'settlement',
        resolved_at = NOW(),
        updated_at = NOW()
    WHERE id = ${input.collection_case_id}
  `;

  if (input.auditWriter) {
    await input
      .auditWriter({
        actor_id: input.actor_id,
        action: `write_off_approval.${input.review_status}`,
        entity_type: 'collection_case',
        entity_id: input.collection_case_id,
        before: { invoice_status: 'in_collection', case_status: 'open' },
        after: {
          invoice_status: invoiceStatus,
          case_status: caseStatus,
          resolution_type: 'settlement',
          settlement_amount: input.settlement_amount,
        },
        ts: new Date().toISOString(),
      })
      .catch((err) =>
        console.warn('[write-off-approvals] audit write failed for settlement application:', err),
      );
  }

  return {
    case_id: input.collection_case_id,
    invoice_id: input.invoice_id,
    invoice_status: invoiceStatus,
    case_status: caseStatus,
    resolution_type: 'settlement',
  };
}

export async function proposeSettlement(
  sqlClient: SqlClient,
  input: {
    collection_case_id: string;
    settlement_amount: number;
    notes?: string | null;
    proposed_by: string;
    actor_id: string;
    auditWriter?: WriteOffApprovalAuditWriterFn;
  },
): Promise<SettlementProposalOutcome> {
  if (!Number.isFinite(input.settlement_amount) || input.settlement_amount <= 0) {
    throw new Error('settlement_amount must be a positive number');
  }

  const threshold = getWriteOffApprovalThreshold();

  return sqlClient.begin(async (tx) => {
    const txSql = tx as unknown as SqlClient;
    const row = await loadCaseAndInvoice(txSql, input.collection_case_id);
    if (!row) {
      throw new Error(`Collection case not found: ${input.collection_case_id}`);
    }

    if (row.case_status !== 'open') {
      throw new Error(`Collection case ${input.collection_case_id} is not open`);
    }

    const invoiceAmount = Number(row.invoice_amount);
    if (input.settlement_amount > invoiceAmount) {
      throw new Error('settlement_amount cannot exceed the invoice amount');
    }

    const impliedWriteOffAmount = Math.max(0, invoiceAmount - input.settlement_amount);
    const requiresApproval = impliedWriteOffAmount > threshold;

    if (requiresApproval) {
      const [approval] = await txSql<
        {
          id: string;
          collection_case_id: string;
          invoice_id: string;
          customer_id: string;
          customer_name: string;
          invoice_amount: string;
          proposed_by: string;
          reviewed_by: string | null;
          settlement_amount: string;
          implied_write_off_amount: string;
          status: string;
          notes: string | null;
          review_notes: string | null;
          reviewed_at: string | null;
          created_at: string;
          updated_at: string;
        }[]
      >`
        INSERT INTO rl_write_off_approvals (
          collection_case_id,
          invoice_id,
          customer_id,
          proposed_by,
          settlement_amount,
          implied_write_off_amount,
          status,
          notes
        )
        VALUES (
          ${input.collection_case_id},
          ${row.invoice_id},
          ${row.customer_id},
          ${input.proposed_by},
          ${input.settlement_amount},
          ${impliedWriteOffAmount},
          'pending_approval',
          ${input.notes ?? null}
        )
        RETURNING
          id,
          collection_case_id,
          invoice_id,
          customer_id,
          (SELECT company_name FROM rl_customers WHERE id = customer_id LIMIT 1) AS customer_name,
          (SELECT amount::text FROM rl_invoices WHERE id = invoice_id LIMIT 1) AS invoice_amount,
          proposed_by,
          reviewed_by,
          settlement_amount::text AS settlement_amount,
          implied_write_off_amount::text AS implied_write_off_amount,
          status,
          notes,
          review_notes,
          reviewed_at::text AS reviewed_at,
          created_at::text AS created_at,
          updated_at::text AS updated_at
      `;

      if (input.auditWriter) {
        await input
          .auditWriter({
            actor_id: input.actor_id,
            action: 'write_off_approval.requested',
            entity_type: 'write_off_approval',
            entity_id: approval.id,
            before: null,
            after: {
              collection_case_id: approval.collection_case_id,
              invoice_id: approval.invoice_id,
              customer_id: approval.customer_id,
              settlement_amount: approval.settlement_amount,
              implied_write_off_amount: approval.implied_write_off_amount,
              status: approval.status,
            },
            ts: new Date().toISOString(),
          })
          .catch((err) =>
            console.warn('[write-off-approvals] audit write failed for requested approval:', err),
          );
      }

      return {
        approval: mapApprovalRow(approval),
        auto_approved: false,
        settlement: null,
      };
    }

    const settlement = await applySettlement(txSql, {
      collection_case_id: input.collection_case_id,
      invoice_id: row.invoice_id,
      invoice_amount: invoiceAmount,
      settlement_amount: input.settlement_amount,
      review_status: 'auto_approved',
      actor_id: input.actor_id,
      auditWriter: input.auditWriter,
    });

    return {
      approval: null,
      auto_approved: true,
      settlement,
    };
  });
}

export async function listWriteOffApprovals(
  sqlClient: SqlClient = defaultSql,
  options: { status?: WriteOffApprovalStatus; limit?: number; offset?: number } = {},
): Promise<WriteOffApproval[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);

  const rows = options.status
    ? await sqlClient<
        {
          id: string;
          collection_case_id: string;
          invoice_id: string;
          customer_id: string;
          customer_name: string;
          invoice_amount: string;
          proposed_by: string;
          reviewed_by: string | null;
          settlement_amount: string;
          implied_write_off_amount: string;
          status: string;
          notes: string | null;
          review_notes: string | null;
          reviewed_at: string | null;
          created_at: string;
          updated_at: string;
        }[]
      >`
        SELECT
          w.id,
          w.collection_case_id,
          w.invoice_id,
          w.customer_id,
          c.company_name AS customer_name,
          i.amount::text AS invoice_amount,
          w.proposed_by,
          w.reviewed_by,
          w.settlement_amount::text AS settlement_amount,
          w.implied_write_off_amount::text AS implied_write_off_amount,
          w.status,
          w.notes,
          w.review_notes,
          w.reviewed_at::text AS reviewed_at,
          w.created_at::text AS created_at,
          w.updated_at::text AS updated_at
        FROM rl_write_off_approvals w
        JOIN rl_customers c ON c.id = w.customer_id
        JOIN rl_invoices i ON i.id = w.invoice_id
        WHERE w.status = ${options.status}
        ORDER BY w.created_at DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `
    : await sqlClient<
        {
          id: string;
          collection_case_id: string;
          invoice_id: string;
          customer_id: string;
          customer_name: string;
          invoice_amount: string;
          proposed_by: string;
          reviewed_by: string | null;
          settlement_amount: string;
          implied_write_off_amount: string;
          status: string;
          notes: string | null;
          review_notes: string | null;
          reviewed_at: string | null;
          created_at: string;
          updated_at: string;
        }[]
      >`
        SELECT
          w.id,
          w.collection_case_id,
          w.invoice_id,
          w.customer_id,
          c.company_name AS customer_name,
          i.amount::text AS invoice_amount,
          w.proposed_by,
          w.reviewed_by,
          w.settlement_amount::text AS settlement_amount,
          w.implied_write_off_amount::text AS implied_write_off_amount,
          w.status,
          w.notes,
          w.review_notes,
          w.reviewed_at::text AS reviewed_at,
          w.created_at::text AS created_at,
          w.updated_at::text AS updated_at
        FROM rl_write_off_approvals w
        JOIN rl_customers c ON c.id = w.customer_id
        JOIN rl_invoices i ON i.id = w.invoice_id
        ORDER BY w.created_at DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `;

  return rows.map(mapApprovalRow);
}

export async function getWriteOffApproval(
  sqlClient: SqlClient,
  approvalId: string,
): Promise<WriteOffApproval | null> {
  const rows = await sqlClient<
    {
      id: string;
      collection_case_id: string;
      invoice_id: string;
      customer_id: string;
      customer_name: string;
      invoice_amount: string;
      proposed_by: string;
      reviewed_by: string | null;
      settlement_amount: string;
      implied_write_off_amount: string;
      status: string;
      notes: string | null;
      review_notes: string | null;
      reviewed_at: string | null;
      created_at: string;
      updated_at: string;
    }[]
  >`
    SELECT
      w.id,
      w.collection_case_id,
      w.invoice_id,
      w.customer_id,
      c.company_name AS customer_name,
      i.amount::text AS invoice_amount,
      w.proposed_by,
      w.reviewed_by,
      w.settlement_amount::text AS settlement_amount,
      w.implied_write_off_amount::text AS implied_write_off_amount,
      w.status,
      w.notes,
      w.review_notes,
      w.reviewed_at::text AS reviewed_at,
      w.created_at::text AS created_at,
      w.updated_at::text AS updated_at
    FROM rl_write_off_approvals w
    JOIN rl_customers c ON c.id = w.customer_id
    JOIN rl_invoices i ON i.id = w.invoice_id
    WHERE w.id = ${approvalId}
    LIMIT 1
  `;

  return rows[0] ? mapApprovalRow(rows[0]) : null;
}

export async function getLatestWriteOffApprovalForCase(
  sqlClient: SqlClient,
  collectionCaseId: string,
): Promise<WriteOffApproval | null> {
  const rows = await sqlClient<
    {
      id: string;
      collection_case_id: string;
      invoice_id: string;
      customer_id: string;
      customer_name: string;
      invoice_amount: string;
      proposed_by: string;
      reviewed_by: string | null;
      settlement_amount: string;
      implied_write_off_amount: string;
      status: string;
      notes: string | null;
      review_notes: string | null;
      reviewed_at: string | null;
      created_at: string;
      updated_at: string;
    }[]
  >`
    SELECT
      w.id,
      w.collection_case_id,
      w.invoice_id,
      w.customer_id,
      c.company_name AS customer_name,
      i.amount::text AS invoice_amount,
      w.proposed_by,
      w.reviewed_by,
      w.settlement_amount::text AS settlement_amount,
      w.implied_write_off_amount::text AS implied_write_off_amount,
      w.status,
      w.notes,
      w.review_notes,
      w.reviewed_at::text AS reviewed_at,
      w.created_at::text AS created_at,
      w.updated_at::text AS updated_at
    FROM rl_write_off_approvals w
    JOIN rl_customers c ON c.id = w.customer_id
    JOIN rl_invoices i ON i.id = w.invoice_id
    WHERE w.collection_case_id = ${collectionCaseId}
    ORDER BY w.created_at DESC
    LIMIT 1
  `;

  return rows[0] ? mapApprovalRow(rows[0]) : null;
}

export async function decideWriteOffApproval(
  sqlClient: SqlClient,
  input: {
    approval_id: string;
    decision: WriteOffApprovalDecision;
    reviewed_by: string;
    review_notes?: string | null;
    actor_id: string;
    auditWriter?: WriteOffApprovalAuditWriterFn;
  },
): Promise<{
  approval: WriteOffApproval;
  settlement: SettlementApplication | null;
}> {
  return sqlClient.begin(async (tx) => {
    const txSql = tx as unknown as SqlClient;
    const approvalRows = await txSql<
      {
        id: string;
        collection_case_id: string;
        invoice_id: string;
        customer_id: string;
        customer_name: string;
        invoice_amount: string;
        proposed_by: string;
        reviewed_by: string | null;
        settlement_amount: string;
        implied_write_off_amount: string;
        status: string;
        notes: string | null;
        review_notes: string | null;
        reviewed_at: string | null;
        created_at: string;
        updated_at: string;
      }[]
    >`
      SELECT
        w.id,
      w.collection_case_id,
      w.invoice_id,
      w.customer_id,
      c.company_name AS customer_name,
      i.amount::text AS invoice_amount,
      w.proposed_by,
      w.reviewed_by,
        w.settlement_amount::text AS settlement_amount,
        w.implied_write_off_amount::text AS implied_write_off_amount,
        w.status,
        w.notes,
        w.review_notes,
        w.reviewed_at::text AS reviewed_at,
        w.created_at::text AS created_at,
        w.updated_at::text AS updated_at
      FROM rl_write_off_approvals w
      JOIN rl_customers c ON c.id = w.customer_id
      JOIN rl_invoices i ON i.id = w.invoice_id
      WHERE w.id = ${input.approval_id}
      FOR UPDATE
      LIMIT 1
    `;

    const current = approvalRows[0];
    if (!current) {
      throw new Error(`Write-off approval not found: ${input.approval_id}`);
    }
    if (current.status !== 'pending_approval') {
      throw new Error(`Write-off approval ${input.approval_id} is not pending`);
    }

    let settlement: SettlementApplication | null = null;
    if (input.decision === 'approved') {
      const caseRow = await loadCaseAndInvoice(txSql, current.collection_case_id);
      if (!caseRow) {
        throw new Error(`Collection case not found: ${current.collection_case_id}`);
      }
      if (caseRow.case_status !== 'open') {
        throw new Error(`Collection case ${current.collection_case_id} is not open`);
      }

      settlement = await applySettlement(txSql, {
        collection_case_id: current.collection_case_id,
        invoice_id: current.invoice_id,
        invoice_amount: Number(caseRow.invoice_amount),
        settlement_amount: Number(current.settlement_amount),
        review_status: 'approved',
        actor_id: input.actor_id,
        auditWriter: input.auditWriter,
      });
    } else if (input.auditWriter) {
      await input
        .auditWriter({
          actor_id: input.actor_id,
          action: 'write_off_approval.rejected',
          entity_type: 'write_off_approval',
          entity_id: input.approval_id,
          before: { status: current.status },
          after: { status: 'rejected', review_notes: input.review_notes ?? null },
          ts: new Date().toISOString(),
        })
        .catch((err) =>
          console.warn('[write-off-approvals] audit write failed for rejection:', err),
        );
    }

    const [updated] = await txSql<
      {
        id: string;
        collection_case_id: string;
        invoice_id: string;
        customer_id: string;
        customer_name: string;
        invoice_amount: string;
        proposed_by: string;
        reviewed_by: string | null;
        settlement_amount: string;
        implied_write_off_amount: string;
        status: string;
        notes: string | null;
        review_notes: string | null;
        reviewed_at: string | null;
        created_at: string;
        updated_at: string;
      }[]
    >`
      UPDATE rl_write_off_approvals
      SET
        status = ${input.decision},
        reviewed_by = ${input.reviewed_by},
        review_notes = ${input.review_notes ?? null},
        reviewed_at = NOW(),
        updated_at = NOW()
      WHERE id = ${input.approval_id}
      RETURNING
        id,
        collection_case_id,
        invoice_id,
        customer_id,
        (SELECT company_name FROM rl_customers WHERE id = customer_id LIMIT 1) AS customer_name,
        (SELECT amount::text FROM rl_invoices WHERE id = invoice_id LIMIT 1) AS invoice_amount,
        proposed_by,
        reviewed_by,
        settlement_amount::text AS settlement_amount,
        implied_write_off_amount::text AS implied_write_off_amount,
        status,
        notes,
        review_notes,
        reviewed_at::text AS reviewed_at,
        created_at::text AS created_at,
        updated_at::text AS updated_at
    `;

    return {
      approval: mapApprovalRow(updated),
      settlement,
    };
  });
}
