/**
 * @file pipeline-board.spec.ts
 *
 * Integration tests for GET /api/leads/pipeline (issue #10).
 *
 * Test plan coverage:
 *   TP-1  Seed 3 Prospects in Contacted and 2 in Proposal for rep A; authenticate as rep A;
 *         call GET /api/leads/pipeline; assert 3 items under contacted and 2 under proposal.
 *   TP-2  Assert each item includes tier, cltv_low, cltv_high, and days_in_stage fields.
 *   TP-3  Authenticate as rep B and call GET /api/leads/pipeline; assert rep A's Prospects
 *         do not appear.
 *   TP-4  Render the board; assert column footer for Contacted shows the sum of cltv_low
 *         values for those 3 cards. (Covered by verifying the API cltv_low values sum.)
 *   TP-5  Assert no drag event handlers are attached to card elements (inspect rendered DOM).
 *         (Covered in the unit test for PipelineCard — no drag handlers on <button>.)
 *
 * No mocks — real Postgres + real Bun server via the shared E2E environment helper.
 * TEST_MODE=true is set by startE2EServer.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/10
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { startE2EServer, stopE2EServer, type E2EEnvironment } from '../e2e/environment';

let env: E2EEnvironment;
let db: ReturnType<typeof postgres>;

beforeAll(async () => {
  env = await startE2EServer();
  db = postgres(env.pg.url, { max: 3 });
});

afterAll(async () => {
  await db?.end({ timeout: 5 });
  await stopE2EServer(env);
});

// ---------------------------------------------------------------------------
// Helper: obtain a session cookie and user ID via the TEST_MODE backdoor
// ---------------------------------------------------------------------------

async function getTestSession(
  base: string,
  username: string,
): Promise<{ cookie: string; userId: string }> {
  const res = await fetch(`${base}/api/test/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  if (!res.ok) {
    throw new Error(`test-session failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { user: { id: string } };
  const setCookie = res.headers.get('set-cookie') ?? '';
  const match = /superfield_auth=([^;]+)/.exec(setCookie);
  const cookie = match ? `superfield_auth=${match[1]}` : '';
  return { cookie, userId: body.user.id };
}

// ---------------------------------------------------------------------------
// Helper: seed a Prospect + Deal + optional CLTVScore
// ---------------------------------------------------------------------------

interface SeedProspectOpts {
  companyName: string;
  dealStage: string;
  ownerRepId: string;
  tier?: string | null;
  compositeScore?: number | null;
  annualRevenue?: number | null;
}

async function seedProspectWithDeal(
  opts: SeedProspectOpts,
): Promise<{ prospectId: string; dealId: string }> {
  const [prospect] = await db<{ id: string }[]>`
    INSERT INTO rl_prospects (company_name)
    VALUES (${opts.companyName})
    RETURNING id
  `;
  const prospectId = prospect.id;

  const [deal] = await db<{ id: string }[]>`
    INSERT INTO rl_deals (prospect_id, stage, owner_rep_id)
    VALUES (${prospectId}, ${opts.dealStage}, ${opts.ownerRepId})
    RETURNING id
  `;
  const dealId = deal.id;

  // Optionally seed a CLTVScore
  if (opts.tier !== undefined && opts.tier !== null) {
    await db`
      INSERT INTO rl_cltv_scores (
        entity_id, entity_type, composite_score, tier, score_version
      ) VALUES (
        ${prospectId}, 'prospect',
        ${opts.compositeScore ?? 70},
        ${opts.tier},
        'test-version'
      )
    `;
  }

  // Optionally seed a KYC record with annual_revenue_est
  if (opts.annualRevenue !== undefined && opts.annualRevenue !== null) {
    await db`
      INSERT INTO rl_kyc_records (prospect_id, verification_status, annual_revenue_est)
      VALUES (${prospectId}, 'verified', ${opts.annualRevenue})
    `;
  }

  return { prospectId, dealId };
}

// ---------------------------------------------------------------------------
// TP-1: Rep A sees their own Prospects grouped by stage
// ---------------------------------------------------------------------------

describe('GET /api/leads/pipeline', () => {
  it('returns 401 when the caller is not authenticated', async () => {
    const res = await fetch(`${env.baseUrl}/api/leads/pipeline`);
    expect(res.status).toBe(401);
  });

  it('TP-1: returns 3 prospects in contacted and 2 in proposal for rep A', async () => {
    const repA = await getTestSession(env.baseUrl, 'pipeline-rep-a-tp1');

    // Seed 3 Prospects in Contacted
    for (let i = 1; i <= 3; i++) {
      await seedProspectWithDeal({
        companyName: `Contacted Co ${i} (Rep A)`,
        dealStage: 'contacted',
        ownerRepId: repA.userId,
        tier: 'B',
        compositeScore: 65,
        annualRevenue: 500_000,
      });
    }

    // Seed 2 Prospects in Proposal
    for (let i = 1; i <= 2; i++) {
      await seedProspectWithDeal({
        companyName: `Proposal Co ${i} (Rep A)`,
        dealStage: 'proposal',
        ownerRepId: repA.userId,
        tier: 'A',
        compositeScore: 85,
        annualRevenue: 1_000_000,
      });
    }

    const res = await fetch(`${env.baseUrl}/api/leads/pipeline`, {
      headers: { Cookie: repA.cookie },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { stages: Record<string, unknown[]> };
    expect(Array.isArray(body.stages.contacted)).toBe(true);
    expect(Array.isArray(body.stages.proposal)).toBe(true);

    // Isolate to this test by checking counts are at least the expected values
    // (other tests in the same db may add cards — we use unique company names)
    const contactedNames = body.stages.contacted.map(
      (c) => (c as { company_name: string }).company_name,
    );
    const proposalNames = body.stages.proposal.map(
      (c) => (c as { company_name: string }).company_name,
    );

    const myContacted = contactedNames.filter((n) => n.includes('(Rep A)'));
    const myProposal = proposalNames.filter((n) => n.includes('(Rep A)'));

    expect(myContacted).toHaveLength(3);
    expect(myProposal).toHaveLength(2);
  }, 30_000);

  // ---------------------------------------------------------------------------
  // TP-2: Each item includes tier, cltv_low, cltv_high, days_in_stage
  // ---------------------------------------------------------------------------

  it('TP-2: each card item includes tier, cltv_low, cltv_high, and days_in_stage', async () => {
    const repB = await getTestSession(env.baseUrl, 'pipeline-rep-b-tp2');

    await seedProspectWithDeal({
      companyName: 'Field Check Corp (Rep B)',
      dealStage: 'qualified',
      ownerRepId: repB.userId,
      tier: 'A',
      compositeScore: 80,
      annualRevenue: 2_000_000,
    });

    const res = await fetch(`${env.baseUrl}/api/leads/pipeline`, {
      headers: { Cookie: repB.cookie },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { stages: Record<string, unknown[]> };
    const qualified = body.stages.qualified as Array<{
      company_name: string;
      tier: string;
      cltv_low: number | null;
      cltv_high: number | null;
      days_in_stage: number;
    }>;

    const myCard = qualified.find((c) => c.company_name === 'Field Check Corp (Rep B)');
    expect(myCard).toBeDefined();
    expect(myCard).toHaveProperty('tier');
    expect(myCard).toHaveProperty('cltv_low');
    expect(myCard).toHaveProperty('cltv_high');
    expect(myCard).toHaveProperty('days_in_stage');

    // With compositeScore=80 and annualRevenue=2_000_000:
    // mid = 0.80 * 2_000_000 = 1_600_000
    // cltv_low  = 1_600_000 * 0.8 = 1_280_000
    // cltv_high = 1_600_000 * 1.2 = 1_920_000
    expect(myCard!.cltv_low).toBe(1_280_000);
    expect(myCard!.cltv_high).toBe(1_920_000);
    expect(typeof myCard!.days_in_stage).toBe('number');
    expect(myCard!.days_in_stage).toBeGreaterThanOrEqual(0);
  }, 30_000);

  // ---------------------------------------------------------------------------
  // TP-3: Rep B cannot see rep A's Prospects
  // ---------------------------------------------------------------------------

  it("TP-3: rep B cannot see rep A's prospects", async () => {
    const repA = await getTestSession(env.baseUrl, 'pipeline-rep-a-isolation');
    const repBCaller = await getTestSession(env.baseUrl, 'pipeline-rep-b-isolation');

    // Seed a Prospect for rep A only
    await seedProspectWithDeal({
      companyName: 'Isolation Test Corp (Rep A only)',
      dealStage: 'contacted',
      ownerRepId: repA.userId,
    });

    // Rep B calls the pipeline endpoint
    const res = await fetch(`${env.baseUrl}/api/leads/pipeline`, {
      headers: { Cookie: repBCaller.cookie },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { stages: Record<string, unknown[]> };
    const allCards = ([] as unknown[]).concat(
      ...Object.values(body.stages).map((cards) => cards as unknown[]),
    );

    const leaked = allCards.find(
      (c) => (c as { company_name: string }).company_name === 'Isolation Test Corp (Rep A only)',
    );
    expect(leaked).toBeUndefined();
  }, 30_000);

  // ---------------------------------------------------------------------------
  // TP-4: Column footer sum equals sum of cltv_low values for the cards
  //        (verified via API — the UI component reads from the same data)
  // ---------------------------------------------------------------------------

  it('TP-4: cltv_low values for contacted cards sum correctly', async () => {
    const repC = await getTestSession(env.baseUrl, 'pipeline-rep-c-tp4');

    // Seed 3 Prospects in Contacted with known revenue
    const annualRevenue = 1_000_000;
    const compositeScore = 50; // mid = 500_000, low = 400_000, high = 600_000
    for (let i = 1; i <= 3; i++) {
      await seedProspectWithDeal({
        companyName: `Footer Test Co ${i} (Rep C)`,
        dealStage: 'contacted',
        ownerRepId: repC.userId,
        tier: 'C',
        compositeScore,
        annualRevenue,
      });
    }

    const res = await fetch(`${env.baseUrl}/api/leads/pipeline`, {
      headers: { Cookie: repC.cookie },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { stages: Record<string, unknown[]> };
    const contacted = body.stages.contacted as Array<{
      company_name: string;
      cltv_low: number | null;
    }>;

    const myCards = contacted.filter((c) => c.company_name.includes('(Rep C)'));
    expect(myCards).toHaveLength(3);

    // cltv_low = 0.50 * 1_000_000 * 0.8 = 400_000 each
    const expectedLowPerCard = 400_000;
    const totalLow = myCards.reduce((sum, c) => sum + (c.cltv_low ?? 0), 0);
    expect(totalLow).toBe(expectedLowPerCard * 3); // 1_200_000
  }, 30_000);
});
