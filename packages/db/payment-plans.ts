/**
 * @file payment-plans
 *
 * Database helpers for payment-plan configuration and lifecycle tracking
 * (issue #50).
 *
 * This module owns the shared payment-plan logic used by:
 * - POST /api/collection-cases/:id/payment-plans
 * - GET /api/payment-plans/:id
 * - PATCH /api/payment-plans/:id/status
 * - the daily reconciliation worker that breaches overdue plans and completes
 *   plans once all installments are covered by recorded payments.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/50
 */

import type postgres from 'postgres';
import { sql as defaultSql } from './index';

type TxSql = postgres.TransactionSql;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PaymentPlanStatus = 'current' | 'breached' | 'completed' | 'cancelled';
export type PaymentPlanInstallmentStatus = 'paid' | 'unpaid';

export interface PaymentPlanSummary {
  id: string;
  collection_case_id: string;
  total_amount: number;
  installment_count: number;
  installment_amount: number;
  next_due_date: string | null;
  status: PaymentPlanStatus;
  created_at: string;
  updated_at: string;
}

export interface PaymentPlanInstallment {
  installment_number: number;
  due_date: string;
  amount: number;
  status: PaymentPlanInstallmentStatus;
  paid_amount: number;
}

export interface PaymentPlanDetail extends PaymentPlanSummary {
  collection_case: {
    id: string;
    invoice_id: string;
    agent_id: string | null;
    status: string;
    resolution_type: string | null;
  };
  invoice: {
    id: string;
    customer_id: string;
    amount: number;
    currency: string;
    due_date: string | null;
    status: string;
    issued_at: string | null;
    created_at: string;
    updated_at: string;
  };
  customer: {
    id: string;
    company_name: string;
    segment: string | null;
  };
  installments: PaymentPlanInstallment[];
  payment_total: number;
  paid_installment_count: number;
}

export interface CreatePaymentPlanOptions {
  collection_case_id: string;
  total_amount: number;
  installment_count: number;
  first_due_date: string;
}

export interface PaymentPlanLifecycleResult {
  completed: string[];
  breached: string[];
}

interface PaymentRow {
  amount: string;
  received_at: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseDateOnly(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00Z`);
}

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const date = parseDateOnly(dateStr);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDateOnly(date);
}

function parseMoney(value: string): number {
  return parseFloat(value);
}

/**
 * Builds the installment schedule for a payment plan.
 *
 * The schema only stores the aggregate plan, so installment-level status is
 * derived by allocating recorded payments from oldest to newest installment.
 */
export function buildPaymentPlanInstallments(opts: {
  total_amount: number;
  installment_count: number;
  installment_amount: number;
  first_due_date: string;
  payment_total: number;
}): PaymentPlanInstallment[] {
  const { total_amount, installment_count, installment_amount, first_due_date, payment_total } =
    opts;

  const installments: PaymentPlanInstallment[] = [];
  let remainingPaid = roundCurrency(payment_total);

  for (let i = 0; i < installment_count; i += 1) {
    const dueAmount =
      i === installment_count - 1
        ? roundCurrency(total_amount - installment_amount * (installment_count - 1))
        : roundCurrency(installment_amount);
    const paid_amount = Math.min(dueAmount, Math.max(0, remainingPaid));
    const status: PaymentPlanInstallmentStatus = paid_amount >= dueAmount ? 'paid' : 'unpaid';
    installments.push({
      installment_number: i + 1,
      due_date: addDays(first_due_date, i * 30),
      amount: dueAmount,
      status,
      paid_amount: roundCurrency(paid_amount),
    });
    remainingPaid = roundCurrency(remainingPaid - paid_amount);
  }

  return installments;
}

function summarizePaymentPlanRow(row: {
  id: string;
  collection_case_id: string;
  total_amount: string;
  installment_count: string;
  installment_amount: string;
  next_due_date: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}): PaymentPlanSummary {
  return {
    id: row.id,
    collection_case_id: row.collection_case_id,
    total_amount: parseMoney(row.total_amount),
    installment_count: Number(row.installment_count),
    installment_amount: parseMoney(row.installment_amount),
    next_due_date: row.next_due_date,
    status: row.status as PaymentPlanStatus,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function derivePlanState(
  detail: PaymentPlanSummary & { payment_total: number; installments: PaymentPlanInstallment[] },
) {
  const totalPaid = roundCurrency(detail.payment_total);
  const paidInstallmentCount = detail.installments.filter((i) => i.status === 'paid').length;
  const fullyPaid =
    totalPaid >= roundCurrency(detail.total_amount) ||
    paidInstallmentCount >= detail.installment_count;
  const firstUnpaid = detail.installments.find((i) => i.status === 'unpaid') ?? null;
  const today = formatDateOnly(new Date());
  const breached = Boolean(firstUnpaid && firstUnpaid.due_date < today && !fullyPaid);
  const next_due_date = fullyPaid ? null : (firstUnpaid?.due_date ?? null);

  return {
    paidInstallmentCount,
    fullyPaid,
    breached,
    next_due_date,
  };
}

async function fetchPlanDetailRows(planId: string, sqlClient: postgres.Sql) {
  return sqlClient<
    {
      id: string;
      collection_case_id: string;
      total_amount: string;
      installment_count: string;
      installment_amount: string;
      next_due_date: string | null;
      status: string;
      created_at: string;
      updated_at: string;
      case_id: string;
      case_invoice_id: string;
      case_agent_id: string | null;
      case_status: string;
      case_resolution_type: string | null;
      invoice_id: string;
      invoice_customer_id: string;
      invoice_amount: string;
      invoice_currency: string;
      invoice_due_date: string | null;
      invoice_status: string;
      invoice_issued_at: string | null;
      invoice_created_at: string;
      invoice_updated_at: string;
      customer_id: string;
      customer_company_name: string;
      customer_segment: string | null;
    }[]
  >`
    SELECT
      pp.id,
      pp.collection_case_id,
      pp.total_amount::text,
      pp.installment_count::text,
      pp.installment_amount::text,
      pp.next_due_date::text AS next_due_date,
      pp.status,
      pp.created_at::text,
      pp.updated_at::text,
      cc.id AS case_id,
      cc.invoice_id AS case_invoice_id,
      cc.agent_id AS case_agent_id,
      cc.status AS case_status,
      cc.resolution_type AS case_resolution_type,
      i.id AS invoice_id,
      i.customer_id AS invoice_customer_id,
      i.amount::text AS invoice_amount,
      i.currency AS invoice_currency,
      i.due_date::text AS invoice_due_date,
      i.status AS invoice_status,
      i.issued_at::text AS invoice_issued_at,
      i.created_at::text AS invoice_created_at,
      i.updated_at::text AS invoice_updated_at,
      c.id AS customer_id,
      c.company_name AS customer_company_name,
      c.segment AS customer_segment
    FROM rl_payment_plans pp
    JOIN rl_collection_cases cc ON cc.id = pp.collection_case_id
    JOIN rl_invoices i ON i.id = cc.invoice_id
    JOIN rl_customers c ON c.id = i.customer_id
    WHERE pp.id = ${planId}
    LIMIT 1
  `;
}

async function fetchPlanPayments(planId: string, sqlClient: postgres.Sql): Promise<PaymentRow[]> {
  const rows = await sqlClient<PaymentRow[]>`
    SELECT
      p.amount::text,
      p.received_at::text AS received_at
    FROM rl_payments p
    JOIN rl_collection_cases cc ON cc.invoice_id = p.invoice_id
    JOIN rl_payment_plans pp ON pp.collection_case_id = cc.id
    WHERE pp.id = ${planId}
    ORDER BY p.received_at ASC, p.created_at ASC
  `;
  return rows;
}

function buildDetailFromRows(
  row: Awaited<ReturnType<typeof fetchPlanDetailRows>>[number],
  payments: PaymentRow[],
): PaymentPlanDetail {
  const summary = summarizePaymentPlanRow(row);
  const payment_total = roundCurrency(
    payments.reduce((sum, payment) => sum + parseMoney(payment.amount), 0),
  );
  const installments = buildPaymentPlanInstallments({
    total_amount: summary.total_amount,
    installment_count: summary.installment_count,
    installment_amount: summary.installment_amount,
    first_due_date: summary.next_due_date ?? row.created_at.slice(0, 10),
    payment_total,
  });
  const lifecycle = derivePlanState({ ...summary, payment_total, installments });

  return {
    ...summary,
    next_due_date: lifecycle.next_due_date,
    collection_case: {
      id: row.case_id,
      invoice_id: row.case_invoice_id,
      agent_id: row.case_agent_id,
      status: row.case_status,
      resolution_type: row.case_resolution_type,
    },
    invoice: {
      id: row.invoice_id,
      customer_id: row.invoice_customer_id,
      amount: parseMoney(row.invoice_amount),
      currency: row.invoice_currency,
      due_date: row.invoice_due_date,
      status: row.invoice_status,
      issued_at: row.invoice_issued_at,
      created_at: row.invoice_created_at,
      updated_at: row.invoice_updated_at,
    },
    customer: {
      id: row.customer_id,
      company_name: row.customer_company_name,
      segment: row.customer_segment,
    },
    installments,
    payment_total,
    paid_installment_count: lifecycle.paidInstallmentCount,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listPaymentPlansForCase(
  collectionCaseId: string,
  sqlClient: postgres.Sql = defaultSql,
): Promise<PaymentPlanSummary[]> {
  const rows = await sqlClient<
    {
      id: string;
      collection_case_id: string;
      total_amount: string;
      installment_count: string;
      installment_amount: string;
      next_due_date: string | null;
      status: string;
      created_at: string;
      updated_at: string;
    }[]
  >`
    SELECT
      id,
      collection_case_id,
      total_amount::text,
      installment_count::text,
      installment_amount::text,
      next_due_date::text AS next_due_date,
      status,
      created_at::text,
      updated_at::text
    FROM rl_payment_plans
    WHERE collection_case_id = ${collectionCaseId}
    ORDER BY created_at DESC
  `;

  return rows.map(summarizePaymentPlanRow);
}

export async function getPaymentPlanDetail(
  planId: string,
  sqlClient: postgres.Sql = defaultSql,
): Promise<PaymentPlanDetail | null> {
  const rows = await fetchPlanDetailRows(planId, sqlClient);
  if (rows.length === 0) return null;

  const payments = await fetchPlanPayments(planId, sqlClient);
  return buildDetailFromRows(rows[0], payments);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function createPaymentPlan(
  opts: CreatePaymentPlanOptions,
  sqlClient: postgres.Sql = defaultSql,
): Promise<PaymentPlanDetail> {
  const { collection_case_id, total_amount, installment_count, first_due_date } = opts;

  if (!Number.isFinite(total_amount) || total_amount <= 0) {
    throw new Error('total_amount must be a positive number');
  }
  if (!Number.isInteger(installment_count) || installment_count < 1) {
    throw new Error('installment_count must be an integer greater than or equal to 1');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(first_due_date)) {
    throw new Error('first_due_date must be a YYYY-MM-DD date string');
  }
  if (first_due_date < formatDateOnly(new Date())) {
    throw new Error('first_due_date cannot be in the past');
  }

  return sqlClient.begin(async (tx: TxSql) => {
    const [caseRow] = await tx<{ id: string }[]>`
      SELECT id
      FROM rl_collection_cases
      WHERE id = ${collection_case_id}
      LIMIT 1
    `;
    if (!caseRow) {
      throw new Error('Collection case not found');
    }

    const currentPlans = await tx<{ id: string }[]>`
      SELECT id
      FROM rl_payment_plans
      WHERE collection_case_id = ${collection_case_id}
        AND status = 'current'
      LIMIT 1
    `;
    if (currentPlans.length > 0) {
      throw new Error('An active payment plan already exists for this collection case');
    }

    const installmentAmount = roundCurrency(total_amount / installment_count);
    const [planRow] = await tx<
      {
        id: string;
        collection_case_id: string;
        total_amount: string;
        installment_count: string;
        installment_amount: string;
        next_due_date: string | null;
        status: string;
        created_at: string;
        updated_at: string;
      }[]
    >`
      INSERT INTO rl_payment_plans
        (collection_case_id, total_amount, installment_count, installment_amount, next_due_date, status)
      VALUES (
        ${collection_case_id},
        ${total_amount},
        ${installment_count},
        ${installmentAmount},
        ${first_due_date},
        'current'
      )
      RETURNING
        id,
        collection_case_id,
        total_amount::text,
        installment_count::text,
        installment_amount::text,
        next_due_date::text AS next_due_date,
        status,
        created_at::text,
        updated_at::text
    `;

    const detail = await getPaymentPlanDetail(planRow.id, tx);
    if (!detail) {
      throw new Error('Payment plan not found after insert');
    }
    return detail;
  });
}

export async function updatePaymentPlanStatus(
  planId: string,
  status: Exclude<PaymentPlanStatus, 'cancelled'>,
  sqlClient: postgres.Sql = defaultSql,
): Promise<PaymentPlanDetail | null> {
  return sqlClient.begin(async (tx: TxSql) => {
    const detail = await getPaymentPlanDetail(planId, tx);
    if (!detail) return null;

    if (status === 'completed') {
      if (detail.payment_total < detail.total_amount) {
        throw new Error('Payment plan cannot be marked completed before it is fully paid');
      }

      await tx`
        UPDATE rl_payment_plans
        SET status = 'completed',
            updated_at = NOW()
        WHERE id = ${planId}
      `;

      await tx`
        UPDATE rl_collection_cases
        SET status = 'resolved',
            resolution_type = 'payment_plan',
            resolved_at = COALESCE(resolved_at, NOW()),
            updated_at = NOW()
        WHERE id = ${detail.collection_case_id}
      `;

      await tx`
        UPDATE rl_invoices
        SET status = 'paid',
            updated_at = NOW()
        WHERE id = ${detail.collection_case.invoice_id}
      `;
    } else if (status === 'breached') {
      await tx`
        UPDATE rl_payment_plans
        SET status = 'breached',
            updated_at = NOW()
        WHERE id = ${planId}
      `;
    }

    const updated = await getPaymentPlanDetail(planId, tx);
    return updated;
  });
}

export async function reconcilePaymentPlanLifecycle(
  sqlClient: postgres.Sql = defaultSql,
): Promise<PaymentPlanLifecycleResult> {
  const completed: string[] = [];
  const breached: string[] = [];

  const planIds = await sqlClient<{ id: string }[]>`
    SELECT id
    FROM rl_payment_plans
    WHERE status IN ('current', 'breached')
    ORDER BY created_at ASC
  `;

  for (const row of planIds) {
    const detail = await getPaymentPlanDetail(row.id, sqlClient);
    if (!detail) continue;

    const state = derivePlanState(detail);
    if (state.fullyPaid) {
      if (detail.status !== 'completed') {
        await updatePaymentPlanStatus(detail.id, 'completed', sqlClient);
        completed.push(detail.id);
      }
      continue;
    }

    if (detail.status === 'current' && state.breached) {
      await updatePaymentPlanStatus(detail.id, 'breached', sqlClient);
      breached.push(detail.id);
    }
  }

  return { completed, breached };
}
