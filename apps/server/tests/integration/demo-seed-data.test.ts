/**
 * @file apps/server/tests/integration/demo-seed-data.test.ts
 *
 * Integration tests for seedDemoData() (issues #46, #58, #76).
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
 *   TP-10 (issue #58) Each collection case has >= 3 contact log entries.
 *
 *   TP-11 (issue #58) All three write-off approval statuses present.
 *
 *   TP-12 (issue #58) Interventions: resolved >= 5, in_progress >= 2, open >= 1.
 *
 *   TP-13 (issue #58) Health alerts at 1, 3, 7, 14 days old exist.
 *
 *   TP-14 (issue #58) KYC manual review prospects present with failed KYC records.
 *
 *   TP-16 (issue #76) Pipeline board — at least 8 deals with non-null CLTV
 *         score and tier, spread across at least 4 distinct deal stages.
 *
 *   TP-17 (issue #76) Score rationale — seeded leads have non-null rationale
 *         text in all three rationale columns.
 *
 *   TP-18 (issue #76) Finance Controller — at least one write-off approval
 *         in pending_approval state.
 *
 *   TP-19 (issue #76) Finance Controller — at least two invoices with
 *         status = overdue.
 *
 *   TP-20 (issue #76) Finance Controller — at least one payment plan in an
 *         actionable state (current or breached).
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/46
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/58
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/76
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

// ---------------------------------------------------------------------------
// TP-10 (issue #58): Contact logs — each collection case has >= 3 entries
// ---------------------------------------------------------------------------

describe('TP-10: contact logs per collection case', () => {
  test('every collection case has at least 3 contact log entries', async () => {
    const rows = await sql<{ collection_case_id: string; cnt: string }[]>`
      SELECT collection_case_id, COUNT(*)::TEXT AS cnt
      FROM rl_contact_logs
      GROUP BY collection_case_id
    `;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(
        Number(row.cnt),
        `case ${row.collection_case_id} must have >= 3 contact logs`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  test('all three contact types (call, email, portal) are used', async () => {
    const rows = await sql<{ contact_type: string }[]>`
      SELECT DISTINCT contact_type FROM rl_contact_logs
    `;
    const types = new Set(rows.map((r: { contact_type: string }) => r.contact_type));
    expect(types.has('call')).toBe(true);
    expect(types.has('email')).toBe(true);
    expect(types.has('portal')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TP-11 (issue #58): Write-off approvals — all three statuses present
// ---------------------------------------------------------------------------

describe('TP-11: write-off approvals', () => {
  test('pending_approval, approved, and rejected write-off approvals exist', async () => {
    const rows = await sql<{ status: string; cnt: string }[]>`
      SELECT status, COUNT(*)::TEXT AS cnt
      FROM rl_write_off_approvals
      GROUP BY status
    `;
    const approvalMap = new Map(
      rows.map((r: { status: string; cnt: string }) => [r.status, Number(r.cnt)]),
    );
    for (const s of ['pending_approval', 'approved', 'rejected']) {
      expect(
        approvalMap.get(s),
        `write-off approval status '${s}' must have at least one row`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  test('pending approval has no reviewed_at date', async () => {
    const rows = await sql<{ cnt: string }[]>`
      SELECT COUNT(*)::TEXT AS cnt
      FROM rl_write_off_approvals
      WHERE status = 'pending_approval' AND reviewed_at IS NULL
    `;
    expect(Number(rows[0].cnt)).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// TP-12 (issue #58): Interventions — resolved >= 5, in_progress >= 2, open >= 1
// ---------------------------------------------------------------------------

describe('TP-12: interventions', () => {
  test('at least 5 resolved interventions with outcome notes', async () => {
    const rows = await sql<{ cnt: string }[]>`
      SELECT COUNT(*)::TEXT AS cnt
      FROM rl_interventions
      WHERE status = 'resolved' AND outcome IS NOT NULL
    `;
    expect(Number(rows[0].cnt)).toBeGreaterThanOrEqual(5);
  });

  test('at least 2 in_progress interventions', async () => {
    const rows = await sql<{ cnt: string }[]>`
      SELECT COUNT(*)::TEXT AS cnt FROM rl_interventions WHERE status = 'in_progress'
    `;
    expect(Number(rows[0].cnt)).toBeGreaterThanOrEqual(2);
  });

  test('at least 1 open intervention', async () => {
    const rows = await sql<{ cnt: string }[]>`
      SELECT COUNT(*)::TEXT AS cnt FROM rl_interventions WHERE status = 'open'
    `;
    expect(Number(rows[0].cnt)).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// TP-13 (issue #58): Health alerts at 1, 3, 7, 14 days old
// ---------------------------------------------------------------------------

describe('TP-13: customer health alerts', () => {
  test('at least 4 health score records in the past 14 days (open alerts)', async () => {
    const rows = await sql<{ cnt: string }[]>`
      SELECT COUNT(*)::TEXT AS cnt
      FROM rl_customer_health_scores
      WHERE score_date >= CURRENT_DATE - INTERVAL '14 days'
    `;
    expect(Number(rows[0].cnt)).toBeGreaterThanOrEqual(4);
  });

  test('health alert exists at the 14-day age (no intervention sentinel)', async () => {
    const rows = await sql<{ cnt: string }[]>`
      SELECT COUNT(*)::TEXT AS cnt
      FROM rl_customer_health_scores
      WHERE score_date = CURRENT_DATE - INTERVAL '14 days'
    `;
    expect(Number(rows[0].cnt)).toBeGreaterThanOrEqual(1);
  });

  test('critical-score health alerts (score < 40) exist', async () => {
    const rows = await sql<{ cnt: string }[]>`
      SELECT COUNT(*)::TEXT AS cnt
      FROM rl_customer_health_scores
      WHERE score < 40
    `;
    expect(Number(rows[0].cnt)).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// TP-14 (issue #58): KYC manual review prospects with distinct failure reasons
// ---------------------------------------------------------------------------

describe('TP-14: KYC manual review', () => {
  test('at least 3 prospects are in kyc_manual_review stage', async () => {
    const rows = await sql<{ cnt: string }[]>`
      SELECT COUNT(*)::TEXT AS cnt
      FROM rl_prospects
      WHERE stage = 'kyc_manual_review'
    `;
    expect(Number(rows[0].cnt)).toBeGreaterThanOrEqual(3);
  });

  test('KYC manual review prospects have failed KYC records', async () => {
    const rows = await sql<{ cnt: string }[]>`
      SELECT COUNT(*)::TEXT AS cnt
      FROM rl_kyc_records k
      JOIN rl_prospects p ON p.id = k.prospect_id
      WHERE p.stage = 'kyc_manual_review'
        AND k.verification_status = 'failed'
    `;
    expect(Number(rows[0].cnt)).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// TP-15 (issue #58): Dunning sequences — D+1, D+7, D+14, D+30 per invoice
// ---------------------------------------------------------------------------

describe('TP-15: dunning action sequences', () => {
  test('at least one invoice has 4+ dunning actions (D+1 through D+30)', async () => {
    const rows = await sql<{ invoice_id: string; cnt: string }[]>`
      SELECT invoice_id, COUNT(*)::TEXT AS cnt
      FROM rl_dunning_actions
      GROUP BY invoice_id
      HAVING COUNT(*) >= 4
    `;
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  test('multiple dunning action types exist', async () => {
    const rows = await sql<{ action_type: string }[]>`
      SELECT DISTINCT action_type FROM rl_dunning_actions
    `;
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// TP-16 (issue #76): Pipeline board — deals with CLTV scores across stages
// ---------------------------------------------------------------------------

describe('TP-16: pipeline deals with CLTV scores and tier badges', () => {
  test('at least 8 deals are linked to prospects with a non-null CLTV score and tier', async () => {
    const rows = await sql<{ cnt: string }[]>`
      SELECT COUNT(DISTINCT d.id)::TEXT AS cnt
      FROM rl_deals d
      JOIN rl_cltv_scores cs ON cs.entity_id = d.prospect_id
        AND cs.entity_type = 'prospect'
        AND cs.tier IS NOT NULL
        AND cs.composite_score IS NOT NULL
    `;
    expect(Number(rows[0].cnt)).toBeGreaterThanOrEqual(8);
  });

  test('CLTV-scored deals span at least 4 distinct pipeline stages', async () => {
    const rows = await sql<{ stage: string }[]>`
      SELECT DISTINCT d.stage
      FROM rl_deals d
      JOIN rl_cltv_scores cs ON cs.entity_id = d.prospect_id
        AND cs.entity_type = 'prospect'
        AND cs.tier IS NOT NULL
    `;
    expect(rows.length).toBeGreaterThanOrEqual(4);
  });

  test('all four CLTV tiers (A/B/C/D) are represented among pipeline deals', async () => {
    const rows = await sql<{ tier: string }[]>`
      SELECT DISTINCT cs.tier
      FROM rl_deals d
      JOIN rl_cltv_scores cs ON cs.entity_id = d.prospect_id
        AND cs.entity_type = 'prospect'
        AND cs.tier IS NOT NULL
    `;
    const tiers = new Set(rows.map((r: { tier: string }) => r.tier));
    for (const t of ['A', 'B', 'C', 'D']) {
      expect(tiers.has(t), `tier '${t}' must appear in pipeline deals`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// TP-17 (issue #76): Score rationale text exists for seeded pipeline deals
// ---------------------------------------------------------------------------

describe('TP-17: score rationale for pipeline deals', () => {
  test('CLTV scores linked to deals have non-null rationale in all three columns', async () => {
    const rows = await sql<{ cnt: string }[]>`
      SELECT COUNT(DISTINCT cs.id)::TEXT AS cnt
      FROM rl_deals d
      JOIN rl_cltv_scores cs ON cs.entity_id = d.prospect_id
        AND cs.entity_type = 'prospect'
      WHERE cs.rationale_macro IS NOT NULL
        AND cs.rationale_industry IS NOT NULL
        AND cs.rationale_company IS NOT NULL
    `;
    expect(Number(rows[0].cnt)).toBeGreaterThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// TP-18 (issue #76): Finance Controller — pending write-off/settlement approval
// ---------------------------------------------------------------------------

describe('TP-18: Finance Controller pending write-off approvals', () => {
  test('at least one write-off approval is in pending_approval state', async () => {
    const rows = await sql<{ cnt: string }[]>`
      SELECT COUNT(*)::TEXT AS cnt
      FROM rl_write_off_approvals
      WHERE status = 'pending_approval'
    `;
    expect(Number(rows[0].cnt)).toBeGreaterThanOrEqual(1);
  });

  test('pending write-off approval has a settlement amount', async () => {
    const rows = await sql<{ cnt: string }[]>`
      SELECT COUNT(*)::TEXT AS cnt
      FROM rl_write_off_approvals
      WHERE status = 'pending_approval'
        AND settlement_amount IS NOT NULL
        AND settlement_amount > 0
    `;
    expect(Number(rows[0].cnt)).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// TP-19 (issue #76): Finance Controller — overdue invoices in AR dashboard
// ---------------------------------------------------------------------------

describe('TP-19: Finance Controller AR dashboard overdue invoices', () => {
  test('at least two invoices have status = overdue', async () => {
    const rows = await sql<{ cnt: string }[]>`
      SELECT COUNT(*)::TEXT AS cnt
      FROM rl_invoices
      WHERE status = 'overdue'
    `;
    expect(Number(rows[0].cnt)).toBeGreaterThanOrEqual(2);
  });

  test('overdue invoices have past due dates', async () => {
    const rows = await sql<{ cnt: string }[]>`
      SELECT COUNT(*)::TEXT AS cnt
      FROM rl_invoices
      WHERE status = 'overdue'
        AND due_date < CURRENT_DATE
    `;
    expect(Number(rows[0].cnt)).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// TP-20 (issue #76): Finance Controller — actionable payment plans
// ---------------------------------------------------------------------------

describe('TP-20: Finance Controller actionable payment plans', () => {
  test('at least one payment plan is in current or breached state', async () => {
    const rows = await sql<{ cnt: string }[]>`
      SELECT COUNT(*)::TEXT AS cnt
      FROM rl_payment_plans
      WHERE status IN ('current', 'breached')
    `;
    expect(Number(rows[0].cnt)).toBeGreaterThanOrEqual(1);
  });

  test('actionable payment plans have an installment amount and next due date', async () => {
    const rows = await sql<{ cnt: string }[]>`
      SELECT COUNT(*)::TEXT AS cnt
      FROM rl_payment_plans
      WHERE status IN ('current', 'breached')
        AND installment_amount IS NOT NULL
        AND next_due_date IS NOT NULL
    `;
    expect(Number(rows[0].cnt)).toBeGreaterThanOrEqual(1);
  });
});
