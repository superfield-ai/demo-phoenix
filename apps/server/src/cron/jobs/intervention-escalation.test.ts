/**
 * @file cron/jobs/intervention-escalation.test.ts
 *
 * Unit tests for the intervention escalation cron job (issue #56).
 *
 * These tests cover pure logic helpers without database or scheduler
 * infrastructure.
 *
 * ## Test plan coverage
 *
 * TP-unit-1  readEscalationDays returns DEFAULT_ESCALATION_DAYS when env is unset.
 * TP-unit-2  readEscalationDays parses INTERVENTION_ESCALATION_DAYS correctly.
 * TP-unit-3  readEscalationDays falls back to default for invalid values.
 * TP-unit-4  processEscalationCandidates skips when no team lead exists.
 * TP-unit-5  Integration: seed open intervention aged >= N days, run scan,
 *            verify escalation notification is created for team lead.
 * TP-unit-6  Integration: seed intervention aged < N days, verify no escalation.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/56
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from 'db/pg-container';
import { migrate } from 'db';
import {
  readEscalationDays,
  DEFAULT_ESCALATION_DAYS,
  processEscalationCandidates,
} from './intervention-escalation';
import { listAlertsNeedingEscalation, createEscalationNotification } from 'db/interventions';

// ---------------------------------------------------------------------------
// Test container lifecycle
// ---------------------------------------------------------------------------

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
// Helpers
// ---------------------------------------------------------------------------

async function insertCustomer(
  db: ReturnType<typeof postgres>,
  opts: { company_name?: string; account_manager_id?: string } = {},
): Promise<string> {
  const [row] = await db<{ id: string }[]>`
    INSERT INTO rl_customers (company_name, account_manager_id)
    VALUES (${opts.company_name ?? `Escalation Co ${crypto.randomUUID()}`}, ${opts.account_manager_id ?? null})
    RETURNING id
  `;
  return row.id;
}

async function insertUserEntity(
  db: ReturnType<typeof postgres>,
  role: string = 'account_manager',
): Promise<string> {
  const [row] = await db<{ id: string }[]>`
    INSERT INTO entities (id, type, properties)
    VALUES (
      gen_random_uuid()::TEXT,
      'user',
      ${db.json({ role, username: `user-${crypto.randomUUID()}` })}
    )
    RETURNING id
  `;
  return row.id;
}

async function insertIntervention(
  db: ReturnType<typeof postgres>,
  opts: {
    customer_id: string;
    status?: string;
    assigned_to?: string;
    created_at?: string;
  },
): Promise<string> {
  const { customer_id, status = 'open', assigned_to = null, created_at } = opts;
  const [row] = await db<{ id: string }[]>`
    INSERT INTO rl_interventions
      (customer_id, trigger_type, playbook, assigned_to, status, created_at)
    VALUES (
      ${customer_id},
      'manual',
      'success_call',
      ${assigned_to},
      ${status},
      ${created_at ? db.unsafe(`'${created_at}'::timestamptz`) : db.unsafe('NOW()')}
    )
    RETURNING id
  `;
  return row.id;
}

// ---------------------------------------------------------------------------
// TP-unit-1: readEscalationDays default
// ---------------------------------------------------------------------------

describe('readEscalationDays', () => {
  test('TP-unit-1: returns DEFAULT_ESCALATION_DAYS when env var is not set', () => {
    const days = readEscalationDays({});
    expect(days).toBe(DEFAULT_ESCALATION_DAYS);
  });

  test('TP-unit-2: parses INTERVENTION_ESCALATION_DAYS from env', () => {
    const days = readEscalationDays({ INTERVENTION_ESCALATION_DAYS: '7' });
    expect(days).toBe(7);
  });

  test('TP-unit-3: falls back to DEFAULT_ESCALATION_DAYS for non-numeric value', () => {
    const days = readEscalationDays({ INTERVENTION_ESCALATION_DAYS: 'abc' });
    expect(days).toBe(DEFAULT_ESCALATION_DAYS);
  });

  test('TP-unit-3b: falls back for zero or negative values', () => {
    expect(readEscalationDays({ INTERVENTION_ESCALATION_DAYS: '0' })).toBe(DEFAULT_ESCALATION_DAYS);
    expect(readEscalationDays({ INTERVENTION_ESCALATION_DAYS: '-1' })).toBe(
      DEFAULT_ESCALATION_DAYS,
    );
  });
});

// ---------------------------------------------------------------------------
// TP-unit-4: processEscalationCandidates skips when no team lead exists
// ---------------------------------------------------------------------------

describe('processEscalationCandidates — no team lead', () => {
  test('TP-unit-4: returns 0 created when no team_lead user exists', async () => {
    const customerId = await insertCustomer(sql, { company_name: 'NoTeamLead Co' });
    const candidates = [
      { intervention_id: crypto.randomUUID(), customer_id: customerId, days_open: 5 },
    ];

    // We inject sql so the function uses our test DB.
    // Since no team_lead user is seeded, it should skip and return 0.
    const created = await processEscalationCandidates(candidates, sql);
    expect(created).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TP-unit-5: Integration — escalation created for stale open intervention
// ---------------------------------------------------------------------------

describe('listAlertsNeedingEscalation — integration', () => {
  test('TP-unit-5: detects intervention open >= N days with no other active intervention', async () => {
    const customerId = await insertCustomer(sql, { company_name: 'Stale Alert Co' });

    // Insert an intervention created 4 days ago.
    const interventionId = await insertIntervention(sql, {
      customer_id: customerId,
      status: 'open',
      created_at: new Date(Date.now() - 4 * 86400 * 1000).toISOString(),
    });

    const candidates = await listAlertsNeedingEscalation(3, sql);
    const found = candidates.find((c) => c.intervention_id === interventionId);
    expect(found).toBeDefined();
    expect(found!.days_open).toBeGreaterThanOrEqual(3);
  });

  test('TP-unit-6: does not flag intervention open < N days', async () => {
    const customerId = await insertCustomer(sql, { company_name: 'Fresh Alert Co' });

    // Insert an intervention created 1 day ago.
    const interventionId = await insertIntervention(sql, {
      customer_id: customerId,
      status: 'open',
      created_at: new Date(Date.now() - 1 * 86400 * 1000).toISOString(),
    });

    const candidates = await listAlertsNeedingEscalation(3, sql);
    const found = candidates.find((c) => c.intervention_id === interventionId);
    expect(found).toBeUndefined();
  });

  test('escalation notification is idempotent on repeated inserts', async () => {
    const customerId = await insertCustomer(sql, { company_name: 'Idempotent Co' });
    const amId = await insertUserEntity(sql, 'account_manager');
    const teamLeadId = await insertUserEntity(sql, 'team_lead');

    const interventionId = await insertIntervention(sql, {
      customer_id: customerId,
      assigned_to: amId,
      created_at: new Date(Date.now() - 5 * 86400 * 1000).toISOString(),
    });

    // Create escalation twice — should not throw.
    const first = await createEscalationNotification(
      {
        intervention_id: interventionId,
        customer_id: customerId,
        notified_user_id: teamLeadId,
        days_open: 5,
      },
      sql,
    );
    const second = await createEscalationNotification(
      {
        intervention_id: interventionId,
        customer_id: customerId,
        notified_user_id: teamLeadId,
        days_open: 6,
      },
      sql,
    );

    // Both should resolve to the same id; days_open updated on conflict.
    expect(first.id).toBe(second.id);
    expect(second.days_open).toBe(6);
  });
});
