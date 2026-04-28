/**
 * @file cfo-portfolio
 *
 * HTTP handlers for the CFO CLTV portfolio dashboard (Phase 2, P2-2, issue #14).
 *
 * ## Endpoints
 *
 *   GET /api/cfo/portfolio
 *     Returns per-segment aggregates for the portfolio view.
 *     Each segment entry includes:
 *       - industry, company_segment
 *       - total_cltv, lead_count, average_composite_score
 *       - score_tier_distribution ({ A, B, C, D } counts)
 *       - entities: array of { prospect_id, macro_inputs_snapshot } for
 *         client-side scenario recomputation
 *     Auth: cfo role or superuser only. Returns 403 for other roles.
 *
 *   GET /api/cfo/portfolio/trend
 *     Returns monthly CLTV totals by tier for the trailing 12 calendar months.
 *     Each entry: { month: 'YYYY-MM', tier_A, tier_B, tier_C, tier_D, total }
 *     Auth: cfo role or superuser only.
 *
 * ## CLTV calculation
 *
 * total_cltv for each segment is derived from each prospect's
 * composite_score (0–100) × annual_revenue_est using the same ±0% mid-point
 * formula used by deriveCLTVRange (i.e. mid = composite_score/100 × revenue).
 * Prospects without a KYC record or with annual_revenue_est = NULL contribute 0.
 *
 * Canonical docs: docs/prd.md §4.3
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/14
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { isSuperuser, makeJson } from '../lib/response';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface PortfolioEntity {
  prospect_id: string;
  macro_inputs_snapshot: unknown;
}

export interface PortfolioSegment {
  industry: string;
  company_segment: string;
  total_cltv: number;
  lead_count: number;
  average_composite_score: number;
  score_tier_distribution: { A: number; B: number; C: number; D: number };
  /** Per-entity snapshots for client-side macro scenario recomputation. */
  entities: PortfolioEntity[];
}

export interface PortfolioResponse {
  segments: PortfolioSegment[];
}

export interface TrendEntry {
  month: string;
  tier_A: number;
  tier_B: number;
  tier_C: number;
  tier_D: number;
  total: number;
}

export interface TrendResponse {
  trend: TrendEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// DB row types
// ─────────────────────────────────────────────────────────────────────────────

interface PortfolioRow {
  prospect_id: string;
  industry: string | null;
  company_segment: string | null;
  composite_score: number | null;
  tier: string | null;
  annual_revenue_est: number | null;
  macro_inputs_snapshot: unknown;
}

interface TrendRow {
  month: string;
  tier: string | null;
  total_cltv: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Role helper
// ─────────────────────────────────────────────────────────────────────────────

async function resolveActorRole(sql: AppState['sql'], userId: string): Promise<string | null> {
  const rows = await sql<{ properties: { role?: string } }[]>`
    SELECT properties
    FROM entities
    WHERE id = ${userId} AND type = 'user'
    LIMIT 1
  `;
  return rows[0]?.properties?.role ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Route handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handles all /api/cfo/* routes.
 *
 * Returns null for any path that does not match — the caller falls through.
 */
export async function handleCfoPortfolioRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/cfo/')) return null;

  const corsHeaders = getCorsHeaders(req);
  const { sql } = appState;
  const json = makeJson(corsHeaders);

  // ── GET /api/cfo/portfolio ───────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/cfo/portfolio') {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    if (!isSuperuser(user.id)) {
      const role = await resolveActorRole(sql, user.id);
      if (role !== 'cfo') {
        return json({ error: 'Forbidden: cfo role required' }, 403);
      }
    }

    // Fetch all prospects with their latest CLTVScore and KYC record.
    const rows = await sql<PortfolioRow[]>`
      SELECT
        p.id                                    AS prospect_id,
        COALESCE(p.industry, 'Unknown')         AS industry,
        COALESCE(p.company_segment, 'Unknown')  AS company_segment,
        cs.composite_score::float8              AS composite_score,
        cs.tier,
        k.annual_revenue_est::float8            AS annual_revenue_est,
        cs.macro_inputs_snapshot
      FROM rl_prospects p
      LEFT JOIN LATERAL (
        SELECT composite_score, tier, macro_inputs_snapshot
        FROM rl_cltv_scores
        WHERE entity_id = p.id AND entity_type = 'prospect'
        ORDER BY computed_at DESC
        LIMIT 1
      ) cs ON true
      LEFT JOIN LATERAL (
        SELECT annual_revenue_est
        FROM rl_kyc_records
        WHERE prospect_id = p.id
          AND verification_status != 'archived'
        ORDER BY created_at DESC
        LIMIT 1
      ) k ON true
      WHERE p.stage != 'disqualified'
      ORDER BY p.industry NULLS LAST, p.company_segment NULLS LAST
    `;

    // Group into segments: industry × company_segment
    type SegmentKey = string;
    const segmentMap = new Map<
      SegmentKey,
      {
        industry: string;
        company_segment: string;
        total_cltv: number;
        lead_count: number;
        score_sum: number;
        score_count: number;
        tier_dist: { A: number; B: number; C: number; D: number };
        entities: PortfolioEntity[];
      }
    >();

    for (const row of rows) {
      const industry = row.industry ?? 'Unknown';
      const company_segment = row.company_segment ?? 'Unknown';
      const key: SegmentKey = `${industry}__${company_segment}`;

      if (!segmentMap.has(key)) {
        segmentMap.set(key, {
          industry,
          company_segment,
          total_cltv: 0,
          lead_count: 0,
          score_sum: 0,
          score_count: 0,
          tier_dist: { A: 0, B: 0, C: 0, D: 0 },
          entities: [],
        });
      }

      const seg = segmentMap.get(key)!;
      seg.lead_count += 1;

      // Compute mid-point CLTV: (composite_score / 100) × annual_revenue_est
      if (
        row.composite_score !== null &&
        row.annual_revenue_est !== null &&
        row.annual_revenue_est > 0
      ) {
        seg.total_cltv += (row.composite_score / 100) * row.annual_revenue_est;
      }

      if (row.composite_score !== null) {
        seg.score_sum += row.composite_score;
        seg.score_count += 1;
      }

      if (row.tier !== null && row.tier in seg.tier_dist) {
        seg.tier_dist[row.tier as 'A' | 'B' | 'C' | 'D'] += 1;
      }

      seg.entities.push({
        prospect_id: row.prospect_id,
        macro_inputs_snapshot: row.macro_inputs_snapshot ?? null,
      });
    }

    const segments: PortfolioSegment[] = [];
    for (const seg of segmentMap.values()) {
      segments.push({
        industry: seg.industry,
        company_segment: seg.company_segment,
        total_cltv: Math.round(seg.total_cltv),
        lead_count: seg.lead_count,
        average_composite_score:
          seg.score_count > 0 ? Math.round((seg.score_sum / seg.score_count) * 100) / 100 : 0,
        score_tier_distribution: seg.tier_dist,
        entities: seg.entities,
      });
    }

    return json({ segments } satisfies PortfolioResponse);
  }

  // ── GET /api/cfo/portfolio/trend ─────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/cfo/portfolio/trend') {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    if (!isSuperuser(user.id)) {
      const role = await resolveActorRole(sql, user.id);
      if (role !== 'cfo') {
        return json({ error: 'Forbidden: cfo role required' }, 403);
      }
    }

    // Build monthly CLTV totals for the trailing 12 calendar months.
    // For each month, sum mid-point CLTV grouped by tier.
    const trendRows = await sql<TrendRow[]>`
      SELECT
        TO_CHAR(DATE_TRUNC('month', cs.computed_at), 'YYYY-MM') AS month,
        cs.tier,
        SUM(
          CASE
            WHEN cs.composite_score IS NOT NULL
              AND k.annual_revenue_est IS NOT NULL
              AND k.annual_revenue_est > 0
            THEN (cs.composite_score::float8 / 100) * k.annual_revenue_est::float8
            ELSE 0
          END
        ) AS total_cltv
      FROM rl_cltv_scores cs
      JOIN rl_prospects p
        ON p.id = cs.entity_id AND cs.entity_type = 'prospect'
      LEFT JOIN LATERAL (
        SELECT annual_revenue_est
        FROM rl_kyc_records
        WHERE prospect_id = p.id
          AND verification_status != 'archived'
        ORDER BY created_at DESC
        LIMIT 1
      ) k ON true
      WHERE cs.computed_at >= DATE_TRUNC('month', NOW()) - INTERVAL '11 months'
        AND p.stage != 'disqualified'
      GROUP BY DATE_TRUNC('month', cs.computed_at), cs.tier
      ORDER BY DATE_TRUNC('month', cs.computed_at)
    `;

    // Build a map of month → tier totals
    const monthMap = new Map<string, { A: number; B: number; C: number; D: number }>();

    // Pre-populate the trailing 12 months with zeroes so missing months appear.
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      monthMap.set(key, { A: 0, B: 0, C: 0, D: 0 });
    }

    for (const row of trendRows) {
      if (!monthMap.has(row.month)) continue;
      const entry = monthMap.get(row.month)!;
      const tier = row.tier as 'A' | 'B' | 'C' | 'D';
      if (tier in entry) {
        entry[tier] += Math.round(Number(row.total_cltv));
      }
    }

    const trend: TrendEntry[] = [];
    for (const [month, tiers] of monthMap.entries()) {
      trend.push({
        month,
        tier_A: tiers.A,
        tier_B: tiers.B,
        tier_C: tiers.C,
        tier_D: tiers.D,
        total: tiers.A + tiers.B + tiers.C + tiers.D,
      });
    }

    return json({ trend } satisfies TrendResponse);
  }

  return null;
}
