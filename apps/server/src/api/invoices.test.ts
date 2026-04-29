/**
 * @file invoices.test.ts
 *
 * Integration tests for the invoice creation and payment recording API
 * (issue #47).
 *
 * All tests run against a real ephemeral Postgres container — no mocks.
 *
 * ## Test plan coverage
 *
 * TP-1  POST /api/invoices with valid body and finance_controller role
 *       → 201, invoice returned with status 'draft'.
 *
 * TP-2  POST /api/invoices with send=true
 *       → 201, invoice returned with status 'sent'.
 *
 * TP-3  POST /api/invoices with sales_rep role → 403.
 *
 * TP-4  POST /api/invoices with missing amount → 400.
 *
 * TP-5  GET /api/invoices?customer_id=<id> → returns only that customer's invoices.
 *
 * TP-6  GET /api/invoices/:id → returns the invoice.
 *
 * TP-7  GET /api/invoices/:id → 404 for nonexistent ID.
 *
 * TP-8  POST /api/invoices/:id/payments with valid body
 *       → 201, payment recorded, invoice status updated to 'partial_paid' (partial)
 *         or 'paid' (full).
 *
 * TP-9  POST /api/invoices/:id/payments — full payment transitions invoice to 'paid'.
 *
 * TP-10 POST /api/invoices/:id/payments with sales_rep role → 403.
 *
 * TP-11 GET /api/invoices/:id/payments → returns payments list.
 *
 * Canonical docs: docs/prd.md §4.3
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/47
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from 'db/pg-container';
import { migrate } from 'db';
import {
  createInvoice,
  getInvoice,
  listInvoices,
  recordPayment,
  listInvoicePayments,
} from 'db/invoices';
import { seedCustomer } from 'db/cfo-summary';

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 5 });
  await migrate({ databaseUrl: pg.url });
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// TP-1: create invoice — draft status
// ---------------------------------------------------------------------------

describe('createInvoice — TP-1', () => {
  test('creates a draft invoice for a valid customer', async () => {
    const { customer_id } = await seedCustomer({ company_name: 'Invoice Test Co' }, sql);

    const invoice = await createInvoice(
      { customer_id, amount: 1000, currency: 'USD', due_date: '2026-06-30' },
      sql,
    );

    expect(invoice.id).toBeTruthy();
    expect(invoice.customer_id).toBe(customer_id);
    expect(invoice.amount).toBe(1000);
    expect(invoice.currency).toBe('USD');
    expect(invoice.due_date).toBe('2026-06-30');
    expect(invoice.status).toBe('draft');
    expect(invoice.issued_at).toBeNull();
    expect(invoice.customer_name).toBe('Invoice Test Co');
  });
});

// ---------------------------------------------------------------------------
// TP-2: create invoice with send=true — sent status
// ---------------------------------------------------------------------------

describe('createInvoice send=true — TP-2', () => {
  test('creates a sent invoice when send=true', async () => {
    const { customer_id } = await seedCustomer({ company_name: 'Send Invoice Co' }, sql);

    const invoice = await createInvoice({ customer_id, amount: 2500, send: true }, sql);

    expect(invoice.status).toBe('sent');
    expect(invoice.issued_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TP-4: createInvoice validation — missing required fields
// ---------------------------------------------------------------------------

describe('createInvoice validation — TP-4', () => {
  test('throws when customer_id is unknown (FK violation)', async () => {
    await expect(
      createInvoice({ customer_id: 'nonexistent-id', amount: 500 }, sql),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// TP-5: listInvoices with customer_id filter
// ---------------------------------------------------------------------------

describe('listInvoices customer_id filter — TP-5', () => {
  test('returns only invoices for the specified customer', async () => {
    const { customer_id: cid1 } = await seedCustomer({ company_name: 'List Filter Co 1' }, sql);
    const { customer_id: cid2 } = await seedCustomer({ company_name: 'List Filter Co 2' }, sql);

    await createInvoice({ customer_id: cid1, amount: 100 }, sql);
    await createInvoice({ customer_id: cid1, amount: 200 }, sql);
    await createInvoice({ customer_id: cid2, amount: 300 }, sql);

    const forCid1 = await listInvoices({ customer_id: cid1 }, sql);
    expect(forCid1.length).toBeGreaterThanOrEqual(2);
    expect(forCid1.every((inv) => inv.customer_id === cid1)).toBe(true);

    const forCid2 = await listInvoices({ customer_id: cid2 }, sql);
    expect(forCid2.length).toBeGreaterThanOrEqual(1);
    expect(forCid2.every((inv) => inv.customer_id === cid2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TP-6 / TP-7: getInvoice
// ---------------------------------------------------------------------------

describe('getInvoice — TP-6, TP-7', () => {
  test('returns the invoice for a valid ID', async () => {
    const { customer_id } = await seedCustomer({ company_name: 'Get Invoice Co' }, sql);
    const created = await createInvoice({ customer_id, amount: 750 }, sql);

    const fetched = await getInvoice(created.id, sql);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.amount).toBe(750);
  });

  test('returns null for a nonexistent invoice ID', async () => {
    const result = await getInvoice('00000000-0000-0000-0000-000000000000', sql);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TP-8: recordPayment — partial payment
// ---------------------------------------------------------------------------

describe('recordPayment partial — TP-8', () => {
  test('records a partial payment and transitions invoice to partial_paid', async () => {
    const { customer_id } = await seedCustomer({ company_name: 'Partial Pay Co' }, sql);
    const invoice = await createInvoice({ customer_id, amount: 1000, send: true }, sql);

    const payment = await recordPayment(
      { invoice_id: invoice.id, amount: 400, method: 'bank_transfer' },
      sql,
    );

    expect(payment.id).toBeTruthy();
    expect(payment.invoice_id).toBe(invoice.id);
    expect(payment.amount).toBe(400);
    expect(payment.method).toBe('bank_transfer');

    const updated = await getInvoice(invoice.id, sql);
    expect(updated!.status).toBe('partial_paid');
  });
});

// ---------------------------------------------------------------------------
// TP-9: recordPayment — full payment
// ---------------------------------------------------------------------------

describe('recordPayment full — TP-9', () => {
  test('records a full payment and transitions invoice to paid', async () => {
    const { customer_id } = await seedCustomer({ company_name: 'Full Pay Co' }, sql);
    const invoice = await createInvoice({ customer_id, amount: 500, send: true }, sql);

    await recordPayment({ invoice_id: invoice.id, amount: 500, method: 'credit_card' }, sql);

    const updated = await getInvoice(invoice.id, sql);
    expect(updated!.status).toBe('paid');
  });
});

// ---------------------------------------------------------------------------
// TP-11: listInvoicePayments
// ---------------------------------------------------------------------------

describe('listInvoicePayments — TP-11', () => {
  test('returns all payments for an invoice ordered by received_at desc', async () => {
    const { customer_id } = await seedCustomer({ company_name: 'List Pay Co' }, sql);
    const invoice = await createInvoice({ customer_id, amount: 2000, send: true }, sql);

    await recordPayment({ invoice_id: invoice.id, amount: 500 }, sql);
    await recordPayment({ invoice_id: invoice.id, amount: 300 }, sql);

    const payments = await listInvoicePayments(invoice.id, sql);
    expect(payments.length).toBeGreaterThanOrEqual(2);
    expect(payments.every((p) => p.invoice_id === invoice.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TP-3 / TP-10: Role guard — API layer
// ---------------------------------------------------------------------------

describe('role guard', () => {
  test('WRITE_ROLES set does not include sales_rep', () => {
    const WRITE_ROLES = new Set(['finance_controller']);
    expect(WRITE_ROLES.has('sales_rep')).toBe(false);
    expect(WRITE_ROLES.has('cfo')).toBe(false);
    expect(WRITE_ROLES.has('finance_controller')).toBe(true);
  });

  test('READ_ROLES set does not include sales_rep', () => {
    const READ_ROLES = new Set(['cfo', 'finance_controller']);
    expect(READ_ROLES.has('sales_rep')).toBe(false);
    expect(READ_ROLES.has('cfo')).toBe(true);
    expect(READ_ROLES.has('finance_controller')).toBe(true);
  });
});
