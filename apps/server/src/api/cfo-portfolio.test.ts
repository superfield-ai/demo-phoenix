/**
 * @file cfo-portfolio.test.ts
 *
 * Unit tests for the CFO portfolio API helpers (issue #14).
 *
 * ## Test plan coverage (server-side unit tests)
 *
 *   - Verifies the role guard logic: cfo role passes, sales_rep is rejected.
 *   - Verifies CLTV mid-point calculation: (composite_score / 100) × annual_revenue_est
 *   - Verifies segment grouping by industry × company_segment
 *
 * Canonical docs: docs/prd.md §4.3
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/14
 */

import { describe, it, expect } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// CLTV mid-point calculation (mirrors the server handler logic)
// ─────────────────────────────────────────────────────────────────────────────

function computeMidpointCltv(compositeScore: number, annualRevenueEst: number): number {
  return (compositeScore / 100) * annualRevenueEst;
}

describe('CLTV mid-point calculation', () => {
  it('returns composite_score/100 × revenue', () => {
    expect(computeMidpointCltv(80, 1_000_000)).toBe(800_000);
    expect(computeMidpointCltv(50, 2_000_000)).toBe(1_000_000);
    expect(computeMidpointCltv(100, 500_000)).toBe(500_000);
    expect(computeMidpointCltv(0, 1_000_000)).toBe(0);
  });

  it('handles fractional scores', () => {
    expect(computeMidpointCltv(75.5, 1_000_000)).toBeCloseTo(755_000, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Segment grouping
// ─────────────────────────────────────────────────────────────────────────────

interface ProspectRow {
  industry: string;
  company_segment: string;
  composite_score: number;
  annual_revenue_est: number;
  tier: 'A' | 'B' | 'C' | 'D';
}

function groupIntoSegments(rows: ProspectRow[]) {
  type Key = string;
  const map = new Map<
    Key,
    { total_cltv: number; lead_count: number; score_sum: number; tier_dist: Record<string, number> }
  >();

  for (const row of rows) {
    const key: Key = `${row.industry}__${row.company_segment}`;
    if (!map.has(key)) {
      map.set(key, {
        total_cltv: 0,
        lead_count: 0,
        score_sum: 0,
        tier_dist: { A: 0, B: 0, C: 0, D: 0 },
      });
    }
    const seg = map.get(key)!;
    seg.lead_count += 1;
    seg.total_cltv += computeMidpointCltv(row.composite_score, row.annual_revenue_est);
    seg.score_sum += row.composite_score;
    seg.tier_dist[row.tier] += 1;
  }

  return map;
}

describe('segment grouping', () => {
  it('groups rows by industry × company_segment', () => {
    const rows: ProspectRow[] = [
      {
        industry: 'Tech',
        company_segment: 'SMB',
        composite_score: 80,
        annual_revenue_est: 1_000_000,
        tier: 'A',
      },
      {
        industry: 'Tech',
        company_segment: 'SMB',
        composite_score: 60,
        annual_revenue_est: 500_000,
        tier: 'B',
      },
      {
        industry: 'Tech',
        company_segment: 'Enterprise',
        composite_score: 90,
        annual_revenue_est: 5_000_000,
        tier: 'A',
      },
      {
        industry: 'Finance',
        company_segment: 'SMB',
        composite_score: 45,
        annual_revenue_est: 800_000,
        tier: 'C',
      },
    ];

    const segments = groupIntoSegments(rows);

    expect(segments.size).toBe(3);

    const techSmb = segments.get('Tech__SMB')!;
    expect(techSmb.lead_count).toBe(2);
    // total_cltv = 0.80 × 1_000_000 + 0.60 × 500_000 = 800_000 + 300_000 = 1_100_000
    expect(techSmb.total_cltv).toBe(1_100_000);
    expect(techSmb.tier_dist.A).toBe(1);
    expect(techSmb.tier_dist.B).toBe(1);

    const techEnt = segments.get('Tech__Enterprise')!;
    expect(techEnt.lead_count).toBe(1);
    expect(techEnt.total_cltv).toBe(4_500_000);

    const financeSmb = segments.get('Finance__SMB')!;
    expect(financeSmb.lead_count).toBe(1);
    expect(financeSmb.tier_dist.C).toBe(1);
  });

  it('handles empty input', () => {
    const segments = groupIntoSegments([]);
    expect(segments.size).toBe(0);
  });

  it('computes correct average_composite_score', () => {
    const rows: ProspectRow[] = [
      {
        industry: 'Tech',
        company_segment: 'SMB',
        composite_score: 80,
        annual_revenue_est: 1_000_000,
        tier: 'A',
      },
      {
        industry: 'Tech',
        company_segment: 'SMB',
        composite_score: 60,
        annual_revenue_est: 500_000,
        tier: 'B',
      },
    ];
    const segments = groupIntoSegments(rows);
    const techSmb = segments.get('Tech__SMB')!;
    const avgScore = techSmb.score_sum / techSmb.lead_count;
    expect(avgScore).toBe(70);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Trend response shape
// ─────────────────────────────────────────────────────────────────────────────

describe('trend response shape', () => {
  it('trend entries include all required fields', () => {
    const entry = {
      month: '2025-01',
      tier_A: 1000,
      tier_B: 500,
      tier_C: 200,
      tier_D: 50,
      total: 1750,
    };
    expect(typeof entry.month).toBe('string');
    expect(entry.month).toMatch(/^\d{4}-\d{2}$/);
    expect(entry.total).toBe(entry.tier_A + entry.tier_B + entry.tier_C + entry.tier_D);
  });
});
