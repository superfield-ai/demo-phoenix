/**
 * @file payment-plans.test.ts
 *
 * Integration tests for payment-plan configuration and reconciliation
 * (issue #50).
 *
 * ## Test plan coverage
 *
 * TP-1  Unit: createPaymentPlan rejects installment_count < 1 and a first due
 *        date in the past.
 * TP-2  Unit: schedule generation returns one installment row per installment
 *        and preserves the expected amounts / due dates.
 * TP-3  Integration: a current plan with a past-due next_due_date is marked
 *        breached by reconcilePaymentPlanLifecycle.
 * TP-4  Integration: a fully paid plan is marked completed and the linked
 *        collection case resolves with resolution_type=payment_plan.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/50
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from './pg-container';
import { migrate } from './index';
import { seedCustomer } from './cfo-summary';
import { createInvoice } from './invoices';
import { transitionInvoiceToCollection } from './dunning';
import {
  createPaymentPlan,
  getPaymentPlanDetail,
  reconcilePaymentPlanLifecycle,
  buildPaymentPlanInstallments,
} from './payment-plans';

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

async function seedCollectionCaseWithInvoice(opts: { customer_name: string; amount: number }) {
  const { customer_id } = await seedCustomer({ company_name: opts.customer_name }, sql);
  const invoice = await createInvoice(
    {
      customer_id,
      amount: opts.amount,
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
  return { customer_id, invoice, collectionCase };
}

describe('createPaymentPlan validation — TP-1', () => {
  test('rejects installment_count < 1', async () => {
    const { collectionCase } = await seedCollectionCaseWithInvoice({
      customer_name: 'Validation Count Co',
      amount: 1200,
    });

    await expect(
      createPaymentPlan(
        {
          collection_case_id: collectionCase.id,
          total_amount: 1200,
          installment_count: 0,
          first_due_date: new Date(Date.now() + 86400 * 1000).toISOString().slice(0, 10),
        },
        sql,
      ),
    ).rejects.toThrow(/installment_count/);
  });

  test('rejects first_due_date in the past', async () => {
    const { collectionCase } = await seedCollectionCaseWithInvoice({
      customer_name: 'Validation Date Co',
      amount: 1200,
    });

    await expect(
      createPaymentPlan(
        {
          collection_case_id: collectionCase.id,
          total_amount: 1200,
          installment_count: 3,
          first_due_date: '2000-01-01',
        },
        sql,
      ),
    ).rejects.toThrow(/past/);
  });
});

describe('payment plan schedule — TP-2', () => {
  test('buildPaymentPlanInstallments returns one row per installment with the expected amounts', () => {
    const installments = buildPaymentPlanInstallments({
      total_amount: 1000,
      installment_count: 3,
      installment_amount: 333.33,
      first_due_date: '2026-05-01',
      payment_total: 0,
    });

    expect(installments).toHaveLength(3);
    expect(installments[0]?.due_date).toBe('2026-05-01');
    expect(installments[1]?.due_date).toBe('2026-05-31');
    expect(installments[2]?.due_date).toBe('2026-06-30');
    expect(installments[0]?.amount).toBeCloseTo(333.33, 2);
    expect(installments[2]?.amount).toBeCloseTo(333.34, 2);
  });
});

describe('payment plan reconciliation — TP-3', () => {
  test('marks an overdue current plan as breached', async () => {
    const { collectionCase } = await seedCollectionCaseWithInvoice({
      customer_name: 'Breach Reconcile Co',
      amount: 1500,
    });

    const plan = await createPaymentPlan(
      {
        collection_case_id: collectionCase.id,
        total_amount: 1500,
        installment_count: 3,
        first_due_date: new Date(Date.now() + 86400 * 1000).toISOString().slice(0, 10),
      },
      sql,
    );

    await sql`
      UPDATE rl_payment_plans
      SET next_due_date = CURRENT_DATE - INTERVAL '1 day'
      WHERE id = ${plan.id}
    `;

    const result = await reconcilePaymentPlanLifecycle(sql);
    expect(result.breached).toContain(plan.id);

    const detail = await getPaymentPlanDetail(plan.id, sql);
    expect(detail).not.toBeNull();
    expect(detail!.status).toBe('breached');
  });
});

describe('payment plan reconciliation — TP-4', () => {
  test('marks a fully paid plan completed and resolves the linked case', async () => {
    const { collectionCase, invoice } = await seedCollectionCaseWithInvoice({
      customer_name: 'Completion Reconcile Co',
      amount: 1800,
    });

    const plan = await createPaymentPlan(
      {
        collection_case_id: collectionCase.id,
        total_amount: 1800,
        installment_count: 3,
        first_due_date: new Date(Date.now() + 86400 * 1000).toISOString().slice(0, 10),
      },
      sql,
    );

    await sql`
      INSERT INTO rl_payments (invoice_id, amount, received_at)
      VALUES
        (${invoice.id}, 600, NOW()),
        (${invoice.id}, 600, NOW()),
        (${invoice.id}, 600, NOW())
    `;

    const result = await reconcilePaymentPlanLifecycle(sql);
    expect(result.completed).toContain(plan.id);

    const detail = await getPaymentPlanDetail(plan.id, sql);
    expect(detail).not.toBeNull();
    expect(detail!.status).toBe('completed');

    const [caseRow] = await sql<{ status: string; resolution_type: string | null }[]>`
      SELECT status, resolution_type
      FROM rl_collection_cases
      WHERE id = ${collectionCase.id}
    `;
    expect(caseRow.status).toBe('resolved');
    expect(caseRow.resolution_type).toBe('payment_plan');
  });
});
