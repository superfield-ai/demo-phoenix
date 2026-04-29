/**
 * @file apps/server/tests/integration/kyc.test.ts
 *
 * Integration tests for the KYC re-trigger and manual review queue API (issue #52).
 *
 * No mocks — real Postgres container + real Bun server + real HTTP.
 *
 * ## Test plan coverage
 *
 *   TP-1  Integration: POST /api/kyc/:id/trigger with KYC_STUB_OUTCOME=verified
 *         creates a new KYCRecord and archives the previous one.
 *
 *   TP-2  Integration: POST /api/kyc/:id/trigger with KYC_STUB_OUTCOME=insufficient_data
 *         sets kyc_manual_review flag and does NOT recompute CLTV score.
 *
 *   TP-3  Integration: trigger KYC with verified outcome, verify CLTV score is
 *         recomputed and prospect stage is qualified or disqualified (not
 *         kyc_manual_review).
 *
 *   TP-4  Integration: trigger KYC with failed outcome, verify prospect is removed
 *         from rep queue and appears in manual review list.
 *
 *   TP-5  Integration: PATCH /api/kyc/:id/review with action=verify clears the
 *         manual_review flag and routes the prospect.
 *
 *   TP-6  Integration: PATCH /api/kyc/:id/review with action=reject disqualifies
 *         the prospect.
 *
 *   TP-7  Integration: GET /api/kyc/manual-review as sales_rep returns 403.
 *
 * @see https://github.com/superfield-ai/demo-phoenix/issues/52
 */

import { afterAll, beforeAll, describe, test, expect } from 'vitest';
import type { Subprocess } from 'bun';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { createTestSession } from '../helpers/test-session';

const PORT = 31583;
const SERVER_READY_TIMEOUT_MS = 60_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let serverVerified: Subprocess;
let serverFailed: Subprocess;
let serverInsufficient: Subprocess;
let sql: ReturnType<typeof postgres>;

// Sessions
let repCookie = '';
let _repUserId = '';
let reviewerCookie = '';

// We run three servers on different ports for the three KYC stub outcomes.
const VERIFIED_PORT = PORT;
const FAILED_PORT = PORT + 1;
const INSUFFICIENT_PORT = PORT + 2;

const VERIFIED_BASE = `http://localhost:${VERIFIED_PORT}`;
const FAILED_BASE = `http://localhost:${FAILED_PORT}`;
const INSUFFICIENT_BASE = `http://localhost:${INSUFFICIENT_PORT}`;

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 5 });

  // Start three server instances with different KYC_STUB_OUTCOME values.
  serverVerified = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      AUDIT_DATABASE_URL: pg.url,
      ANALYTICS_DATABASE_URL: pg.url,
      PORT: String(VERIFIED_PORT),
      TEST_MODE: 'true',
      SUPERUSER_ID: '__superuser__',
      KYC_STUB_OUTCOME: 'verified',
      QUALIFICATION_THRESHOLD: '0.01', // low threshold so verified always qualifies
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  serverFailed = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      AUDIT_DATABASE_URL: pg.url,
      ANALYTICS_DATABASE_URL: pg.url,
      PORT: String(FAILED_PORT),
      TEST_MODE: 'true',
      SUPERUSER_ID: '__superuser__',
      KYC_STUB_OUTCOME: 'failed',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  serverInsufficient = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      AUDIT_DATABASE_URL: pg.url,
      ANALYTICS_DATABASE_URL: pg.url,
      PORT: String(INSUFFICIENT_PORT),
      TEST_MODE: 'true',
      SUPERUSER_ID: '__superuser__',
      KYC_STUB_OUTCOME: 'insufficient_data',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  await Promise.all([
    waitForServer(VERIFIED_BASE),
    waitForServer(FAILED_BASE),
    waitForServer(INSUFFICIENT_BASE),
  ]);

  // Create sessions via the verified server (all share the same DB).
  const repSession = await createTestSession(VERIFIED_BASE, {
    username: `kyc-rep-${Date.now()}`,
    role: 'sales_rep',
  });
  repCookie = repSession.cookie;
  _repUserId = repSession.userId;

  const reviewerSession = await createTestSession(VERIFIED_BASE, {
    username: `kyc-reviewer-${Date.now()}`,
    role: 'lead_manager',
  });
  reviewerCookie = reviewerSession.cookie;
}, 120_000);

afterAll(async () => {
  serverVerified?.kill();
  serverFailed?.kill();
  serverInsufficient?.kill();
  await sql?.end({ timeout: 5 });
  await pg?.stop();
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

/** Insert a prospect directly into the DB and return its id. */
async function insertProspect(
  overrides: {
    stage?: string;
    assigned_rep_id?: string;
    company_name?: string;
  } = {},
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO rl_prospects (company_name, stage, assigned_rep_id)
    VALUES (
      ${overrides.company_name ?? `KYC Test Co ${crypto.randomUUID().slice(0, 8)}`},
      ${overrides.stage ?? 'kyc_manual_review'},
      ${overrides.assigned_rep_id ?? null}
    )
    RETURNING id
  `;
  return row.id;
}

/** Insert a KYC record for a prospect. */
async function insertKycRecord(
  prospectId: string,
  overrides: { verification_status?: string } = {},
): Promise<void> {
  await sql`
    INSERT INTO rl_kyc_records
      (prospect_id, verification_status, annual_revenue_est, debt_load_est, checked_at)
    VALUES
      (${prospectId}, ${overrides.verification_status ?? 'failed'},
       5_000_000, 500_000, NOW())
  `;
}

// ---------------------------------------------------------------------------
// TP-1: POST trigger creates a new KYCRecord and archives the previous one
// ---------------------------------------------------------------------------

describe('TP-1: KYC trigger archives previous record and creates a new one', () => {
  test('archives the active KYC record and inserts a new one', async () => {
    const prospectId = await insertProspect({ stage: 'kyc_manual_review' });
    await insertKycRecord(prospectId, { verification_status: 'failed' });

    // Verify one active record exists before trigger.
    const [before] = await sql<{ cnt: number }[]>`
      SELECT COUNT(*)::int AS cnt
      FROM rl_kyc_records
      WHERE prospect_id = ${prospectId}
        AND verification_status != 'archived'
    `;
    expect(before.cnt).toBe(1);

    const res = await fetch(`${VERIFIED_BASE}/api/kyc/${prospectId}/trigger`, {
      method: 'POST',
      credentials: 'include',
      headers: { Cookie: reviewerCookie, 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.kyc_record_id).toBeTruthy();
    expect(body.outcome).toBe('verified');
    expect(body.checked_at).toBeTruthy();

    // Now only one active record (the new one) should exist.
    const [after] = await sql<{ cnt: number }[]>`
      SELECT COUNT(*)::int AS cnt
      FROM rl_kyc_records
      WHERE prospect_id = ${prospectId}
        AND verification_status != 'archived'
    `;
    expect(after.cnt).toBe(1);

    // The old record must now be archived.
    const [archived] = await sql<{ cnt: number }[]>`
      SELECT COUNT(*)::int AS cnt
      FROM rl_kyc_records
      WHERE prospect_id = ${prospectId}
        AND verification_status = 'archived'
    `;
    expect(archived.cnt).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// TP-2: insufficient_data sets kyc_manual_review flag, no CLTV recompute
// ---------------------------------------------------------------------------

describe('TP-2: insufficient_data outcome sets kyc_manual_review, no CLTV recompute', () => {
  test('prospect stage becomes kyc_manual_review and no new CLTV score is inserted', async () => {
    const prospectId = await insertProspect({ stage: 'kyc_pending' });

    // Record CLTV count before trigger.
    const [beforeCltv] = await sql<{ cnt: number }[]>`
      SELECT COUNT(*)::int AS cnt
      FROM rl_cltv_scores
      WHERE entity_id = ${prospectId} AND entity_type = 'prospect'
    `;

    const res = await fetch(`${INSUFFICIENT_BASE}/api/kyc/${prospectId}/trigger`, {
      method: 'POST',
      credentials: 'include',
      headers: { Cookie: reviewerCookie, 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.outcome).toBe('insufficient_data');
    expect(body.route_result).toBeNull();

    // Prospect stage must be kyc_manual_review.
    const [prospect] = await sql<{ stage: string }[]>`
      SELECT stage FROM rl_prospects WHERE id = ${prospectId}
    `;
    expect(prospect.stage).toBe('kyc_manual_review');

    // No new CLTV score must have been added.
    const [afterCltv] = await sql<{ cnt: number }[]>`
      SELECT COUNT(*)::int AS cnt
      FROM rl_cltv_scores
      WHERE entity_id = ${prospectId} AND entity_type = 'prospect'
    `;
    expect(afterCltv.cnt).toBe(beforeCltv.cnt);
  });
});

// ---------------------------------------------------------------------------
// TP-3: verified outcome recomputes CLTV and routes the prospect
// ---------------------------------------------------------------------------

describe('TP-3: verified outcome recomputes CLTV and routes prospect', () => {
  test('CLTV score is created and prospect stage is not kyc_manual_review', async () => {
    const prospectId = await insertProspect({ stage: 'kyc_pending' });

    const res = await fetch(`${VERIFIED_BASE}/api/kyc/${prospectId}/trigger`, {
      method: 'POST',
      credentials: 'include',
      headers: { Cookie: reviewerCookie, 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.outcome).toBe('verified');
    expect(body.route_result).not.toBeNull();

    // A CLTV score must exist.
    const [score] = await sql<{ cnt: number }[]>`
      SELECT COUNT(*)::int AS cnt
      FROM rl_cltv_scores
      WHERE entity_id = ${prospectId} AND entity_type = 'prospect'
    `;
    expect(score.cnt).toBeGreaterThan(0);

    // Prospect stage must NOT be kyc_manual_review.
    const [prospect] = await sql<{ stage: string }[]>`
      SELECT stage FROM rl_prospects WHERE id = ${prospectId}
    `;
    expect(prospect.stage).not.toBe('kyc_manual_review');
  });
});

// ---------------------------------------------------------------------------
// TP-4: failed outcome sets kyc_manual_review and prospect appears in list
// ---------------------------------------------------------------------------

describe('TP-4: failed outcome sets kyc_manual_review and appears in manual review list', () => {
  test('prospect appears in GET /api/kyc/manual-review after failed trigger', async () => {
    const prospectId = await insertProspect({ stage: 'kyc_pending' });

    const triggerRes = await fetch(`${FAILED_BASE}/api/kyc/${prospectId}/trigger`, {
      method: 'POST',
      credentials: 'include',
      headers: { Cookie: reviewerCookie, 'Content-Type': 'application/json' },
    });
    expect(triggerRes.status).toBe(200);
    const triggerBody = await triggerRes.json();
    expect(triggerBody.outcome).toBe('failed');

    // Prospect stage must be kyc_manual_review.
    const [prospect] = await sql<{ stage: string }[]>`
      SELECT stage FROM rl_prospects WHERE id = ${prospectId}
    `;
    expect(prospect.stage).toBe('kyc_manual_review');

    // Prospect must appear in the manual review list.
    const listRes = await fetch(`${FAILED_BASE}/api/kyc/manual-review`, {
      credentials: 'include',
      headers: { Cookie: reviewerCookie },
    });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    const ids = (listBody.prospects as { prospect_id: string }[]).map((p) => p.prospect_id);
    expect(ids).toContain(prospectId);
  });
});

// ---------------------------------------------------------------------------
// TP-5: PATCH review with action=verify routes the prospect
// ---------------------------------------------------------------------------

describe('TP-5: review action=verify clears flag and routes prospect', () => {
  test('prospect stage changes from kyc_manual_review after verify', async () => {
    const prospectId = await insertProspect({ stage: 'kyc_manual_review' });
    await insertKycRecord(prospectId, { verification_status: 'failed' });

    const res = await fetch(`${VERIFIED_BASE}/api/kyc/${prospectId}/review`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { Cookie: reviewerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'verify' }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.action).toBe('verify');
    // Stage should be qualified or disqualified, not kyc_manual_review.
    expect(body.stage).not.toBe('kyc_manual_review');
  });
});

// ---------------------------------------------------------------------------
// TP-6: PATCH review with action=reject disqualifies the prospect
// ---------------------------------------------------------------------------

describe('TP-6: review action=reject disqualifies prospect', () => {
  test('prospect stage becomes disqualified after reject', async () => {
    const prospectId = await insertProspect({ stage: 'kyc_manual_review' });
    await insertKycRecord(prospectId, { verification_status: 'failed' });

    const res = await fetch(`${VERIFIED_BASE}/api/kyc/${prospectId}/review`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { Cookie: reviewerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reject' }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.action).toBe('reject');
    expect(body.stage).toBe('disqualified');

    const [prospect] = await sql<{ stage: string; disqualification_reason: string | null }[]>`
      SELECT stage, disqualification_reason FROM rl_prospects WHERE id = ${prospectId}
    `;
    expect(prospect.stage).toBe('disqualified');
    expect(prospect.disqualification_reason).toBe('kyc_not_verified');
  });
});

// ---------------------------------------------------------------------------
// TP-7: sales_rep is blocked from manual review queue
// ---------------------------------------------------------------------------

describe('TP-7: sales_rep cannot access manual review queue', () => {
  test('GET /api/kyc/manual-review as sales_rep returns 403', async () => {
    const res = await fetch(`${VERIFIED_BASE}/api/kyc/manual-review`, {
      credentials: 'include',
      headers: { Cookie: repCookie },
    });
    expect(res.status).toBe(403);
  });

  test('PATCH /api/kyc/:id/review as sales_rep returns 403', async () => {
    const prospectId = await insertProspect({ stage: 'kyc_manual_review' });
    const res = await fetch(`${VERIFIED_BASE}/api/kyc/${prospectId}/review`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { Cookie: repCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'verify' }),
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Unauthenticated guard
// ---------------------------------------------------------------------------

describe('unauthenticated requests are rejected', () => {
  test('POST trigger without auth returns 401', async () => {
    const prospectId = await insertProspect();
    const res = await fetch(`${VERIFIED_BASE}/api/kyc/${prospectId}/trigger`, {
      method: 'POST',
    });
    expect(res.status).toBe(401);
  });

  test('GET manual-review without auth returns 401', async () => {
    const res = await fetch(`${VERIFIED_BASE}/api/kyc/manual-review`);
    expect(res.status).toBe(401);
  });
});
