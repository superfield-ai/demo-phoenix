/**
 * @file cfo-tier-trend.ts
 *
 * Database query functions for the CFO tier trend chart (issue #15).
 *
 * GET /api/cfo/tier-trend?period=current_quarter|prior_quarter
 *
 * Returns one bucket per ISO week in the requested quarter. Each bucket
 * contains:
 *   - week_start   ISO-8601 date of the Monday that starts the week
 *   - tier_a_pct   % of qualified prospects scored as tier A (composite >= 0.7)
 *   - tier_b_pct   % of qualified prospects scored as tier B (0.4 <= composite < 0.7)
 *   - tier_c_pct   % of qualified prospects scored as tier C (composite < 0.4)
 *   - total_volume count of qualified prospects in that week
 *
 * The query groups qualified rl_prospects by the ISO week of created_at and
 * joins the most recent rl_cltv_scores row per prospect to derive the tier.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/15
 */

import type postgres from 'postgres';
import { sql as defaultSql } from './index';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TierTrendPeriod = 'current_quarter' | 'prior_quarter';

export interface TierTrendBucket {
  /** ISO date string (YYYY-MM-DD) of the Monday starting the week. */
  week_start: string;
  tier_a_pct: number;
  tier_b_pct: number;
  tier_c_pct: number;
  total_volume: number;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Returns the first day of the current calendar quarter (UTC) as a JS Date.
 */
function currentQuarterStart(now: Date = new Date()): Date {
  const month = now.getUTCMonth(); // 0-indexed
  const quarterStartMonth = Math.floor(month / 3) * 3;
  return new Date(Date.UTC(now.getUTCFullYear(), quarterStartMonth, 1));
}

/**
 * Returns the first day of the prior calendar quarter (UTC) as a JS Date.
 */
function priorQuarterStart(now: Date = new Date()): Date {
  const cqs = currentQuarterStart(now);
  const m = cqs.getUTCMonth();
  if (m === 0) {
    return new Date(Date.UTC(cqs.getUTCFullYear() - 1, 9, 1)); // Q4 of prior year
  }
  return new Date(Date.UTC(cqs.getUTCFullYear(), m - 3, 1));
}

// ---------------------------------------------------------------------------
// Main query
// ---------------------------------------------------------------------------

/**
 * Returns weekly tier-distribution buckets for the requested quarter.
 *
 * Uses ISO week grouping: each week starts on Monday (DATE_TRUNC('week', ...)).
 *
 * Only qualified prospects are counted. Tier is derived from the most recent
 * rl_cltv_scores row for each prospect. Prospects without a score are assigned
 * tier C (as the lowest tier).
 *
 * Percentages are rounded to two decimal places and guaranteed to sum to 100
 * within each week (last tier absorbs any rounding remainder).
 *
 * @param period    'current_quarter' or 'prior_quarter'
 * @param sqlClient Optional postgres.js client (defaults to the app pool).
 * @param now       Optional reference time for quarter boundary calculation (used in tests).
 */
export async function getTierTrend(
  period: TierTrendPeriod,
  sqlClient: postgres.Sql = defaultSql,
  now: Date = new Date(),
): Promise<TierTrendBucket[]> {
  const qs = period === 'current_quarter' ? currentQuarterStart(now) : priorQuarterStart(now);

  // End of the quarter = start of the next quarter
  const qsNext =
    period === 'current_quarter'
      ? new Date(Date.UTC(qs.getUTCFullYear(), qs.getUTCMonth() + 3, 1))
      : currentQuarterStart(now);

  const qsIso = qs.toISOString();
  const qsNextIso = qsNext.toISOString();

  type RawRow = {
    // postgres.js returns DATE columns as JS Date objects
    week_start: Date | string;
    tier_a: string;
    tier_b: string;
    tier_c: string;
    total_volume: string;
  };

  const rows = await sqlClient<RawRow[]>`
    WITH latest_scores AS (
      SELECT DISTINCT ON (entity_id)
        entity_id,
        composite_score,
        CASE
          WHEN composite_score >= 0.7 THEN 'A'
          WHEN composite_score >= 0.4 THEN 'B'
          ELSE 'C'
        END AS tier
      FROM rl_cltv_scores
      WHERE entity_type = 'prospect'
        AND composite_score IS NOT NULL
      ORDER BY entity_id, created_at DESC
    )
    SELECT
      DATE_TRUNC('week', p.created_at)::DATE AS week_start,
      COUNT(*) FILTER (WHERE COALESCE(ls.tier, 'C') = 'A') AS tier_a,
      COUNT(*) FILTER (WHERE COALESCE(ls.tier, 'C') = 'B') AS tier_b,
      COUNT(*) FILTER (WHERE COALESCE(ls.tier, 'C') = 'C') AS tier_c,
      COUNT(*) AS total_volume
    FROM rl_prospects p
    LEFT JOIN latest_scores ls ON ls.entity_id = p.id
    WHERE p.stage = 'qualified'
      AND p.created_at >= ${qsIso}::timestamptz
      AND p.created_at < ${qsNextIso}::timestamptz
    GROUP BY DATE_TRUNC('week', p.created_at)::DATE
    ORDER BY week_start ASC
  `;

  return rows.map((row) => {
    // postgres.js may return a DATE column as a JS Date or as a string; normalise to YYYY-MM-DD.
    const weekStartRaw = row.week_start;
    const week_start =
      weekStartRaw instanceof Date
        ? weekStartRaw.toISOString().slice(0, 10)
        : String(weekStartRaw).slice(0, 10);

    const total = parseInt(row.total_volume, 10);
    const a = parseInt(row.tier_a, 10);
    const b = parseInt(row.tier_b, 10);

    if (total === 0) {
      return {
        week_start,
        tier_a_pct: 0,
        tier_b_pct: 0,
        tier_c_pct: 0,
        total_volume: 0,
      };
    }

    // Round A and B; assign remainder to C to guarantee sum = 100.
    const aPct = Math.round((a / total) * 100 * 100) / 100;
    const bPct = Math.round((b / total) * 100 * 100) / 100;
    const cPct = Math.round((100 - aPct - bPct) * 100) / 100;

    return {
      week_start,
      tier_a_pct: aPct,
      tier_b_pct: bPct,
      tier_c_pct: cPct,
      total_volume: total,
    };
  });
}

// ---------------------------------------------------------------------------
// Seed helpers for tests
// ---------------------------------------------------------------------------

export interface SeedProspectAtDateOptions {
  company_name: string;
  stage?: 'new' | 'kyc_pending' | 'kyc_manual_review' | 'scored' | 'qualified' | 'disqualified';
  composite_score?: number;
  /** ISO timestamp to set as created_at (overrides NOW()). */
  created_at: string;
}

/**
 * Inserts a prospect with a specific created_at timestamp (for tier-trend tests).
 * Optionally inserts a matching rl_cltv_scores row.
 */
export async function seedProspectAtDate(
  opts: SeedProspectAtDateOptions,
  sqlClient: postgres.Sql = defaultSql,
): Promise<{ id: string }> {
  const { company_name, stage = 'qualified', composite_score, created_at } = opts;

  const [row] = await sqlClient<{ id: string }[]>`
    INSERT INTO rl_prospects
      (company_name, stage, created_at, updated_at)
    VALUES (
      ${company_name},
      ${stage},
      ${created_at}::timestamptz,
      ${created_at}::timestamptz
    )
    RETURNING id
  `;

  if (composite_score !== undefined) {
    await sqlClient`
      INSERT INTO rl_cltv_scores
        (entity_id, entity_type, composite_score, score_version, created_at, computed_at)
      VALUES
        (${row.id}, 'prospect', ${composite_score}, 'test-v1',
         ${created_at}::timestamptz, ${created_at}::timestamptz)
    `;
  }

  return row;
}
