/**
 * @file invoices.ts
 *
 * Database query functions for invoice creation and payment recording (issue #47).
 *
 * Exports:
 *   createInvoice         — insert a new draft/sent invoice for a customer
 *   listInvoices          — list invoices with optional customer_id filter
 *   getInvoice            — fetch a single invoice by id
 *   recordPayment         — insert a payment record for an invoice
 *   listInvoicePayments   — list all payments for a given invoice
 *
 * Invoice status transitions are guarded by the DB trigger
 * `trg_invoice_status_transition`.  This module only inserts invoices in
 * 'draft' status and lets the caller transition to 'sent' in a follow-up
 * UPDATE if desired.
 *
 * Canonical docs: docs/prd.md §4.3
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/47
 */

import type postgres from 'postgres';
import { sql as defaultSql } from './index';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InvoiceStatus =
  | 'draft'
  | 'sent'
  | 'partial_paid'
  | 'overdue'
  | 'in_collection'
  | 'paid'
  | 'settled'
  | 'written_off';

export interface Invoice {
  id: string;
  customer_id: string;
  customer_name: string;
  amount: number;
  currency: string;
  due_date: string | null;
  status: InvoiceStatus;
  issued_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Payment {
  id: string;
  invoice_id: string;
  amount: number;
  method: string | null;
  received_at: string;
  recorded_by: string | null;
  created_at: string;
}

export interface CreateInvoiceOptions {
  customer_id: string;
  amount: number;
  currency?: string;
  due_date?: string | null;
  /** If true, invoice is immediately transitioned to 'sent'. Defaults to false (stays 'draft'). */
  send?: boolean;
}

export interface RecordPaymentOptions {
  invoice_id: string;
  amount: number;
  method?: string | null;
  received_at?: string;
  recorded_by?: string | null;
}

export interface ListInvoicesOptions {
  /** Filter by customer ID. */
  customer_id?: string;
  /** Filter by status. */
  status?: InvoiceStatus;
  /** Max rows to return (default 100). */
  limit?: number;
}

// ---------------------------------------------------------------------------
// createInvoice
// ---------------------------------------------------------------------------

/**
 * Creates a new invoice for a customer.
 *
 * Inserts as 'draft', then optionally transitions to 'sent' when `send` is true.
 * Returns the resulting invoice row (with customer_name joined from rl_customers).
 */
export async function createInvoice(
  opts: CreateInvoiceOptions,
  sqlClient: postgres.Sql = defaultSql,
): Promise<Invoice> {
  const { customer_id, amount, currency = 'USD', due_date = null, send = false } = opts;

  const [row] = await sqlClient<{ id: string }[]>`
    INSERT INTO rl_invoices (customer_id, amount, currency, due_date, status)
    VALUES (
      ${customer_id},
      ${amount},
      ${currency},
      ${due_date},
      'draft'
    )
    RETURNING id
  `;

  if (send) {
    await sqlClient`
      UPDATE rl_invoices
      SET status = 'sent', issued_at = NOW(), updated_at = NOW()
      WHERE id = ${row.id}
    `;
  }

  const invoice = await getInvoice(row.id, sqlClient);
  if (!invoice) {
    throw new Error(`Invoice ${row.id} not found after insert`);
  }
  return invoice;
}

// ---------------------------------------------------------------------------
// getInvoice
// ---------------------------------------------------------------------------

/**
 * Returns a single invoice by ID, or null if not found.
 */
export async function getInvoice(
  id: string,
  sqlClient: postgres.Sql = defaultSql,
): Promise<Invoice | null> {
  const rows = await sqlClient<
    {
      id: string;
      customer_id: string;
      customer_name: string;
      amount: string;
      currency: string;
      due_date: string | null;
      status: string;
      issued_at: string | null;
      created_at: string;
      updated_at: string;
    }[]
  >`
    SELECT
      i.id,
      i.customer_id,
      c.company_name AS customer_name,
      i.amount::text,
      i.currency,
      i.due_date::text AS due_date,
      i.status,
      i.issued_at::text AS issued_at,
      i.created_at::text,
      i.updated_at::text
    FROM rl_invoices i
    JOIN rl_customers c ON c.id = i.customer_id
    WHERE i.id = ${id}
    LIMIT 1
  `;

  if (rows.length === 0) return null;
  return mapInvoiceRow(rows[0]);
}

// ---------------------------------------------------------------------------
// listInvoices
// ---------------------------------------------------------------------------

/**
 * Returns invoices with an optional customer_id and/or status filter.
 */
export async function listInvoices(
  opts: ListInvoicesOptions = {},
  sqlClient: postgres.Sql = defaultSql,
): Promise<Invoice[]> {
  const { customer_id, status, limit = 100 } = opts;

  type Row = {
    id: string;
    customer_id: string;
    customer_name: string;
    amount: string;
    currency: string;
    due_date: string | null;
    status: string;
    issued_at: string | null;
    created_at: string;
    updated_at: string;
  };

  let rows: Row[];

  if (customer_id && status) {
    rows = await sqlClient<Row[]>`
      SELECT
        i.id,
        i.customer_id,
        c.company_name AS customer_name,
        i.amount::text,
        i.currency,
        i.due_date::text AS due_date,
        i.status,
        i.issued_at::text AS issued_at,
        i.created_at::text,
        i.updated_at::text
      FROM rl_invoices i
      JOIN rl_customers c ON c.id = i.customer_id
      WHERE i.customer_id = ${customer_id}
        AND i.status = ${status}
      ORDER BY i.created_at DESC
      LIMIT ${limit}
    `;
  } else if (customer_id) {
    rows = await sqlClient<Row[]>`
      SELECT
        i.id,
        i.customer_id,
        c.company_name AS customer_name,
        i.amount::text,
        i.currency,
        i.due_date::text AS due_date,
        i.status,
        i.issued_at::text AS issued_at,
        i.created_at::text,
        i.updated_at::text
      FROM rl_invoices i
      JOIN rl_customers c ON c.id = i.customer_id
      WHERE i.customer_id = ${customer_id}
      ORDER BY i.created_at DESC
      LIMIT ${limit}
    `;
  } else if (status) {
    rows = await sqlClient<Row[]>`
      SELECT
        i.id,
        i.customer_id,
        c.company_name AS customer_name,
        i.amount::text,
        i.currency,
        i.due_date::text AS due_date,
        i.status,
        i.issued_at::text AS issued_at,
        i.created_at::text,
        i.updated_at::text
      FROM rl_invoices i
      JOIN rl_customers c ON c.id = i.customer_id
      WHERE i.status = ${status}
      ORDER BY i.created_at DESC
      LIMIT ${limit}
    `;
  } else {
    rows = await sqlClient<Row[]>`
      SELECT
        i.id,
        i.customer_id,
        c.company_name AS customer_name,
        i.amount::text,
        i.currency,
        i.due_date::text AS due_date,
        i.status,
        i.issued_at::text AS issued_at,
        i.created_at::text,
        i.updated_at::text
      FROM rl_invoices i
      JOIN rl_customers c ON c.id = i.customer_id
      ORDER BY i.created_at DESC
      LIMIT ${limit}
    `;
  }

  return rows.map(mapInvoiceRow);
}

// ---------------------------------------------------------------------------
// recordPayment
// ---------------------------------------------------------------------------

/**
 * Inserts a payment record for an invoice.
 *
 * After recording, the invoice status is updated:
 *   - If total payments >= invoice amount → status set to 'paid'
 *   - Otherwise (partial) → status set to 'partial_paid' (if currently 'sent' or 'overdue')
 *
 * The status guard trigger in the DB enforces the valid transition graph.
 * This function wraps both INSERTs in a transaction.
 */
export async function recordPayment(
  opts: RecordPaymentOptions,
  sqlClient: postgres.Sql = defaultSql,
): Promise<Payment> {
  const {
    invoice_id,
    amount,
    method = null,
    received_at = new Date().toISOString(),
    recorded_by = null,
  } = opts;

  let payment: Payment;

  await sqlClient.begin(async (tx) => {
    // Insert the payment record.
    const [payRow] = await (tx as unknown as postgres.Sql)<
      {
        id: string;
        invoice_id: string;
        amount: string;
        method: string | null;
        received_at: string;
        recorded_by: string | null;
        created_at: string;
      }[]
    >`
      INSERT INTO rl_payments (invoice_id, amount, method, received_at, recorded_by)
      VALUES (
        ${invoice_id},
        ${amount},
        ${method},
        ${received_at}::timestamptz,
        ${recorded_by}
      )
      RETURNING id, invoice_id, amount::text, method, received_at::text, recorded_by, created_at::text
    `;

    payment = {
      id: payRow.id,
      invoice_id: payRow.invoice_id,
      amount: parseFloat(payRow.amount),
      method: payRow.method,
      received_at: payRow.received_at,
      recorded_by: payRow.recorded_by,
      created_at: payRow.created_at,
    };

    // Recompute total paid and update invoice status accordingly.
    const [invRow] = await (tx as unknown as postgres.Sql)<
      { amount: string; status: string; total_paid: string }[]
    >`
      SELECT
        i.amount::text,
        i.status,
        COALESCE(SUM(p.amount), 0)::text AS total_paid
      FROM rl_invoices i
      LEFT JOIN rl_payments p ON p.invoice_id = i.id
      WHERE i.id = ${invoice_id}
      GROUP BY i.amount, i.status
    `;

    if (!invRow) {
      throw new Error(`Invoice ${invoice_id} not found`);
    }

    const invoiceAmount = parseFloat(invRow.amount);
    const totalPaid = parseFloat(invRow.total_paid);
    const currentStatus = invRow.status as InvoiceStatus;

    // Terminal statuses — no update needed.
    const TERMINAL = new Set<InvoiceStatus>(['paid', 'settled', 'written_off']);
    if (TERMINAL.has(currentStatus)) {
      return;
    }

    if (totalPaid >= invoiceAmount) {
      // Fully paid — transition to 'paid'.
      // The trigger only allows paid from 'in_collection', so we route through
      // the valid transition graph:
      //   sent → overdue → in_collection → paid
      //   partial_paid → overdue → in_collection → paid
      // We minimise intermediate transitions by only stepping through what's needed.
      const STEPS_TO_PAID: Record<InvoiceStatus, InvoiceStatus[]> = {
        draft: ['sent', 'overdue', 'in_collection', 'paid'],
        sent: ['overdue', 'in_collection', 'paid'],
        partial_paid: ['overdue', 'in_collection', 'paid'],
        overdue: ['in_collection', 'paid'],
        in_collection: ['paid'],
        paid: [],
        settled: [],
        written_off: [],
      };
      for (const s of STEPS_TO_PAID[currentStatus] ?? []) {
        await (tx as unknown as postgres.Sql)`
          UPDATE rl_invoices SET status = ${s}, updated_at = NOW() WHERE id = ${invoice_id}
        `;
      }
    } else {
      // Partially paid — transition to 'partial_paid' when the current status allows it.
      const PARTIAL_ALLOWED = new Set<InvoiceStatus>(['sent', 'overdue', 'in_collection']);
      if (PARTIAL_ALLOWED.has(currentStatus)) {
        // Only transition if we're in 'sent'; 'overdue' and 'in_collection' are
        // already past partial_paid in the graph, so we leave those as-is.
        if (currentStatus === 'sent') {
          await (tx as unknown as postgres.Sql)`
            UPDATE rl_invoices SET status = 'partial_paid', updated_at = NOW() WHERE id = ${invoice_id}
          `;
        }
      }
    }
  });

  return payment!;
}

// ---------------------------------------------------------------------------
// listInvoicePayments
// ---------------------------------------------------------------------------

/**
 * Returns all payments for a given invoice, ordered by received_at descending.
 */
export async function listInvoicePayments(
  invoice_id: string,
  sqlClient: postgres.Sql = defaultSql,
): Promise<Payment[]> {
  const rows = await sqlClient<
    {
      id: string;
      invoice_id: string;
      amount: string;
      method: string | null;
      received_at: string;
      recorded_by: string | null;
      created_at: string;
    }[]
  >`
    SELECT
      id,
      invoice_id,
      amount::text,
      method,
      received_at::text,
      recorded_by,
      created_at::text
    FROM rl_payments
    WHERE invoice_id = ${invoice_id}
    ORDER BY received_at DESC
  `;

  return rows.map((r) => ({
    id: r.id,
    invoice_id: r.invoice_id,
    amount: parseFloat(r.amount),
    method: r.method,
    received_at: r.received_at,
    recorded_by: r.recorded_by,
    created_at: r.created_at,
  }));
}

// ---------------------------------------------------------------------------
// Row mapper
// ---------------------------------------------------------------------------

function mapInvoiceRow(row: {
  id: string;
  customer_id: string;
  customer_name: string;
  amount: string;
  currency: string;
  due_date: string | null;
  status: string;
  issued_at: string | null;
  created_at: string;
  updated_at: string;
}): Invoice {
  return {
    id: row.id,
    customer_id: row.customer_id,
    customer_name: row.customer_name,
    amount: parseFloat(row.amount),
    currency: row.currency,
    due_date: row.due_date ?? null,
    status: row.status as InvoiceStatus,
    issued_at: row.issued_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
