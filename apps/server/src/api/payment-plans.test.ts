/**
 * @file payment-plans.test.ts
 *
 * Integration tests for the payment-plan HTTP endpoints (issue #50).
 *
 * All tests run against a real ephemeral Postgres container. The auth helper
 * is mocked so the route handlers can be exercised without a full JWT/session
 * bootstrap.
 *
 * ## Test plan coverage
 *
 * TP-1  POST /api/collection-cases/:id/payment-plans creates a current plan
 *       and returns the plan detail payload.
 * TP-2  GET /api/payment-plans/:id returns the installment schedule.
 * TP-3  PATCH /api/payment-plans/:id/status marks a fully paid plan completed.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/50
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from 'db/pg-container';
import { migrate } from 'db';
import { seedCustomer } from 'db/cfo-summary';
import { createInvoice } from 'db/invoices';
import { assignAgentToCase } from 'db/collection-cases';
import { transitionInvoiceToCollection } from 'db/dunning';
import type { AppState } from '../index';
import { handleCollectionCasesRequest } from './collection-cases';
import { handlePaymentPlansRequest } from './payment-plans';
import * as auth from './auth';

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;
let appState: AppState;

const AUTH_USER_ID = crypto.randomUUID();

async function createCollectionsAgentUser(): Promise<string> {
  await sql`
    INSERT INTO entities (id, type, properties)
    VALUES (
      ${AUTH_USER_ID},
      'user',
      ${sql.json({ role: 'collections_agent', username: 'pay-plan-agent' } as never)}
    )
  `;
  return AUTH_USER_ID;
}

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 5 });
  await migrate({ databaseUrl: pg.url });
  appState = {
    sql,
    auditSql: sql as never,
    analyticsSql: sql as never,
    dictionarySql: sql as never,
  };
  await createCollectionsAgentUser();
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await pg?.stop();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedCase(): Promise<{ caseId: string; invoiceId: string }> {
  const { customer_id } = await seedCustomer({ company_name: 'Plan API Co' }, sql);
  const invoice = await createInvoice(
    {
      customer_id,
      amount: 1200,
      currency: 'USD',
      due_date: new Date().toISOString().slice(0, 10),
      send: true,
    },
    sql,
  );
  await sql`
    UPDATE rl_invoices
    SET status = 'overdue', updated_at = NOW()
    WHERE id = ${invoice.id}
  `;
  const collectionCase = await transitionInvoiceToCollection(invoice.id, sql);
  await assignAgentToCase(collectionCase.id, AUTH_USER_ID, sql);
  return { caseId: collectionCase.id, invoiceId: invoice.id };
}

describe('payment plan create/detail/status routes', () => {
  test('POST /api/collection-cases/:id/payment-plans creates a current plan', async () => {
    const { caseId } = await seedCase();

    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValue({ id: AUTH_USER_ID } as never);

    const req = new Request(`http://localhost/api/collection-cases/${caseId}/payment-plans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        total_amount: 1200,
        installment_count: 3,
        first_due_date: new Date(Date.now() + 86400 * 1000).toISOString().slice(0, 10),
      }),
    });
    const res = await handleCollectionCasesRequest(req, new URL(req.url), appState);

    expect(res).not.toBeNull();
    expect(res!.status).toBe(201);

    const body = (await res!.json()) as { status: string; installments: unknown[] };
    expect(body.status).toBe('current');
    expect(body.installments).toHaveLength(3);
  });

  test('GET /api/payment-plans/:id returns the installment schedule', async () => {
    const { caseId } = await seedCase();

    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValue({ id: AUTH_USER_ID } as never);

    const createReq = new Request(`http://localhost/api/collection-cases/${caseId}/payment-plans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        total_amount: 1500,
        installment_count: 3,
        first_due_date: new Date(Date.now() + 86400 * 1000).toISOString().slice(0, 10),
      }),
    });
    const createRes = await handleCollectionCasesRequest(
      createReq,
      new URL(createReq.url),
      appState,
    );
    const created = (await createRes!.json()) as { id: string };

    const getReq = new Request(`http://localhost/api/payment-plans/${created.id}`, {
      method: 'GET',
    });
    const getRes = await handlePaymentPlansRequest(getReq, new URL(getReq.url), appState);

    expect(getRes).not.toBeNull();
    expect(getRes!.status).toBe(200);

    const plan = (await getRes!.json()) as {
      id: string;
      installments: { installment_number: number; due_date: string; status: string }[];
    };
    expect(plan.id).toBe(created.id);
    expect(plan.installments).toHaveLength(3);
    expect(plan.installments[0]?.status).toBe('unpaid');
  });

  test('PATCH /api/payment-plans/:id/status marks a fully paid plan completed', async () => {
    const { caseId, invoiceId } = await seedCase();

    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValue({ id: AUTH_USER_ID } as never);

    const createReq = new Request(`http://localhost/api/collection-cases/${caseId}/payment-plans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        total_amount: 900,
        installment_count: 3,
        first_due_date: new Date(Date.now() + 86400 * 1000).toISOString().slice(0, 10),
      }),
    });
    const createRes = await handleCollectionCasesRequest(
      createReq,
      new URL(createReq.url),
      appState,
    );
    const created = (await createRes!.json()) as { id: string };

    await sql`
      INSERT INTO rl_payments (invoice_id, amount, received_at)
      VALUES (${invoiceId}, 300, NOW()), (${invoiceId}, 300, NOW()), (${invoiceId}, 300, NOW())
    `;

    const patchReq = new Request(`http://localhost/api/payment-plans/${created.id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });
    const patchRes = await handlePaymentPlansRequest(patchReq, new URL(patchReq.url), appState);

    expect(patchRes).not.toBeNull();
    expect(patchRes!.status).toBe(200);

    const plan = (await patchRes!.json()) as { status: string };
    expect(plan.status).toBe('completed');

    const [caseRow] = await sql<{ status: string; resolution_type: string | null }[]>`
      SELECT status, resolution_type FROM rl_collection_cases WHERE id = ${caseId}
    `;
    expect(caseRow.status).toBe('resolved');
    expect(caseRow.resolution_type).toBe('payment_plan');
  });
});
