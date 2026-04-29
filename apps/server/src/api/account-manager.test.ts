/**
 * @file account-manager.test.ts
 *
 * Integration tests for the Account Manager customer health dashboard API
 * (issue #55).
 *
 * All tests run against a real ephemeral Postgres container — no mocks.
 *
 * ## Test plan coverage
 *
 * TP-1  Unit: GET /api/account-manager/customers returns only customers where
 *             account_manager_id matches the logged-in user.
 * TP-2  Unit: alert age is computed as the number of days since health_score
 *             first dropped below warning threshold with no intervention.
 * TP-3  Integration: seed customers with varying scores, verify dashboard order
 *             is ascending by health score.
 * TP-4  Integration: seed a customer with a 5-day-old health alert and no
 *             interventions, verify alert_days >= 5.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/55
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from 'db/pg-container';
import { migrate } from 'db';
import {
  listCustomersForAccountManager,
  getCustomerHealthDetail,
  HEALTH_ALERT_THRESHOLD,
} from 'db/account-manager-customers';

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 5 });
  await migrate({ databaseUrl: pg.url });
}, 60_000);

afterAll(async () => {
  await sql.end({ timeout: 5 });
  await pg.stop();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedCustomer(opts: {
  company_name: string;
  health_score: number | null;
  account_manager_id: string;
}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO rl_customers (company_name, health_score, account_manager_id)
    VALUES (${opts.company_name}, ${opts.health_score}, ${opts.account_manager_id})
    RETURNING id
  `;
  return row.id;
}

async function seedHealthSnapshot(opts: {
  customer_id: string;
  score: number;
  recorded_at: string;
}): Promise<void> {
  await sql`
    INSERT INTO rl_health_score_history (customer_id, score, recorded_at)
    VALUES (${opts.customer_id}, ${opts.score}, ${opts.recorded_at})
  `;
}

async function seedSignal(opts: {
  customer_id: string;
  source_label: string;
  contribution: number;
}): Promise<void> {
  await sql`
    INSERT INTO rl_health_signals (customer_id, source_label, contribution)
    VALUES (${opts.customer_id}, ${opts.source_label}, ${opts.contribution})
  `;
}

// ---------------------------------------------------------------------------
// TP-1: only customers for the logged-in AM are returned
// ---------------------------------------------------------------------------

describe('listCustomersForAccountManager — TP-1', () => {
  test('returns only customers assigned to the given account_manager_id', async () => {
    const amA = 'am-test-tp1-a';
    const amB = 'am-test-tp1-b';

    const idA1 = await seedCustomer({
      company_name: 'TP1 Corp A1',
      health_score: 0.8,
      account_manager_id: amA,
    });
    const idA2 = await seedCustomer({
      company_name: 'TP1 Corp A2',
      health_score: 0.6,
      account_manager_id: amA,
    });
    await seedCustomer({ company_name: 'TP1 Corp B1', health_score: 0.9, account_manager_id: amB });

    const rows = await listCustomersForAccountManager(amA, sql);
    const ids = rows.map((r) => r.id);

    expect(ids).toContain(idA1);
    expect(ids).toContain(idA2);
    expect(ids.every((id) => [idA1, idA2].includes(id))).toBe(true);
  });

  test('returns empty list when AM has no customers', async () => {
    const rows = await listCustomersForAccountManager('am-no-customers-xyz', sql);
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TP-2: alert age computation
// ---------------------------------------------------------------------------

describe('alert age computation — TP-2', () => {
  test('alert_days reflects days since score first dropped below threshold with no intervention', async () => {
    const amId = 'am-test-tp2-alert';
    const customerId = await seedCustomer({
      company_name: 'Alert Age Test Co',
      health_score: 0.55,
      account_manager_id: amId,
    });

    // Seed a snapshot 5 days ago below threshold.
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
    await seedHealthSnapshot({ customer_id: customerId, score: 0.55, recorded_at: fiveDaysAgo });

    // Also seed the current score.
    await seedHealthSnapshot({
      customer_id: customerId,
      score: 0.55,
      recorded_at: new Date().toISOString(),
    });

    const rows = await listCustomersForAccountManager(amId, sql);
    const row = rows.find((r) => r.id === customerId);
    expect(row).toBeDefined();
    expect(row!.has_alert).toBe(true);
    expect(row!.alert_days).toBeGreaterThanOrEqual(5);
  });

  test('alert_days is null when customer has healthy score', async () => {
    const amId = 'am-test-tp2-healthy';
    const customerId = await seedCustomer({
      company_name: 'Healthy Co',
      health_score: 0.9,
      account_manager_id: amId,
    });

    const rows = await listCustomersForAccountManager(amId, sql);
    const row = rows.find((r) => r.id === customerId);
    expect(row).toBeDefined();
    expect(row!.has_alert).toBe(false);
    expect(row!.alert_days).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TP-3: dashboard order is ascending by health score
// ---------------------------------------------------------------------------

describe('listCustomersForAccountManager order — TP-3', () => {
  test('customers are returned sorted by health_score ascending', async () => {
    const amId = 'am-test-tp3-order';

    await seedCustomer({
      company_name: 'Order High',
      health_score: 0.95,
      account_manager_id: amId,
    });
    await seedCustomer({ company_name: 'Order Mid', health_score: 0.7, account_manager_id: amId });
    await seedCustomer({ company_name: 'Order Low', health_score: 0.3, account_manager_id: amId });

    const rows = await listCustomersForAccountManager(amId, sql);
    const scores = rows.map((r) => r.health_score as number);

    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
    }
  });
});

// ---------------------------------------------------------------------------
// TP-4: seed customer with 5-day alert and no interventions → alert_days >= 5
// ---------------------------------------------------------------------------

describe('getCustomerHealthDetail — TP-4', () => {
  test('detail includes signals and score history', async () => {
    const amId = 'am-test-tp4-detail';
    const customerId = await seedCustomer({
      company_name: 'Detail Test Corp',
      health_score: 0.6,
      account_manager_id: amId,
    });

    await seedSignal({
      customer_id: customerId,
      source_label: 'payment_timeliness',
      contribution: -0.2,
    });
    await seedSignal({ customer_id: customerId, source_label: 'usage', contribution: 0.1 });

    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
    const oneDayAgo = new Date(Date.now() - 1 * 24 * 3600 * 1000).toISOString();
    await seedHealthSnapshot({ customer_id: customerId, score: 0.65, recorded_at: twoDaysAgo });
    await seedHealthSnapshot({ customer_id: customerId, score: 0.6, recorded_at: oneDayAgo });

    const detail = await getCustomerHealthDetail(customerId, amId, sql);
    expect(detail).not.toBeNull();
    expect(detail!.signals).toHaveLength(2);
    expect(detail!.signals.map((s) => s.source_label)).toContain('payment_timeliness');
    expect(detail!.score_history.length).toBeGreaterThanOrEqual(2);
  });

  test('returns null for a customer not assigned to the given AM', async () => {
    const amId = 'am-test-tp4-other';
    const customerId = await seedCustomer({
      company_name: 'Other AM Corp',
      health_score: 0.7,
      account_manager_id: 'am-test-tp4-owner',
    });

    const detail = await getCustomerHealthDetail(customerId, amId, sql);
    expect(detail).toBeNull();
  });

  test('HEALTH_ALERT_THRESHOLD is 0.7', () => {
    expect(HEALTH_ALERT_THRESHOLD).toBe(0.7);
  });
});
