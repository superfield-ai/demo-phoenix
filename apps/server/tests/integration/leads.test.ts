/**
 * @file apps/server/tests/integration/leads.test.ts
 *
 * Integration tests for the Phase 1 lead detail API (issue #9).
 *
 * No mocks — real Postgres container + real Bun server + real HTTP.
 *
 * ## Test plan coverage
 *
 *   TP-1  GET /api/leads/:id for a Prospect with a CLTVScore; assert all three
 *         sub-score rationale strings are present in the response.
 *
 *   TP-2  PATCH /api/leads/:id/stage with no note body; assert 422 response.
 *
 *   TP-3  PATCH /api/leads/:id/stage with a valid note; assert Deal.stage
 *         updated and a timeline entry created in the same transaction.
 *
 *   TP-4  Authenticate as a different rep and call GET /api/leads/:id for a
 *         lead not assigned to them; assert 403.
 *
 *   TP-5  Render the detail view for a kyc_manual_review Prospect; assert
 *         re-trigger KYC button condition gated by kyc_status = 'kyc_manual_review';
 *         for a verified Prospect assert kyc_status != 'kyc_manual_review'.
 *
 *   TP-6  POST /api/leads/:id/activities with type=call; assert activity
 *         appears in GET /api/leads/:id timeline response.
 *
 * @see https://github.com/superfield-ai/demo-phoenix/issues/9
 */

import { afterAll, beforeAll, describe, test, expect } from 'vitest';
import type { Subprocess } from 'bun';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { createTestSession } from '../helpers/test-session';

const PORT = 31481;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 60_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let server: Subprocess;
let sql: ReturnType<typeof postgres>;

// Rep sessions
let repACookie = '';
let repAUserId = '';
let repBCookie = '';
// repBUserId is used implicitly via repBCookie for cross-rep access tests
let _repBUserId = '';

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 5 });

  server = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      AUDIT_DATABASE_URL: pg.url,
      ANALYTICS_DATABASE_URL: pg.url,
      PORT: String(PORT),
      TEST_MODE: 'true',
      SUPERUSER_ID: '__placeholder__',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  await waitForServer(BASE);

  // Create two distinct rep sessions.
  const sessionA = await createTestSession(BASE, {
    username: `rep-a-${Date.now()}`,
    role: 'sales_rep',
  });
  repACookie = sessionA.cookie;
  repAUserId = sessionA.userId;

  const sessionB = await createTestSession(BASE, {
    username: `rep-b-${Date.now()}`,
    role: 'sales_rep',
  });
  repBCookie = sessionB.cookie;
  _repBUserId = sessionB.userId;
}, 60_000);

afterAll(async () => {
  server?.kill();
  await sql?.end({ timeout: 5 });
  await pg?.stop();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — direct DB inserts to set up test fixtures
// ─────────────────────────────────────────────────────────────────────────────

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
      ${overrides.company_name ?? `Test Co ${crypto.randomUUID().slice(0, 8)}`},
      ${overrides.stage ?? 'qualified'},
      ${overrides.assigned_rep_id ?? null}
    )
    RETURNING id
  `;
  return row.id;
}

async function insertKycRecord(
  prospectId: string,
  overrides: { verification_status?: string; funding_stage?: string } = {},
): Promise<void> {
  await sql`
    INSERT INTO rl_kyc_records
      (prospect_id, verification_status, funding_stage,
       annual_revenue_est, debt_load_est, checked_at)
    VALUES
      (${prospectId}, ${overrides.verification_status ?? 'verified'},
       ${overrides.funding_stage ?? 'series_a'},
       5000000, 500000, NOW())
  `;
}

async function insertCltvScore(
  prospectId: string,
  overrides: {
    composite_score?: number;
    rationale_macro?: string;
    rationale_industry?: string;
    rationale_company?: string;
    score_version?: string;
    tier?: string;
  } = {},
): Promise<void> {
  await sql`
    INSERT INTO rl_cltv_scores
      (entity_id, entity_type, composite_score, tier, score_version,
       macro_score, industry_score, company_score,
       rationale_macro, rationale_industry, rationale_company)
    VALUES
      (${prospectId}, 'prospect',
       ${overrides.composite_score ?? 72},
       ${overrides.tier ?? 'B'},
       ${overrides.score_version ?? 'testv1'},
       0.68, 0.71, 0.77,
       ${overrides.rationale_macro ?? 'Macro scored 68.0/100 based on: interest rate 4.00%.'},
       ${overrides.rationale_industry ?? 'Industry scored 71.0/100 based on: SIC code 7372.'},
       ${overrides.rationale_company ?? 'Company scored 77.0/100 based on: annual revenue ~$5,000,000.'})
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// TP-1: GET /api/leads/:id returns all three sub-score rationale strings
// ─────────────────────────────────────────────────────────────────────────────

describe('TP-1: GET /api/leads/:id includes sub-score rationale strings', () => {
  test('response contains macro, industry, and company rationale strings', async () => {
    const prospectId = await insertProspect({ assigned_rep_id: repAUserId });
    await insertKycRecord(prospectId);
    await insertCltvScore(prospectId, {
      rationale_macro: 'Macro scored 68.0/100 based on: interest rate 4.00%.',
      rationale_industry: 'Industry scored 71.0/100 based on: SIC code 7372.',
      rationale_company: 'Company scored 77.0/100 based on: annual revenue ~$5,000,000.',
    });

    const res = await fetch(`${BASE}/api/leads/${prospectId}`, {
      headers: { Cookie: repACookie },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cltv_score: {
        macro_score: number;
        industry_score: number;
        company_score: number;
        rationale_macro: string;
        rationale_industry: string;
        rationale_company: string;
        score_version: string;
        computed_at: string;
      };
    };

    expect(body.cltv_score).not.toBeNull();
    expect(typeof body.cltv_score.rationale_macro).toBe('string');
    expect(body.cltv_score.rationale_macro).toContain('Macro scored');
    expect(typeof body.cltv_score.rationale_industry).toBe('string');
    expect(body.cltv_score.rationale_industry).toContain('Industry scored');
    expect(typeof body.cltv_score.rationale_company).toBe('string');
    expect(body.cltv_score.rationale_company).toContain('Company scored');
    expect(typeof body.cltv_score.score_version).toBe('string');
    expect(body.cltv_score.computed_at).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TP-2: PATCH /api/leads/:id/stage with no note → 422
// ─────────────────────────────────────────────────────────────────────────────

describe('TP-2: PATCH /api/leads/:id/stage without note returns 422', () => {
  test('empty note body is rejected with 422', async () => {
    const prospectId = await insertProspect({ assigned_rep_id: repAUserId });

    const res = await fetch(`${BASE}/api/leads/${prospectId}/stage`, {
      method: 'PATCH',
      headers: { Cookie: repACookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'proposal', note: '' }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('NOTE_REQUIRED');
  });

  test('missing note field is rejected with 422', async () => {
    const prospectId = await insertProspect({ assigned_rep_id: repAUserId });

    const res = await fetch(`${BASE}/api/leads/${prospectId}/stage`, {
      method: 'PATCH',
      headers: { Cookie: repACookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'proposal' }),
    });

    expect(res.status).toBe(422);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TP-3: PATCH /api/leads/:id/stage with valid note → Deal + activity created
// ─────────────────────────────────────────────────────────────────────────────

describe('TP-3: PATCH /api/leads/:id/stage with valid note creates Deal and activity', () => {
  test('stage change creates rl_deals row and rl_activities entry atomically', async () => {
    const prospectId = await insertProspect({ assigned_rep_id: repAUserId });
    const noteText = 'Confirmed budget and decision timeline. Moving to proposal.';

    const patchRes = await fetch(`${BASE}/api/leads/${prospectId}/stage`, {
      method: 'PATCH',
      headers: { Cookie: repACookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'proposal', note: noteText }),
    });

    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as { deal_id: string; activity_id: string };
    expect(patchBody.deal_id).toBeTruthy();
    expect(patchBody.activity_id).toBeTruthy();

    // Verify Deal was persisted.
    const [deal] = await sql<{ stage: string }[]>`
      SELECT stage FROM rl_deals WHERE id = ${patchBody.deal_id}
    `;
    expect(deal.stage).toBe('proposal');

    // Verify activity was persisted.
    const [activity] = await sql<{ activity_type: string; note: string }[]>`
      SELECT activity_type, note FROM rl_activities WHERE id = ${patchBody.activity_id}
    `;
    expect(activity.activity_type).toBe('stage_change');
    expect(activity.note).toBe(noteText);

    // Verify the activity appears in the GET timeline.
    const getRes = await fetch(`${BASE}/api/leads/${prospectId}`, {
      headers: { Cookie: repACookie },
    });
    const getBody = (await getRes.json()) as { timeline: { id: string }[] };
    const found = getBody.timeline.some((e) => e.id === patchBody.activity_id);
    expect(found).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TP-4: GET /api/leads/:id — different rep gets 403
// ─────────────────────────────────────────────────────────────────────────────

describe("TP-4: GET /api/leads/:id for another rep's lead returns 403", () => {
  test('rep B cannot access a lead assigned to rep A', async () => {
    // Create a prospect assigned to rep A.
    const prospectId = await insertProspect({ assigned_rep_id: repAUserId });

    // Rep B attempts to read it.
    const res = await fetch(`${BASE}/api/leads/${prospectId}`, {
      headers: { Cookie: repBCookie },
    });

    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TP-5: Re-trigger KYC button presence gated by kyc_manual_review stage
// ─────────────────────────────────────────────────────────────────────────────

describe('TP-5: kyc_status field drives re-trigger KYC button visibility', () => {
  test('kyc_manual_review prospect has kyc_status = kyc_manual_review in API response', async () => {
    // A superuser can access any lead — use a direct DB check instead.
    const prospectId = await insertProspect({
      stage: 'kyc_manual_review',
      assigned_rep_id: repAUserId,
    });

    const res = await fetch(`${BASE}/api/leads/${prospectId}`, {
      headers: { Cookie: repACookie },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { prospect: { kyc_status: string } };
    // The frontend shows re-trigger button when kyc_status === 'kyc_manual_review'.
    expect(body.prospect.kyc_status).toBe('kyc_manual_review');
  });

  test('verified prospect has kyc_status != kyc_manual_review', async () => {
    const prospectId = await insertProspect({ stage: 'qualified', assigned_rep_id: repAUserId });
    await insertKycRecord(prospectId, { verification_status: 'verified' });

    const res = await fetch(`${BASE}/api/leads/${prospectId}`, {
      headers: { Cookie: repACookie },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { prospect: { kyc_status: string } };
    expect(body.prospect.kyc_status).not.toBe('kyc_manual_review');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TP-6: POST /api/leads/:id/activities with type=call → appears in timeline
// ─────────────────────────────────────────────────────────────────────────────

describe('TP-6: POST /api/leads/:id/activities type=call appears in GET timeline', () => {
  test('logging a call creates an activity that appears in the timeline', async () => {
    const prospectId = await insertProspect({ assigned_rep_id: repAUserId });
    const callNote = 'Spoke with CFO — interested in Q3 kickoff.';

    const postRes = await fetch(`${BASE}/api/leads/${prospectId}/activities`, {
      method: 'POST',
      headers: { Cookie: repACookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'call', note: callNote }),
    });

    expect(postRes.status).toBe(201);
    const postBody = (await postRes.json()) as { activity_id: string; occurred_at: string };
    expect(postBody.activity_id).toBeTruthy();

    // Confirm the activity appears in the GET /api/leads/:id timeline.
    const getRes = await fetch(`${BASE}/api/leads/${prospectId}`, {
      headers: { Cookie: repACookie },
    });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      timeline: { id: string; activity_type: string; note: string | null }[];
    };

    const entry = getBody.timeline.find((e) => e.id === postBody.activity_id);
    expect(entry).toBeDefined();
    expect(entry!.activity_type).toBe('call');
    expect(entry!.note).toBe(callNote);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

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
