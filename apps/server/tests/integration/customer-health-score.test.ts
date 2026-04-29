/**
 * @file apps/server/tests/integration/customer-health-score.test.ts
 *
 * Integration tests for the customer health score worker (issue #54).
 *
 * No mocks — real Postgres container.  The DB functions are called directly
 * so no HTTP server is needed for these three scenarios.
 *
 * ## Test plan coverage
 *
 *   TP-3  Seed a customer with a 90-day-overdue invoice, run the score
 *         computation pipeline, verify score < 40.
 *
 *   TP-4  Seed a customer with all invoices paid on time (no overdue invoice),
 *         run the score computation pipeline, verify score > 70.
 *
 *   TP-5  Run the score computation pipeline twice on the same calendar day,
 *         verify only one health score record per customer exists.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/54
 */

import { afterAll, beforeAll, describe, test, expect } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { migrate } from 'db';
import { seedCustomer, seedInvoice } from 'db/cfo-summary';
import {
  computeHealthScoreSignals,
  computeHealthScore,
  upsertCustomerHealthScore,
  updateCustomerHealthScore,
  getLatestCustomerHealthScore,
} from 'db/customer-health-scores';

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  pg = await startPostgres();
  // Apply the full schema so tables exist before any test runs.
  await migrate({ databaseUrl: pg.url });
  sql = postgres(pg.url, { max: 5 });
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// TP-3 — customer with 90-day-overdue invoice scores below critical threshold
// ---------------------------------------------------------------------------

describe('TP-3: customer with 90-day-overdue invoice scores below critical threshold', () => {
  test('score < 40 when most recent invoice is 90 days overdue', async () => {
    const { customer_id } = await seedCustomer({ company_name: `HS-TP3-${Date.now()}` }, sql);

    // Insert an invoice with a due date 90 days in the past.
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 90);
    const dueDate = pastDate.toISOString().slice(0, 10);

    await seedInvoice({ customer_id, amount: 5000, due_date: dueDate, status: 'overdue' }, sql);

    const signals = await computeHealthScoreSignals(customer_id, sql);
    expect(signals.days_overdue).toBeGreaterThanOrEqual(88); // allow 1–2 day clock skew in CI

    const { score } = computeHealthScore(signals);
    expect(score).toBeLessThan(40);

    // Persist so rl_customers.health_score is updated — mirrors worker behaviour.
    const today = new Date().toISOString().slice(0, 10);
    const {
      score: s,
      days_overdue_signal,
      breach_count_signal,
      escalation_signal,
    } = computeHealthScore(signals);
    await upsertCustomerHealthScore(
      {
        customer_id,
        score_date: today,
        score: s,
        days_overdue_signal,
        breach_count_signal,
        escalation_signal,
        days_overdue_value: signals.days_overdue,
        breach_count_value: signals.breach_count,
        escalation_level_value: signals.escalation_level,
      },
      sql,
    );
    await updateCustomerHealthScore(customer_id, s, sql);

    const stored = await getLatestCustomerHealthScore(customer_id, sql);
    expect(stored).not.toBeNull();
    expect(stored!.score).toBeLessThan(40);

    // rl_customers.health_score is stored as a 0–1 fraction (NUMERIC 5,4).
    const [cust] = await sql<{ health_score: string }[]>`
      SELECT health_score::text FROM rl_customers WHERE id = ${customer_id}
    `;
    expect(parseFloat(cust.health_score)).toBeLessThan(0.4);
  });
});

// ---------------------------------------------------------------------------
// TP-4 — customer with no overdue invoices scores above warning threshold
// ---------------------------------------------------------------------------

describe('TP-4: customer with all invoices paid on time scores above warning threshold', () => {
  test('score > 70 when all invoices are paid and none are overdue', async () => {
    const { customer_id } = await seedCustomer({ company_name: `HS-TP4-${Date.now()}` }, sql);

    // Insert a paid invoice with a due date in the future (not overdue).
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 30);
    const dueDate = futureDate.toISOString().slice(0, 10);

    await seedInvoice({ customer_id, amount: 2000, due_date: dueDate, status: 'sent' }, sql);

    const signals = await computeHealthScoreSignals(customer_id, sql);
    expect(signals.days_overdue).toBe(0);

    const { score } = computeHealthScore(signals);
    expect(score).toBeGreaterThan(70);
  });
});

// ---------------------------------------------------------------------------
// TP-5 — idempotency: two runs on the same day produce one record
// ---------------------------------------------------------------------------

describe('TP-5: worker idempotency — two runs on the same day produce one record', () => {
  test('second upsert on the same day returns the existing record without inserting', async () => {
    const { customer_id } = await seedCustomer({ company_name: `HS-TP5-${Date.now()}` }, sql);

    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 10);
    const dueDate = pastDate.toISOString().slice(0, 10);

    await seedInvoice({ customer_id, amount: 1000, due_date: dueDate, status: 'overdue' }, sql);

    const signals = await computeHealthScoreSignals(customer_id, sql);
    const { score, days_overdue_signal, breach_count_signal, escalation_signal } =
      computeHealthScore(signals);

    const today = new Date().toISOString().slice(0, 10);
    const upsertOpts = {
      customer_id,
      score_date: today,
      score,
      days_overdue_signal,
      breach_count_signal,
      escalation_signal,
      days_overdue_value: signals.days_overdue,
      breach_count_value: signals.breach_count,
      escalation_level_value: signals.escalation_level,
    };

    // First run.
    const first = await upsertCustomerHealthScore(upsertOpts, sql);
    // Second run — must return the same record.
    const second = await upsertCustomerHealthScore(upsertOpts, sql);

    expect(first.id).toBe(second.id);
    expect(first.score_date).toBe(second.score_date);

    // Confirm exactly one record exists in the table for this customer + date.
    const [{ count }] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM rl_customer_health_scores
      WHERE customer_id = ${customer_id}
        AND score_date = ${today}::date
    `;
    expect(Number(count)).toBe(1);
  });
});
