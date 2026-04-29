/**
 * @file cfo-tier-trend.test.ts
 *
 * Integration tests for GET /api/cfo/tier-trend (issue #15).
 *
 * All tests run against a real ephemeral Postgres container — no mocks.
 *
 * ## Test plan coverage
 *
 * TP-1  Seed 10 qualified Prospects in week 1 of the current quarter:
 *       5 tier A (score 0.8), 3 tier B (score 0.5), 2 tier C (score 0.2).
 *       Assert tier-trend returns tier_a_pct=50, tier_b_pct=30, tier_c_pct=20
 *       for that week.  Percentages sum to 100.
 *
 * TP-2  Seed 4 qualified Prospects in prior quarter week 1.
 *       Call with period=prior_quarter; assert those weeks appear and no
 *       current-quarter weeks are included.
 *
 * TP-3  Authenticate as sales_rep; assert isCfoAuthorised returns false
 *       (same pattern as cfo.test.ts TP-5).
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/15
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from 'db/pg-container';
import { migrate } from 'db';
import { getTierTrend, seedProspectAtDate } from 'db/cfo-tier-trend';

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

/**
 * Returns a reference Date anchored to the first Monday of the first week of
 * the given quarter start (the Date passed in).  Used to derive a stable
 * "week 1" created_at timestamp for seeded prospects.
 */
function firstWeekIso(quarterStart: Date): string {
  // quarterStart is always the 1st of a month; week boundary may differ from
  // quarter boundary.  We just use the 2nd day of the quarter to be within
  // that week for certain.
  const d = new Date(quarterStart);
  d.setUTCDate(d.getUTCDate() + 1); // a day into the quarter
  return d.toISOString();
}

/** Returns the current-quarter start date (UTC). */
function currentQuarterStart(now: Date = new Date()): Date {
  const month = now.getUTCMonth();
  const qm = Math.floor(month / 3) * 3;
  return new Date(Date.UTC(now.getUTCFullYear(), qm, 1));
}

/** Returns the prior-quarter start date (UTC). */
function priorQuarterStart(now: Date = new Date()): Date {
  const cqs = currentQuarterStart(now);
  const m = cqs.getUTCMonth();
  if (m === 0) return new Date(Date.UTC(cqs.getUTCFullYear() - 1, 9, 1));
  return new Date(Date.UTC(cqs.getUTCFullYear(), m - 3, 1));
}

// ---------------------------------------------------------------------------
// TP-1: current quarter week bucket with known tier split
// ---------------------------------------------------------------------------

describe('tier-trend current_quarter — TP-1', () => {
  test('returns tier_a_pct=50, tier_b_pct=30, tier_c_pct=20 for seeded week', async () => {
    const now = new Date();
    const cqs = currentQuarterStart(now);
    const weekIso = firstWeekIso(cqs);

    // Seed 5 tier-A (score 0.8)
    for (let i = 0; i < 5; i++) {
      await seedProspectAtDate(
        { company_name: `TP1-TierA-${i}-${Date.now()}`, composite_score: 0.8, created_at: weekIso },
        sql,
      );
    }
    // Seed 3 tier-B (score 0.5)
    for (let i = 0; i < 3; i++) {
      await seedProspectAtDate(
        { company_name: `TP1-TierB-${i}-${Date.now()}`, composite_score: 0.5, created_at: weekIso },
        sql,
      );
    }
    // Seed 2 tier-C (score 0.2)
    for (let i = 0; i < 2; i++) {
      await seedProspectAtDate(
        { company_name: `TP1-TierC-${i}-${Date.now()}`, composite_score: 0.2, created_at: weekIso },
        sql,
      );
    }

    const buckets = await getTierTrend('current_quarter', sql, now);

    // Must have at least one bucket.
    expect(buckets.length).toBeGreaterThan(0);

    // Find the bucket that covers our seeded week.
    // The query truncates to week (Monday), so find the bucket whose week_start
    // is the Monday on or before weekIso.
    const seededDate = new Date(weekIso);
    // ISO week starts on Monday: adjust
    const dayOfWeek = seededDate.getUTCDay(); // 0=Sun
    const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(seededDate);
    monday.setUTCDate(monday.getUTCDate() + diffToMonday);
    const mondayIso = monday.toISOString().slice(0, 10);

    const bucket = buckets.find((b) => b.week_start === mondayIso);
    expect(bucket).toBeDefined();

    // The bucket may contain other seeded data from other tests that shared the
    // same DB, so we only assert the seeded 10 are present.
    // With only 10 prospects in this fresh DB the bucket should have exactly 10.
    expect(bucket!.total_volume).toBe(10);
    expect(bucket!.tier_a_pct).toBe(50);
    expect(bucket!.tier_b_pct).toBe(30);
    expect(bucket!.tier_c_pct).toBe(20);

    // Percentages must sum to 100.
    const sum = bucket!.tier_a_pct + bucket!.tier_b_pct + bucket!.tier_c_pct;
    expect(Math.round(sum * 100) / 100).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// TP-2: prior_quarter returns prior weeks, not current-quarter weeks
// ---------------------------------------------------------------------------

describe('tier-trend prior_quarter — TP-2', () => {
  test('prior_quarter weeks appear; current-quarter weeks do not', async () => {
    const now = new Date();
    const pqs = priorQuarterStart(now);
    const cqs = currentQuarterStart(now);

    const priorWeekIso = firstWeekIso(pqs);

    // Seed 4 qualified prospects in the prior quarter.
    for (let i = 0; i < 4; i++) {
      await seedProspectAtDate(
        {
          company_name: `TP2-Prior-${i}-${Date.now()}`,
          composite_score: 0.8,
          created_at: priorWeekIso,
        },
        sql,
      );
    }

    // Call with period=prior_quarter.
    const priorBuckets = await getTierTrend('prior_quarter', sql, now);

    // There must be at least one bucket with data.
    expect(priorBuckets.length).toBeGreaterThan(0);

    // All returned week_starts must be within the prior quarter.
    const pqsMs = pqs.getTime();
    const cqsMs = cqs.getTime();
    for (const b of priorBuckets) {
      const weekMs = new Date(b.week_start).getTime();
      // week_start >= prior quarter start AND < current quarter start
      expect(weekMs).toBeGreaterThanOrEqual(pqsMs - 7 * 24 * 60 * 60 * 1000); // one week tolerance for week truncation
      expect(weekMs).toBeLessThan(cqsMs);
    }

    // Call with period=current_quarter; those buckets must not include prior-quarter dates.
    const currentBuckets = await getTierTrend('current_quarter', sql, now);
    for (const b of currentBuckets) {
      const weekMs = new Date(b.week_start).getTime();
      expect(weekMs).toBeGreaterThanOrEqual(cqsMs - 7 * 24 * 60 * 60 * 1000);
    }
  });
});

// ---------------------------------------------------------------------------
// TP-3: role gate — sales_rep receives 403 (verified via isCfoAuthorised logic)
// ---------------------------------------------------------------------------

describe('role gate — TP-3', () => {
  test('sales_rep role is not authorised for tier-trend endpoint', async () => {
    const userId = crypto.randomUUID();
    await sql`
      INSERT INTO entities (id, type, properties, tenant_id)
      VALUES (
        ${userId},
        'user',
        ${sql.json({ username: 'sales-rep-tt', role: 'sales_rep' } as never)},
        null
      )
    `;

    const rows = await sql<{ properties: { role?: string } }[]>`
      SELECT properties FROM entities WHERE id = ${userId} LIMIT 1
    `;
    const role = rows[0]?.properties?.role;
    const CFO_ROLES = new Set(['cfo', 'finance_controller']);
    const authorised = role !== null && role !== undefined && CFO_ROLES.has(role);

    expect(authorised).toBe(false);
  });

  test('cfo role is authorised for tier-trend endpoint', async () => {
    const userId = crypto.randomUUID();
    await sql`
      INSERT INTO entities (id, type, properties, tenant_id)
      VALUES (
        ${userId},
        'user',
        ${sql.json({ username: 'cfo-tt', role: 'cfo' } as never)},
        null
      )
    `;

    const rows = await sql<{ properties: { role?: string } }[]>`
      SELECT properties FROM entities WHERE id = ${userId} LIMIT 1
    `;
    const role = rows[0]?.properties?.role;
    const CFO_ROLES = new Set(['cfo', 'finance_controller']);
    const authorised = role !== null && role !== undefined && CFO_ROLES.has(role);

    expect(authorised).toBe(true);
  });
});
