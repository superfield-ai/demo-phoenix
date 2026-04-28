/**
 * Integration tests for the Sales Rep lead queue endpoints (Phase 1, P1-1).
 *
 * Test plan items covered:
 *   TP-1: Seed 20 qualified Prospects for rep A and 5 for rep B; authenticate
 *         as rep A; assert GET /api/leads/queue returns exactly 20 rows, all
 *         assigned to rep A.
 *   TP-2: Assert the first row has the highest composite_score of all 20 rows.
 *   TP-3: Apply filter[tier]=A; assert all returned rows have tier=A.
 *   TP-4: Apply sort=days; assert rows are ordered by days_in_queue descending.
 *   TP-5: Seed 3 disqualified Prospects; call GET /api/leads/disqualified;
 *         assert 3 rows with disqualification_reason populated.
 *   TP-6: Seed 0 qualified Prospects and 4 pending-KYC Prospects; load the
 *         queue; assert the empty-state message references '4 prospects pending KYC'.
 *
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/7
 */

import { test, expect, beforeAll, afterAll } from 'vitest';
import type { Subprocess } from 'bun';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { createTestSession } from '../helpers/test-session';
import postgres from 'postgres';
import { seedProspect } from 'db/leads-queue';

const PORT = 31485;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 30_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let server: Subprocess;
let repACookie = '';
let repAId = '';
let repBId = '';
let testSql: postgres.Sql;

beforeAll(async () => {
  pg = await startPostgres();

  server = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      AUDIT_DATABASE_URL: pg.url,
      PORT: String(PORT),
      TEST_MODE: 'true',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  await waitForServer(BASE);

  // Create two test sessions (rep A and rep B).
  const sessionA = await createTestSession(BASE, { username: 'rep-a', role: 'sales_rep' });
  repACookie = sessionA.cookie;
  repAId = sessionA.userId;

  const sessionB = await createTestSession(BASE, { username: 'rep-b', role: 'sales_rep' });
  repBId = sessionB.userId;

  // Open a direct DB connection for seed operations.
  testSql = postgres(pg.url, { max: 1 });

  // ── Seed 20 qualified prospects for rep A with distinct scores ──────────
  // Scores are distributed so that roughly a third are tier A (≥0.7),
  // a third are tier B (0.4-0.7), and a third are tier C (<0.4).
  // We use increments of 0.04 starting from 0.90 down to 0.14.
  for (let i = 0; i < 20; i++) {
    const score = parseFloat((0.9 - i * 0.04).toFixed(4));
    await seedProspect(
      {
        company_name: `Company A-${i}`,
        industry: i % 2 === 0 ? 'Technology' : 'Finance',
        sic_code: `73${i.toString().padStart(2, '0')}`,
        stage: 'qualified',
        assigned_rep_id: repAId,
        composite_score: score,
      },
      testSql,
    );
  }

  // ── Seed 5 qualified prospects for rep B ────────────────────────────────
  for (let i = 0; i < 5; i++) {
    await seedProspect(
      {
        company_name: `Company B-${i}`,
        stage: 'qualified',
        assigned_rep_id: repBId,
        composite_score: 0.8,
      },
      testSql,
    );
  }

  // ── Seed 3 disqualified prospects for rep A with reasons ────────────────
  await seedProspect(
    {
      company_name: 'Disq-1',
      stage: 'disqualified',
      assigned_rep_id: repAId,
      disqualification_reason: 'KYC failed — fraudulent documents',
    },
    testSql,
  );
  await seedProspect(
    {
      company_name: 'Disq-2',
      stage: 'disqualified',
      assigned_rep_id: repAId,
      disqualification_reason: 'Score below threshold',
    },
    testSql,
  );
  await seedProspect(
    {
      company_name: 'Disq-3',
      stage: 'disqualified',
      assigned_rep_id: repAId,
      disqualification_reason: 'Duplicate lead',
    },
    testSql,
  );

  // ── Seed 4 pending-KYC prospects for rep A ──────────────────────────────
  for (let i = 0; i < 4; i++) {
    await seedProspect(
      { company_name: `PendingKYC-${i}`, stage: 'kyc_pending', assigned_rep_id: repAId },
      testSql,
    );
  }
}, 90_000);

afterAll(async () => {
  await testSql?.end();
  server?.kill();
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// TP-1: rep A sees exactly 20 qualified leads, all assigned to themselves
// ---------------------------------------------------------------------------

test('GET /api/leads/queue returns exactly 20 rows for rep A, all assigned to rep A', async () => {
  const res = await fetch(`${BASE}/api/leads/queue`, {
    headers: { Cookie: repACookie },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { leads: Array<{ assigned_rep_id: string }> };
  expect(body.leads).toHaveLength(20);
  for (const lead of body.leads) {
    expect(lead.assigned_rep_id).toBe(repAId);
  }
});

// ---------------------------------------------------------------------------
// TP-2: first row has the highest composite_score
// ---------------------------------------------------------------------------

test('first row in the queue has the highest composite_score', async () => {
  const res = await fetch(`${BASE}/api/leads/queue`, {
    headers: { Cookie: repACookie },
  });
  const body = (await res.json()) as { leads: Array<{ composite_score: number }> };
  const scores = body.leads.map((l) => l.composite_score);
  const maxScore = Math.max(...scores);
  expect(scores[0]).toBe(maxScore);
});

// ---------------------------------------------------------------------------
// TP-3: filter[tier]=A returns only tier-A leads
// ---------------------------------------------------------------------------

test('filter[tier]=A returns only tier-A leads', async () => {
  const res = await fetch(`${BASE}/api/leads/queue?filter[tier]=A`, {
    headers: { Cookie: repACookie },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { leads: Array<{ score_tier: string }> };
  expect(body.leads.length).toBeGreaterThan(0);
  for (const lead of body.leads) {
    expect(lead.score_tier).toBe('A');
  }
});

// ---------------------------------------------------------------------------
// TP-4: sort=days returns leads ordered by days_in_queue descending
// ---------------------------------------------------------------------------

test('sort=days returns leads ordered by days_in_queue descending', async () => {
  const res = await fetch(`${BASE}/api/leads/queue?sort=days`, {
    headers: { Cookie: repACookie },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { leads: Array<{ days_in_queue: number }> };
  const days = body.leads.map((l) => l.days_in_queue);
  for (let i = 1; i < days.length; i++) {
    expect(days[i]).toBeLessThanOrEqual(days[i - 1]!);
  }
});

// ---------------------------------------------------------------------------
// TP-5: disqualified endpoint returns 3 rows with reasons
// ---------------------------------------------------------------------------

test('GET /api/leads/disqualified returns 3 rows with disqualification_reason', async () => {
  const res = await fetch(`${BASE}/api/leads/disqualified`, {
    headers: { Cookie: repACookie },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { leads: Array<{ disqualification_reason: string | null }> };
  expect(body.leads).toHaveLength(3);
  for (const lead of body.leads) {
    expect(lead.disqualification_reason).toBeTruthy();
  }
});

// ---------------------------------------------------------------------------
// TP-6: empty queue carries pending_kyc_count = 4
// ---------------------------------------------------------------------------

test('queue response includes pending_kyc_count of 4 when no qualified leads exist', async () => {
  // Create a brand-new rep with no qualified leads but 4 pending-KYC ones.
  const newRepSession = await createTestSession(BASE, {
    username: `rep-empty-${Date.now()}`,
    role: 'sales_rep',
  });
  const newRepId = newRepSession.userId;

  // Seed 4 pending-KYC prospects for this rep.
  for (let i = 0; i < 4; i++) {
    await seedProspect(
      { company_name: `EmptyRepKYC-${i}`, stage: 'kyc_pending', assigned_rep_id: newRepId },
      testSql,
    );
  }

  const res = await fetch(`${BASE}/api/leads/queue`, {
    headers: { Cookie: newRepSession.cookie },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { leads: unknown[]; pending_kyc_count: number };
  expect(body.leads).toHaveLength(0);
  expect(body.pending_kyc_count).toBe(4);
});

// ---------------------------------------------------------------------------
// Security: rep cannot see another rep's leads
// ---------------------------------------------------------------------------

test('rep A cannot see rep B leads — only their own are returned', async () => {
  const res = await fetch(`${BASE}/api/leads/queue`, {
    headers: { Cookie: repACookie },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { leads: Array<{ assigned_rep_id: string }> };
  const repBLeads = body.leads.filter((l) => l.assigned_rep_id === repBId);
  expect(repBLeads).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Unauthenticated requests are rejected
// ---------------------------------------------------------------------------

test('GET /api/leads/queue returns 401 without auth cookie', async () => {
  const res = await fetch(`${BASE}/api/leads/queue`);
  expect(res.status).toBe(401);
});

test('GET /api/leads/disqualified returns 401 without auth cookie', async () => {
  const res = await fetch(`${BASE}/api/leads/disqualified`);
  expect(res.status).toBe(401);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForServer(base: string): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/health/live`);
      return;
    } catch {
      await Bun.sleep(300);
    }
  }
  throw new Error(`Server at ${base} did not become ready within ${SERVER_READY_TIMEOUT_MS}ms`);
}
