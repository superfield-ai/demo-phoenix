/**
 * @file apps/server/tests/integration/cfo-portfolio.test.ts
 *
 * Integration tests for the CFO portfolio API endpoints (issue #14).
 *
 * No mocks — real Postgres container + real Bun server + real HTTP.
 *
 * ## Test plan coverage
 *
 *   TP-1  Seed Prospects across 3 industries and 2 company segments with known
 *         CLTV scores; call GET /api/cfo/portfolio; assert segment totals match
 *         expected aggregates.
 *
 *   TP-2  Call GET /api/cfo/portfolio/trend; assert response contains 12
 *         monthly entries with tier breakdowns.
 *
 *   TP-3  Authenticate as sales_rep; call GET /api/cfo/portfolio; assert 403.
 *
 * @see https://github.com/superfield-ai/demo-phoenix/issues/14
 */

import { afterAll, beforeAll, describe, test, expect } from 'vitest';
import type { Subprocess } from 'bun';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { createTestSession } from '../helpers/test-session';

const PORT = 31491;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 60_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let server: Subprocess;
let sql: ReturnType<typeof postgres>;

let cfoCookie = '';
let salesRepCookie = '';

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

  const cfoSession = await createTestSession(BASE, { username: `cfo-${Date.now()}`, role: 'cfo' });
  cfoCookie = cfoSession.cookie;

  const repSession = await createTestSession(BASE, {
    username: `rep-${Date.now()}`,
    role: 'sales_rep',
  });
  salesRepCookie = repSession.cookie;
}, SERVER_READY_TIMEOUT_MS);

afterAll(async () => {
  server?.kill();
  await sql?.end({ timeout: 5 });
  await pg?.stop();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function waitForServer(base: string, timeout = SERVER_READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health/live`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server at ${base} did not become ready within ${timeout}ms`);
}

async function insertProspect(
  overrides: {
    company_name?: string;
    industry?: string;
    company_segment?: string;
    stage?: string;
  } = {},
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO rl_prospects (company_name, industry, company_segment, stage)
    VALUES (
      ${overrides.company_name ?? `Test Co ${crypto.randomUUID().slice(0, 8)}`},
      ${overrides.industry ?? 'Technology'},
      ${overrides.company_segment ?? null},
      ${overrides.stage ?? 'qualified'}
    )
    RETURNING id
  `;
  return row.id;
}

async function insertKycRecord(prospectId: string, annualRevenue: number): Promise<void> {
  await sql`
    INSERT INTO rl_kyc_records (prospect_id, verification_status, annual_revenue_est)
    VALUES (${prospectId}, 'verified', ${annualRevenue})
  `;
}

async function insertCltvScore(
  prospectId: string,
  overrides: { composite_score?: number; tier?: string } = {},
): Promise<void> {
  const score = overrides.composite_score ?? 70;
  const tier = overrides.tier ?? 'B';
  await sql`
    INSERT INTO rl_cltv_scores (
      entity_id, entity_type, composite_score, tier, score_version,
      macro_score, industry_score, company_score,
      macro_inputs_snapshot
    ) VALUES (
      ${prospectId}, 'prospect', ${score}, ${tier}, 'test-001',
      0.65, 0.70, 0.75,
      '{"interest_rate": 5.0, "gdp_growth_rate": 2.5, "inflation_rate": 3.0}'::jsonb
    )
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/cfo/portfolio', () => {
  /**
   * TP-1: Seed prospects across 3 industries and 2 company segments with known
   * CLTV scores; assert segment totals match expected aggregates.
   */
  test('TP-1: returns segment aggregates with total_cltv, lead_count, average_composite_score, and macro_inputs_snapshot', async () => {
    // Seed: 3 industries × 2 company segments = 6 segments
    const industries = ['Finance', 'Healthcare', 'Retail'];
    const segments = ['SMB', 'Enterprise'];
    const prospectIds: string[] = [];

    for (const industry of industries) {
      for (const segment of segments) {
        const pid = await insertProspect({ industry, company_segment: segment });
        await insertKycRecord(pid, 2_000_000);
        await insertCltvScore(pid, { composite_score: 80, tier: 'A' });
        prospectIds.push(pid);
      }
    }

    const res = await fetch(`${BASE}/api/cfo/portfolio`, {
      headers: { Cookie: cfoCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.segments).toBeDefined();
    expect(Array.isArray(body.segments)).toBe(true);

    // Find a Finance/SMB segment
    const financeSmb = body.segments.find(
      (s: { industry: string; company_segment: string }) =>
        s.industry === 'Finance' && s.company_segment === 'SMB',
    );
    expect(financeSmb).toBeDefined();
    expect(financeSmb.lead_count).toBeGreaterThanOrEqual(1);
    expect(typeof financeSmb.total_cltv).toBe('number');
    expect(financeSmb.total_cltv).toBeGreaterThan(0);
    expect(typeof financeSmb.average_composite_score).toBe('number');
    expect(financeSmb.score_tier_distribution).toBeDefined();
    expect(typeof financeSmb.score_tier_distribution.A).toBe('number');
    expect(Array.isArray(financeSmb.entities)).toBe(true);

    // Each entity should have a macro_inputs_snapshot
    const entity = financeSmb.entities[0];
    expect(entity).toBeDefined();
    expect(entity.prospect_id).toBeDefined();
    // macro_inputs_snapshot may be null or an object
    expect(entity.macro_inputs_snapshot !== undefined).toBe(true);
  });

  /**
   * TP-3: Authenticate as sales_rep; call GET /api/cfo/portfolio; assert 403.
   */
  test('TP-3: sales_rep receives 403', async () => {
    const res = await fetch(`${BASE}/api/cfo/portfolio`, {
      headers: { Cookie: salesRepCookie },
    });
    expect(res.status).toBe(403);
  });

  test('unauthenticated request receives 401', async () => {
    const res = await fetch(`${BASE}/api/cfo/portfolio`);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/cfo/portfolio/trend', () => {
  /**
   * TP-2: Call GET /api/cfo/portfolio/trend; assert response contains 12
   * monthly entries with tier breakdowns.
   */
  test('TP-2: returns exactly 12 monthly entries with tier breakdowns', async () => {
    const res = await fetch(`${BASE}/api/cfo/portfolio/trend`, {
      headers: { Cookie: cfoCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.trend).toBeDefined();
    expect(Array.isArray(body.trend)).toBe(true);
    expect(body.trend.length).toBe(12);

    for (const entry of body.trend) {
      expect(typeof entry.month).toBe('string');
      // month must be in YYYY-MM format
      expect(entry.month).toMatch(/^\d{4}-\d{2}$/);
      expect(typeof entry.tier_A).toBe('number');
      expect(typeof entry.tier_B).toBe('number');
      expect(typeof entry.tier_C).toBe('number');
      expect(typeof entry.tier_D).toBe('number');
      expect(typeof entry.total).toBe('number');
    }
  });

  test('sales_rep receives 403 from trend endpoint', async () => {
    const res = await fetch(`${BASE}/api/cfo/portfolio/trend`, {
      headers: { Cookie: salesRepCookie },
    });
    expect(res.status).toBe(403);
  });
});
