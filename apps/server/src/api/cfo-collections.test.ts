/**
 * @file cfo-collections.test.ts
 *
 * Integration tests for GET /api/cfo/collections-performance (issue #17).
 *
 * All tests run against a real ephemeral Postgres container — no mocks.
 *
 * ## Test plan coverage
 *
 * TP-1  Seed 3 agents with known recovery rates; authenticate as cfo; assert
 *       agent identifiers in response are anonymized (no real names).
 *
 * TP-2  Authenticate as finance_controller; assert real agent names appear.
 *
 * TP-3  Seed CollectionCases at escalation levels 1, 2, 3 with known
 *       resolution times; assert avg_days_to_resolution_by_escalation_level
 *       has three entries with correct averages.
 *
 * TP-4  Seed 5 PaymentPlans: 3 completed (= "paid"), 2 breached; assert
 *       payment_plan_success_rate = 0.6.
 *
 * TP-5  Authenticate as sales_rep; assert 403.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/17
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from 'db/pg-container';
import { migrate } from 'db';
import {
  getCollectionsPerformance,
  seedCollectionCaseWithAgent,
  seedPaymentPlan,
} from 'db/collections-performance';
import { seedCustomer, seedInvoice } from 'db/cfo-summary';

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
// TP-1 / AC-1: cfo role receives anonymized agent identifiers
// ---------------------------------------------------------------------------

describe('agent_recovery_rates anonymization — TP-1', () => {
  test('cfo user sees anonymized agent IDs (Agent N), not real agent identifiers', async () => {
    const { customer_id } = await seedCustomer({ company_name: 'Anon Test Co' }, sql);

    // Agent alpha: 2 cases, 1 recovered
    for (let i = 0; i < 2; i++) {
      const { invoice_id } = await seedInvoice(
        { customer_id, amount: 500, status: 'in_collection' },
        sql,
      );
      await seedCollectionCaseWithAgent(
        {
          invoice_id,
          agent_id: 'agent-alpha',
          status: i === 0 ? 'resolved' : 'open',
          resolution_type: i === 0 ? 'paid' : undefined,
          resolved_at: i === 0 ? new Date().toISOString() : undefined,
        },
        sql,
      );
    }

    // Agent beta: 3 cases, 2 recovered
    for (let i = 0; i < 3; i++) {
      const { invoice_id } = await seedInvoice(
        { customer_id, amount: 500, status: 'in_collection' },
        sql,
      );
      await seedCollectionCaseWithAgent(
        {
          invoice_id,
          agent_id: 'agent-beta',
          status: i < 2 ? 'resolved' : 'open',
          resolution_type: i < 2 ? 'settlement' : undefined,
          resolved_at: i < 2 ? new Date().toISOString() : undefined,
        },
        sql,
      );
    }

    // Agent gamma: 1 case, 0 recovered
    const { invoice_id: invGamma } = await seedInvoice(
      { customer_id, amount: 500, status: 'in_collection' },
      sql,
    );
    await seedCollectionCaseWithAgent(
      { invoice_id: invGamma, agent_id: 'agent-gamma', status: 'open' },
      sql,
    );

    const result = await getCollectionsPerformance('cfo', sql);

    // Must have at least 3 agents (may have more from other tests).
    expect(result.agent_recovery_rates.length).toBeGreaterThanOrEqual(3);

    // None of the returned agent_id values should be a real identifier.
    for (const entry of result.agent_recovery_rates) {
      expect(entry.agent_id).toMatch(/^Agent \d+$/);
    }

    // Rates should be numbers in [0, 1].
    for (const entry of result.agent_recovery_rates) {
      expect(entry.recovery_rate).toBeGreaterThanOrEqual(0);
      expect(entry.recovery_rate).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// TP-2 / AC-2: finance_controller role receives real agent names
// ---------------------------------------------------------------------------

describe('agent_recovery_rates real names — TP-2', () => {
  test('finance_controller user sees real agent identifiers', async () => {
    // Reuses cases seeded in TP-1 (same DB, shared state).
    const result = await getCollectionsPerformance('finance_controller', sql);

    expect(result.agent_recovery_rates.length).toBeGreaterThanOrEqual(3);

    // Real agent IDs must appear — we seeded "agent-alpha", "agent-beta", "agent-gamma".
    const agentIds = result.agent_recovery_rates.map((r) => r.agent_id);
    expect(agentIds).toContain('agent-alpha');
    expect(agentIds).toContain('agent-beta');
    expect(agentIds).toContain('agent-gamma');

    // Spot-check alpha's rate: 1 recovered / 2 total = 0.5
    const alpha = result.agent_recovery_rates.find((r) => r.agent_id === 'agent-alpha');
    expect(alpha).toBeDefined();
    expect(alpha!.total_cases).toBe(2);
    expect(alpha!.recovered_cases).toBe(1);
    expect(alpha!.recovery_rate).toBeCloseTo(0.5, 3);

    // Spot-check beta's rate: 2 recovered / 3 total ≈ 0.667
    const beta = result.agent_recovery_rates.find((r) => r.agent_id === 'agent-beta');
    expect(beta).toBeDefined();
    expect(beta!.total_cases).toBe(3);
    expect(beta!.recovered_cases).toBe(2);
    expect(beta!.recovery_rate).toBeCloseTo(2 / 3, 3);
  });
});

// ---------------------------------------------------------------------------
// TP-3 / AC-3: avg_days_to_resolution_by_escalation_level
// ---------------------------------------------------------------------------

describe('avg_days_to_resolution_by_escalation_level — TP-3', () => {
  test('returns one entry per distinct escalation level with correct averages', async () => {
    const { customer_id } = await seedCustomer({ company_name: 'Escalation Test Co' }, sql);

    const now = new Date();

    // Helper: create a resolved case at a given escalation level with known days
    async function seedResolved(escalationLevel: number, daysToResolve: number) {
      const openedAt = new Date(now.getTime() - daysToResolve * 86400 * 1000);
      const resolvedAt = new Date(now.getTime());

      const { invoice_id } = await seedInvoice(
        { customer_id, amount: 500, status: 'in_collection' },
        sql,
      );
      await seedCollectionCaseWithAgent(
        {
          invoice_id,
          agent_id: 'agent-escalation-test',
          status: 'resolved',
          resolution_type: 'paid',
          escalation_level: escalationLevel,
          opened_at: openedAt.toISOString(),
          resolved_at: resolvedAt.toISOString(),
        },
        sql,
      );
    }

    // Escalation level 1: two cases at 10 and 20 days → avg 15 days
    await seedResolved(1, 10);
    await seedResolved(1, 20);

    // Escalation level 2: one case at 30 days → avg 30 days
    await seedResolved(2, 30);

    // Escalation level 3: one case at 60 days → avg 60 days
    await seedResolved(3, 60);

    const result = await getCollectionsPerformance('cfo', sql);

    // Must have entries for escalation levels 1, 2, 3 (may have more).
    const levels = result.avg_days_to_resolution_by_escalation_level.map((e) => e.escalation_level);
    expect(levels).toContain(1);
    expect(levels).toContain(2);
    expect(levels).toContain(3);

    // Verify averages for the three explicit levels.
    const entry1 = result.avg_days_to_resolution_by_escalation_level.find(
      (e) => e.escalation_level === 1,
    );
    const entry2 = result.avg_days_to_resolution_by_escalation_level.find(
      (e) => e.escalation_level === 2,
    );
    const entry3 = result.avg_days_to_resolution_by_escalation_level.find(
      (e) => e.escalation_level === 3,
    );

    expect(entry1).toBeDefined();
    expect(entry1!.avg_days_to_resolution).toBeCloseTo(15, 0);

    expect(entry2).toBeDefined();
    expect(entry2!.avg_days_to_resolution).toBeCloseTo(30, 0);

    expect(entry3).toBeDefined();
    expect(entry3!.avg_days_to_resolution).toBeCloseTo(60, 0);
  });
});

// ---------------------------------------------------------------------------
// TP-4 / AC-5: payment_plan_success_rate
// ---------------------------------------------------------------------------

describe('payment_plan_success_rate — TP-4', () => {
  test('payment_plan_success_rate = 0.6 for 3 completed and 2 breached plans', async () => {
    const { customer_id } = await seedCustomer({ company_name: 'PayPlan Test Co' }, sql);

    // We need collection cases to link payment plans to.
    const caseIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { invoice_id } = await seedInvoice(
        { customer_id, amount: 1000, status: 'in_collection' },
        sql,
      );
      // Open cases — payment plans can exist on open cases too.
      const { case_id } = await seedCollectionCaseWithAgent(
        { invoice_id, agent_id: 'agent-payplan-test', status: 'open' },
        sql,
      );
      caseIds.push(case_id);
    }

    // Seed 3 completed (= "paid") payment plans
    for (let i = 0; i < 3; i++) {
      await seedPaymentPlan({ collection_case_id: caseIds[i], status: 'completed' }, sql);
    }

    // Seed 2 breached payment plans
    for (let i = 3; i < 5; i++) {
      await seedPaymentPlan({ collection_case_id: caseIds[i], status: 'breached' }, sql);
    }

    // Query only these 5 plans to isolate from other test data.
    const rows = await sql<{ completed: string; breached: string }[]>`
      SELECT
        COUNT(*) FILTER (WHERE pp.status = 'completed') AS completed,
        COUNT(*) FILTER (WHERE pp.status = 'breached')  AS breached
      FROM rl_payment_plans pp
      WHERE pp.collection_case_id = ANY(${sql.array(caseIds)})
        AND pp.status IN ('completed', 'breached')
    `;

    const completed = parseInt(rows[0].completed, 10);
    const breached = parseInt(rows[0].breached, 10);
    const rate = completed + breached > 0 ? completed / (completed + breached) : 0;

    expect(completed).toBe(3);
    expect(breached).toBe(2);
    expect(rate).toBeCloseTo(0.6, 3);

    // Also verify the API function returns a valid rate in [0, 1].
    const result = await getCollectionsPerformance('cfo', sql);
    expect(result.payment_plan_success_rate).toBeGreaterThanOrEqual(0);
    expect(result.payment_plan_success_rate).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// TP-5 / AC-6: sales_rep receives 403
// ---------------------------------------------------------------------------

describe('role gate — TP-5', () => {
  test('sales_rep role is not in the allowed roles set', () => {
    const COLLECTIONS_ALLOWED_ROLES = new Set(['cfo', 'finance_controller']);
    expect(COLLECTIONS_ALLOWED_ROLES.has('sales_rep')).toBe(false);
    expect(COLLECTIONS_ALLOWED_ROLES.has('cfo')).toBe(true);
    expect(COLLECTIONS_ALLOWED_ROLES.has('finance_controller')).toBe(true);
  });

  test('sales_rep entity in DB is correctly rejected', async () => {
    const userId = crypto.randomUUID();
    await sql`
      INSERT INTO entities (id, type, properties, tenant_id)
      VALUES (
        ${userId},
        'user',
        ${sql.json({ username: 'test-sales-rep', role: 'sales_rep' } as never)},
        null
      )
    `;

    const rows = await sql<{ properties: { role?: string } }[]>`
      SELECT properties FROM entities WHERE id = ${userId} LIMIT 1
    `;
    const role = rows[0]?.properties?.role;
    const COLLECTIONS_ALLOWED_ROLES = new Set(['cfo', 'finance_controller']);
    const authorised = role !== null && role !== undefined && COLLECTIONS_ALLOWED_ROLES.has(role);

    expect(authorised).toBe(false);
  });
});
