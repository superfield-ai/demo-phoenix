/**
 * @file apps/server/tests/integration/demo-seed-data.test.ts
 *
 * Integration tests for seedDemoData() (issue #46).
 *
 * No mocks — real Postgres container + real migrate/seed functions.
 *
 * ## Test plan coverage
 *
 *   TP-1  Run seedDemoData() against a freshly migrated database; assert exit 0
 *         (no exception thrown).
 *
 *   TP-2  Run seedDemoData() twice; assert row counts are identical
 *         (idempotency).
 *
 *   TP-3  Query rl_prospects grouped by stage; assert all six stages have at
 *         least one row.
 *
 *   TP-4  Query rl_cltv_scores grouped by tier; assert all four tiers (A/B/C/D)
 *         are present.
 *
 *   TP-5  Query rl_invoices grouped by status; assert all eight invoice_status
 *         values are present.
 *
 *   TP-6  Query rl_payment_plans grouped by status; assert all four statuses
 *         (current, breached, completed, cancelled) are present.
 *
 *   TP-7  Query rl_invoices WHERE due_date < CURRENT_DATE - INTERVAL '120 days';
 *         assert at least one row.
 *
 *   TP-8  Query rl_notifications WHERE read_at IS NULL; assert at least 3 rows.
 *
 *   TP-9  Query rl_customers WHERE health_score < 0.4; assert at least one row.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/46
 */

import { afterAll, beforeAll, describe, test, expect } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { migrate } from '../../../../packages/db';
import { seedDemoUsers } from '../../src/seed/demo-users';
import { seedDemoData } from '../../src/seed/demo-data';

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;

// IDs needed to satisfy FK constraints: we need a real sales_rep user so
// seedDemoData can wire assigned_rep_id. We call seedDemoUsers() first.

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 5 });

  // Migrate so all rl_* tables exist.
  await migrate({ databaseUrl: pg.url });

  // Seed demo users (sales_rep, cfo, collections_agent, etc.)
  process.env.DEMO_MODE = 'true';
  process.env.DATABASE_URL = pg.url;
  await seedDemoUsers({ sql: sql as never });

  // TP-1: first run must complete without error
  await seedDemoData({ sql: sql as never });
}, 120_000);

afterAll(async () => {
  delete process.env.DEMO_MODE;
  await sql?.end({ timeout: 5 });
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// TP-1 is covered by the beforeAll not throwing — verified by the suite passing.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// TP-2: idempotency — second run produces same row counts
// ---------------------------------------------------------------------------

describe('TP-2: idempotency', () => {
  test('running seedDemoData() twice produces identical row counts', async () => {
    const countBefore = await sql<{ cnt: string }[]>`
      SELECT COUNT(*)::TEXT AS cnt FROM rl_prospects
    `;
    const notifBefore = await sql<{ cnt: string }[]>`
      SELECT COUNT(*)::TEXT AS cnt FROM rl_notifications
    `;

    // Second run
    await seedDemoData({ sql: sql as never });

    const countAfter = await sql<{ cnt: string }[]>`
      SELECT COUNT(*)::TEXT AS cnt FROM rl_prospects
    `;
    const notifAfter = await sql<{ cnt: string }[]>`
      SELECT COUNT(*)::TEXT AS cnt FROM rl_notifications
    `;

    expect(countAfter[0].cnt).toBe(countBefore[0].cnt);
    expect(notifAfter[0].cnt).toBe(notifBefore[0].cnt);
  });
});

// ---------------------------------------------------------------------------
// TP-3: all six prospect stages present
// ---------------------------------------------------------------------------

describe('TP-3: all prospect stages present', () => {
  test('all six stages have at least one prospect', async () => {
    const rows = await sql<{ stage: string; cnt: string }[]>`
      SELECT stage, COUNT(*)::TEXT AS cnt
      FROM rl_prospects
      GROUP BY stage
    `;

    const stageMap = new Map(
      rows.map((r: { stage: string; cnt: string }) => [r.stage, Number(r.cnt)]),
    );

    const EXPECTED_STAGES = [
      'new',
      'kyc_pending',
      'kyc_manual_review',
      'scored',
      'qualified',
      'disqualified',
    ];
    for (const stage of EXPECTED_STAGES) {
      expect(
        stageMap.get(stage),
        `stage '${stage}' must have at least one prospect`,
      ).toBeGreaterThanOrEqual(1);
    }

    // Acceptance criterion: at least 5 disqualified
    expect(stageMap.get('disqualified')).toBeGreaterThanOrEqual(5);
  });

  test('total prospects >= 50', async () => {
    const rows = await sql<{ cnt: string }[]>`SELECT COUNT(*)::TEXT AS cnt FROM rl_prospects`;
    expect(Number(rows[0].cnt)).toBeGreaterThanOrEqual(50);
  });
});

// ---------------------------------------------------------------------------
// TP-4: all four CLTV tiers present
// ---------------------------------------------------------------------------

describe('TP-4: all CLTV tiers present', () => {
  test('tiers A, B, C, D all have at least one score row', async () => {
    const rows = await sql<{ tier: string; cnt: string }[]>`
      SELECT tier, COUNT(*)::TEXT AS cnt
      FROM rl_cltv_scores
      WHERE tier IS NOT NULL
      GROUP BY tier
    `;

    const tierMap = new Map(
      rows.map((r: { tier: string; cnt: string }) => [r.tier, Number(r.cnt)]),
    );
    for (const tier of ['A', 'B', 'C', 'D']) {
      expect(
        tierMap.get(tier),
        `tier '${tier}' must have at least one CLTV score`,
      ).toBeGreaterThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// TP-5: all eight invoice_status values present
// ---------------------------------------------------------------------------

describe('TP-5: all invoice statuses present', () => {
  test('all eight invoice_status values have at least one invoice', async () => {
    const rows = await sql<{ status: string; cnt: string }[]>`
      SELECT status::TEXT, COUNT(*)::TEXT AS cnt
      FROM rl_invoices
      GROUP BY status
    `;

    const statusMap = new Map(
      rows.map((r: { status: string; cnt: string }) => [r.status, Number(r.cnt)]),
    );
    const EXPECTED_STATUSES = [
      'draft',
      'sent',
      'partial_paid',
      'overdue',
      'in_collection',
      'paid',
      'settled',
      'written_off',
    ];
    for (const s of EXPECTED_STATUSES) {
      expect(
        statusMap.get(s),
        `invoice status '${s}' must have at least one row`,
      ).toBeGreaterThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// TP-6: all four payment plan statuses present
// ---------------------------------------------------------------------------

describe('TP-6: all payment plan statuses present', () => {
  test('current, breached, completed, and cancelled plans all exist', async () => {
    const rows = await sql<{ status: string; cnt: string }[]>`
      SELECT status, COUNT(*)::TEXT AS cnt
      FROM rl_payment_plans
      GROUP BY status
    `;

    const planMap = new Map(
      rows.map((r: { status: string; cnt: string }) => [r.status, Number(r.cnt)]),
    );
    for (const s of ['current', 'breached', 'completed', 'cancelled']) {
      expect(
        planMap.get(s),
        `payment plan status '${s}' must have at least one row`,
      ).toBeGreaterThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// TP-7: at least one invoice more than 120 days overdue
// ---------------------------------------------------------------------------

describe('TP-7: 120+ day overdue invoices exist', () => {
  test('at least one invoice has due_date < CURRENT_DATE - 120 days', async () => {
    const rows = await sql<{ cnt: string }[]>`
      SELECT COUNT(*)::TEXT AS cnt
      FROM rl_invoices
      WHERE due_date < CURRENT_DATE - INTERVAL '120 days'
    `;
    expect(Number(rows[0].cnt)).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// TP-8: at least 3 unread notifications for the demo sales rep
// ---------------------------------------------------------------------------

describe('TP-8: unread notifications for sales rep', () => {
  test('at least 3 unread notifications exist', async () => {
    const rows = await sql<{ cnt: string }[]>`
      SELECT COUNT(*)::TEXT AS cnt
      FROM rl_notifications
      WHERE read_at IS NULL
    `;
    expect(Number(rows[0].cnt)).toBeGreaterThanOrEqual(3);
  });

  test('both new_lead and score_drop event types are represented', async () => {
    const rows = await sql<{ event_type: string }[]>`
      SELECT DISTINCT event_type FROM rl_notifications
    `;
    const types = new Set(rows.map((r: { event_type: string }) => r.event_type));
    expect(types.has('new_lead')).toBe(true);
    expect(types.has('score_drop')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TP-9: at least one churned customer (health_score < 0.4)
// ---------------------------------------------------------------------------

describe('TP-9: churned customers exist', () => {
  test('at least one customer with health_score < 0.4', async () => {
    const rows = await sql<{ cnt: string }[]>`
      SELECT COUNT(*)::TEXT AS cnt
      FROM rl_customers
      WHERE health_score < 0.4
    `;
    expect(Number(rows[0].cnt)).toBeGreaterThanOrEqual(1);
  });

  test('healthy customers (>= 0.75) also exist', async () => {
    const rows = await sql<{ cnt: string }[]>`
      SELECT COUNT(*)::TEXT AS cnt
      FROM rl_customers
      WHERE health_score >= 0.75
    `;
    expect(Number(rows[0].cnt)).toBeGreaterThanOrEqual(1);
  });

  test('at-risk customers (0.40-0.74) also exist', async () => {
    const rows = await sql<{ cnt: string }[]>`
      SELECT COUNT(*)::TEXT AS cnt
      FROM rl_customers
      WHERE health_score >= 0.4 AND health_score < 0.75
    `;
    expect(Number(rows[0].cnt)).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// AR aging buckets coverage
// ---------------------------------------------------------------------------

describe('AR aging buckets', () => {
  test('invoices exist in the 30-60 day overdue bucket', async () => {
    const rows = await sql<{ cnt: string }[]>`
      SELECT COUNT(*)::TEXT AS cnt
      FROM rl_invoices
      WHERE due_date < CURRENT_DATE - INTERVAL '30 days'
        AND due_date >= CURRENT_DATE - INTERVAL '60 days'
    `;
    expect(Number(rows[0].cnt)).toBeGreaterThanOrEqual(1);
  });

  test('invoices exist in the 60-90 day overdue bucket', async () => {
    const rows = await sql<{ cnt: string }[]>`
      SELECT COUNT(*)::TEXT AS cnt
      FROM rl_invoices
      WHERE due_date < CURRENT_DATE - INTERVAL '60 days'
        AND due_date >= CURRENT_DATE - INTERVAL '90 days'
    `;
    expect(Number(rows[0].cnt)).toBeGreaterThanOrEqual(1);
  });

  test('invoices exist in the 90-120 day overdue bucket', async () => {
    const rows = await sql<{ cnt: string }[]>`
      SELECT COUNT(*)::TEXT AS cnt
      FROM rl_invoices
      WHERE due_date < CURRENT_DATE - INTERVAL '90 days'
        AND due_date >= CURRENT_DATE - INTERVAL '120 days'
    `;
    expect(Number(rows[0].cnt)).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Collection cases coverage
// ---------------------------------------------------------------------------

describe('collection cases', () => {
  test('all four collection case statuses present', async () => {
    const rows = await sql<{ status: string; cnt: string }[]>`
      SELECT status, COUNT(*)::TEXT AS cnt
      FROM rl_collection_cases
      GROUP BY status
    `;
    const caseMap = new Map(
      rows.map((r: { status: string; cnt: string }) => [r.status, Number(r.cnt)]),
    );
    for (const s of ['open', 'resolved', 'escalated', 'written_off']) {
      expect(
        caseMap.get(s),
        `collection case status '${s}' must have at least one row`,
      ).toBeGreaterThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Macro indicators
// ---------------------------------------------------------------------------

describe('macro indicators', () => {
  test('at least 6 distinct quarters of macro indicator data exist', async () => {
    const rows = await sql<{ cnt: string }[]>`
      SELECT COUNT(DISTINCT DATE_TRUNC('quarter', effective_date))::TEXT AS cnt
      FROM rl_macro_indicators
    `;
    expect(Number(rows[0].cnt)).toBeGreaterThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// All company names are obviously fictional
// ---------------------------------------------------------------------------

describe('fictional data', () => {
  test('no prospect company_name matches a known real company', async () => {
    // Spot-check: real company names that must NOT appear in demo data.
    const realNames = ['Apple Inc', 'Google LLC', 'Microsoft Corporation', 'Amazon.com'];
    const rows = await sql<{ company_name: string }[]>`
      SELECT company_name FROM rl_prospects
    `;
    const names = rows.map((r: { company_name: string }) => r.company_name);
    for (const real of realNames) {
      expect(names).not.toContain(real);
    }
  });
});
