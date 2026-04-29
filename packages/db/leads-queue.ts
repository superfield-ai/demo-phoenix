/**
 * @file leads-queue
 *
 * Database query helpers for the Sales Rep lead queue (Phase 1, P1-1).
 *
 * ## Tables accessed
 *
 *   rl_prospects      — the lead record (stage, assigned_rep_id, disqualification_reason …)
 *   rl_cltv_scores    — the most-recent composite score for a prospect
 *   rl_kyc_records    — KYC verification status
 *
 * ## Row shapes
 *
 *   QueueLeadRow        — a row returned by getQueueLeads (qualified leads)
 *   DisqualifiedLeadRow — a row returned by getDisqualifiedLeads
 *
 * ## Query semantics
 *
 *   getQueueLeads:
 *     - Returns stage='qualified' prospects assigned to the requesting rep.
 *     - Joins the most-recent rl_cltv_scores row per prospect (DISTINCT ON).
 *     - Sort: composite_score DESC (default), cltv_low DESC, days_in_queue DESC.
 *     - Filters: tier, industry, days_min/days_max, rep_id.
 *
 *   getDisqualifiedLeads:
 *     - Returns stage='disqualified' prospects assigned to the requesting rep.
 *     - Includes disqualification_reason. No mutating actions exposed.
 *
 *   getPendingKycCount:
 *     - Returns the count of stage='kyc_pending' prospects for the rep.
 *     - Used by the empty-state message.
 *
 * Canonical docs: docs/prd.md §4.1
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/7
 */

import type postgres from 'postgres';
import { sql as defaultSql } from './index';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Score tier derived from composite_score: A ≥ 0.7, B ≥ 0.4, C < 0.4. */
export type ScoreTier = 'A' | 'B' | 'C';

/** KYC status values as stored in rl_kyc_records.verification_status. */
export type KycVerificationStatus = 'pending' | 'verified' | 'failed' | 'archived';

/** Sort options for the lead queue. */
export type LeadQueueSort = 'score' | 'cltv' | 'days';

/** Filter options for the lead queue. */
export interface LeadQueueFilters {
  tier?: string[];
  industry?: string[];
  days_min?: number;
  days_max?: number;
  rep_id?: string;
}

/** A single row in the qualified lead queue. */
export interface QueueLeadRow {
  id: string;
  company_name: string;
  industry: string | null;
  sic_code: string | null;
  assigned_rep_id: string | null;
  /** Days since the prospect was created. */
  days_in_queue: number;
  /** Most-recent composite score (null when not yet scored). */
  composite_score: number | null;
  /** Derived score tier: A / B / C (null when score is absent). */
  score_tier: ScoreTier | null;
  /** CLTV low estimate (composite_score * 0.8 * 1 000 000, rounded). */
  cltv_low: number | null;
  /** CLTV high estimate (composite_score * 1.2 * 1 000 000, rounded). */
  cltv_high: number | null;
  /** KYC verification status from the most-recent active rl_kyc_records row. */
  kyc_status: KycVerificationStatus | null;
  /** Most-recent Deal stage for this prospect (null when no Deal exists). */
  deal_stage: string | null;
  /** Timestamp of the most-recent activity for this prospect (null when none). */
  last_activity_at: Date | null;
  created_at: Date;
  /**
   * Follow-up nudge: true when deal_stage = 'contacted' AND days since
   * last_activity_at > NUDGE_DAYS_THRESHOLD.  Computed by the API layer.
   */
  nudge: boolean;
  /**
   * True when the prospect has no CLTVScore row yet (composite_score === null),
   * meaning the scoring engine is still running.  The UI shows a "Scoring…"
   * badge in the queue row instead of hiding the prospect entirely.
   */
  scoring_in_progress: boolean;
}

/** A single row in the disqualified lead list. */
export interface DisqualifiedLeadRow {
  id: string;
  company_name: string;
  industry: string | null;
  sic_code: string | null;
  assigned_rep_id: string | null;
  disqualification_reason: string | null;
  disqualified_at: Date | null;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derives a score tier from a composite_score value.
 *
 * Thresholds: A ≥ 0.7 (green), B ≥ 0.4 (yellow), C < 0.4 (orange).
 */
export function deriveTier(score: number | null): ScoreTier | null {
  if (score === null) return null;
  if (score >= 0.7) return 'A';
  if (score >= 0.4) return 'B';
  return 'C';
}

// ---------------------------------------------------------------------------
// Query: qualified lead queue
// ---------------------------------------------------------------------------

/**
 * Returns qualified leads for the given rep, ranked by the requested sort key.
 *
 * The rep can only see leads assigned to themselves (`assigned_rep_id = repId`).
 *
 * @param repId    The authenticated rep's user ID.
 * @param sort     Sort mode: 'score' (default), 'cltv', 'days'.
 * @param filters  Optional filter constraints.
 * @param sqlClient Optional sql client override (for tests).
 */
export async function getQueueLeads(
  repId: string,
  sort: LeadQueueSort = 'score',
  filters: LeadQueueFilters = {},
  sqlClient: postgres.Sql = defaultSql,
  env: NodeJS.ProcessEnv = process.env,
): Promise<QueueLeadRow[]> {
  // Build the ORDER BY clause from the sort parameter.
  // All three sort modes fall back to composite_score DESC as a tiebreaker.
  const orderBy =
    sort === 'cltv'
      ? sqlClient`ORDER BY cltv_high DESC NULLS LAST, composite_score DESC NULLS LAST`
      : sort === 'days'
        ? sqlClient`ORDER BY days_in_queue DESC, composite_score DESC NULLS LAST`
        : sqlClient`ORDER BY composite_score DESC NULLS LAST, days_in_queue DESC`;

  // Build dynamic WHERE fragments for optional filters.
  const tierFilter =
    filters.tier && filters.tier.length > 0
      ? sqlClient`AND score_tier = ANY(${filters.tier})`
      : sqlClient``;

  const industryFilter =
    filters.industry && filters.industry.length > 0
      ? sqlClient`AND p.industry = ANY(${filters.industry})`
      : sqlClient``;

  const daysMinFilter =
    filters.days_min !== undefined
      ? sqlClient`AND EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 86400 >= ${filters.days_min}`
      : sqlClient``;

  const daysMaxFilter =
    filters.days_max !== undefined
      ? sqlClient`AND EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 86400 <= ${filters.days_max}`
      : sqlClient``;

  // rep_id filter: superusers may pass a rep_id to see another rep's queue.
  // Normal reps always see only their own queue (enforced by WHERE p.assigned_rep_id = repId).
  const repIdFilter =
    filters.rep_id !== undefined
      ? sqlClient`AND p.assigned_rep_id = ${filters.rep_id}`
      : sqlClient``;

  type RawRow = {
    id: string;
    company_name: string;
    industry: string | null;
    sic_code: string | null;
    assigned_rep_id: string | null;
    days_in_queue: string;
    composite_score: string | null;
    kyc_status: KycVerificationStatus | null;
    deal_stage: string | null;
    last_activity_at: Date | null;
    created_at: Date;
  };

  const rows = (await sqlClient<RawRow[]>`
    WITH scored AS (
      SELECT DISTINCT ON (entity_id)
        entity_id,
        composite_score
      FROM rl_cltv_scores
      WHERE entity_type = 'prospect'
      ORDER BY entity_id, computed_at DESC
    ),
    kyc AS (
      SELECT DISTINCT ON (prospect_id)
        prospect_id,
        verification_status AS kyc_status
      FROM rl_kyc_records
      WHERE verification_status != 'archived'
      ORDER BY prospect_id, created_at DESC
    ),
    latest_deal AS (
      SELECT DISTINCT ON (prospect_id)
        prospect_id,
        stage AS deal_stage
      FROM rl_deals
      ORDER BY prospect_id, created_at DESC
    ),
    latest_activity AS (
      SELECT DISTINCT ON (prospect_id)
        prospect_id,
        occurred_at AS last_activity_at
      FROM rl_activities
      ORDER BY prospect_id, occurred_at DESC
    ),
    base AS (
      SELECT
        p.id,
        p.company_name,
        p.industry,
        p.sic_code,
        p.assigned_rep_id,
        p.created_at,
        FLOOR(EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 86400)::INTEGER AS days_in_queue,
        s.composite_score,
        k.kyc_status,
        ld.deal_stage,
        la.last_activity_at,
        CASE
          WHEN s.composite_score >= 0.7 THEN 'A'
          WHEN s.composite_score >= 0.4 THEN 'B'
          WHEN s.composite_score IS NOT NULL THEN 'C'
          ELSE NULL
        END AS score_tier,
        ROUND((s.composite_score * 0.8 * 1000000)::NUMERIC, 0)::BIGINT AS cltv_low,
        ROUND((s.composite_score * 1.2 * 1000000)::NUMERIC, 0)::BIGINT AS cltv_high
      FROM rl_prospects p
      LEFT JOIN scored        s  ON s.entity_id = p.id
      LEFT JOIN kyc           k  ON k.prospect_id = p.id
      LEFT JOIN latest_deal   ld ON ld.prospect_id = p.id
      LEFT JOIN latest_activity la ON la.prospect_id = p.id
      WHERE p.stage = 'qualified'
        AND p.assigned_rep_id = ${repId}
        ${industryFilter}
        ${daysMinFilter}
        ${daysMaxFilter}
        ${repIdFilter}
    )
    SELECT *
    FROM base
    WHERE 1=1
      ${tierFilter}
    ${orderBy}
  `) as RawRow[];

  const nudgeDays = resolveNudgeDaysThreshold(env);

  return rows.map((r: RawRow) => {
    const score = r.composite_score !== null ? parseFloat(r.composite_score) : null;

    // Compute nudge: deal in contacted stage AND last activity older than threshold.
    let nudge = false;
    if (r.deal_stage === 'contacted') {
      const refTime = r.last_activity_at ? r.last_activity_at.getTime() : r.created_at.getTime();
      const daysSince = (Date.now() - refTime) / (1000 * 60 * 60 * 24);
      nudge = daysSince > nudgeDays;
    }

    return {
      id: r.id,
      company_name: r.company_name,
      industry: r.industry,
      sic_code: r.sic_code,
      assigned_rep_id: r.assigned_rep_id,
      days_in_queue: parseInt(r.days_in_queue, 10),
      composite_score: score,
      score_tier: deriveTier(score),
      cltv_low: score !== null ? Math.round(score * 0.8 * 1_000_000) : null,
      cltv_high: score !== null ? Math.round(score * 1.2 * 1_000_000) : null,
      kyc_status: r.kyc_status,
      deal_stage: r.deal_stage,
      last_activity_at: r.last_activity_at,
      created_at: r.created_at,
      nudge,
      scoring_in_progress: score === null,
    };
  });
}

// ---------------------------------------------------------------------------
// Config helper: nudge threshold
// ---------------------------------------------------------------------------

/**
 * Resolves the nudge threshold from the environment.
 *
 * Reads NUDGE_DAYS_THRESHOLD; defaults to 7 if missing or unparseable.
 */
export function resolveNudgeDaysThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.NUDGE_DAYS_THRESHOLD;
  if (!raw) return 7;
  const parsed = parseInt(raw, 10);
  return isNaN(parsed) || parsed < 0 ? 7 : parsed;
}

// ---------------------------------------------------------------------------
// Query: disqualified lead list
// ---------------------------------------------------------------------------

/**
 * Returns disqualified leads for the given rep (read-only).
 *
 * @param repId    The authenticated rep's user ID.
 * @param sqlClient Optional sql client override (for tests).
 */
export async function getDisqualifiedLeads(
  repId: string,
  sqlClient: postgres.Sql = defaultSql,
): Promise<DisqualifiedLeadRow[]> {
  const rows = await sqlClient<DisqualifiedLeadRow[]>`
    SELECT
      id,
      company_name,
      industry,
      sic_code,
      assigned_rep_id,
      disqualification_reason,
      disqualified_at,
      created_at
    FROM rl_prospects
    WHERE stage = 'disqualified'
      AND assigned_rep_id = ${repId}
    ORDER BY disqualified_at DESC NULLS LAST, created_at DESC
  `;
  return rows;
}

// ---------------------------------------------------------------------------
// Query: pending KYC count (for empty state)
// ---------------------------------------------------------------------------

/**
 * Returns the count of prospects in stage='kyc_pending' assigned to the rep.
 *
 * Used by the empty-state message when the queue is empty.
 *
 * @param repId    The authenticated rep's user ID.
 * @param sqlClient Optional sql client override (for tests).
 */
export async function getPendingKycCount(
  repId: string,
  sqlClient: postgres.Sql = defaultSql,
): Promise<number> {
  const rows = await sqlClient<{ count: string }[]>`
    SELECT COUNT(*)::TEXT AS count
    FROM rl_prospects
    WHERE stage = 'kyc_pending'
      AND assigned_rep_id = ${repId}
  `;
  return parseInt(rows[0]?.count ?? '0', 10);
}

// ---------------------------------------------------------------------------
// Seed helpers (used by tests and integration scenarios)
// ---------------------------------------------------------------------------

export interface SeedProspectOptions {
  company_name: string;
  industry?: string;
  sic_code?: string;
  stage?: 'new' | 'kyc_pending' | 'kyc_manual_review' | 'scored' | 'qualified' | 'disqualified';
  assigned_rep_id?: string;
  composite_score?: number;
  disqualification_reason?: string;
}

/**
 * Inserts a prospect into rl_prospects (and optionally a CLTV score) for
 * integration tests. Not called from production code paths.
 */
export async function seedProspect(
  opts: SeedProspectOptions,
  sqlClient: postgres.Sql = defaultSql,
): Promise<{ id: string }> {
  const {
    company_name,
    industry = null,
    sic_code = null,
    stage = 'new',
    assigned_rep_id = null,
    composite_score,
    disqualification_reason = null,
  } = opts;

  const [row] = await sqlClient<{ id: string }[]>`
    INSERT INTO rl_prospects
      (company_name, industry, sic_code, stage, assigned_rep_id, disqualification_reason,
       disqualified_at)
    VALUES (
      ${company_name},
      ${industry},
      ${sic_code},
      ${stage},
      ${assigned_rep_id},
      ${disqualification_reason},
      ${stage === 'disqualified' ? sqlClient`NOW()` : sqlClient`NULL`}
    )
    RETURNING id
  `;

  if (composite_score !== undefined) {
    await sqlClient`
      INSERT INTO rl_cltv_scores
        (entity_id, entity_type, composite_score, score_version)
      VALUES
        (${row.id}, 'prospect', ${composite_score}, 'test-v1')
    `;
  }

  return row;
}
