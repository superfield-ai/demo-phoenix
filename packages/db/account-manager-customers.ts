/**
 * @file account-manager-customers.ts
 *
 * Database query functions for the Account Manager customer health dashboard
 * (issue #55).
 *
 * ## Exported functions
 *
 *   listCustomersForAccountManager  — customers assigned to an AM, sorted by
 *                                     health_score ASC with alert metadata.
 *   getCustomerHealthDetail         — full detail: signals, 30-day score trend.
 *
 * ## Health alert threshold
 *
 * A customer is considered "at risk" when health_score < HEALTH_ALERT_THRESHOLD.
 * The threshold is 0.70 (PRD §2).  When a customer is at risk, alert_days is
 * the number of calendar days since health_score first dropped below the
 * threshold with no intervening resolved intervention.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/55
 */

import type postgres from 'postgres';
import { sql as defaultSql } from './index';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Health score below which a customer is flagged as at-risk. */
export const HEALTH_ALERT_THRESHOLD = 0.7;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CustomerHealthRow {
  id: string;
  company_name: string;
  segment: string | null;
  health_score: number | null;
  /** Trend relative to the score 7 days ago: 'up' | 'down' | 'stable' */
  trend: 'up' | 'down' | 'stable';
  /** True when health_score < HEALTH_ALERT_THRESHOLD */
  has_alert: boolean;
  /** Days since the alert first opened (no intervention), or null when no alert. */
  alert_days: number | null;
}

export interface HealthSignal {
  id: string;
  source_label: string;
  contribution: number;
  recorded_at: string;
}

export interface CustomerHealthDetail extends CustomerHealthRow {
  /** Most-recent signals for this customer, ordered by |contribution| DESC. */
  signals: HealthSignal[];
  /**
   * 30-day score history, one entry per available snapshot, oldest first.
   * Used by the frontend to render a sparkline.
   */
  score_history: Array<{ recorded_at: string; score: number }>;
}

// ---------------------------------------------------------------------------
// List customers for an account manager
// ---------------------------------------------------------------------------

/**
 * Returns all customers assigned to `account_manager_id`, sorted by
 * health_score ascending (most at-risk first, nulls last).
 *
 * Trend is derived by comparing the current score to the closest snapshot
 * recorded 7 days ago (±1 day window).
 *
 * Alert days are computed as the number of calendar days since the oldest
 * score-history snapshot below the warning threshold that has not been
 * followed by a resolved intervention.
 */
export async function listCustomersForAccountManager(
  account_manager_id: string,
  sqlClient: ReturnType<typeof postgres> = defaultSql as unknown as ReturnType<typeof postgres>,
): Promise<CustomerHealthRow[]> {
  const rows = await sqlClient<
    {
      id: string;
      company_name: string;
      segment: string | null;
      health_score: string | null;
      score_7d_ago: string | null;
      alert_started_at: string | null;
    }[]
  >`
    WITH current_customers AS (
      SELECT id, company_name, segment, health_score
      FROM rl_customers
      WHERE account_manager_id = ${account_manager_id}
    ),

    -- Most-recent health_score_history snapshot per customer older than 7 days
    -- (within a ±24 h window around exactly 7 days ago).
    score_7d AS (
      SELECT DISTINCT ON (h.customer_id)
        h.customer_id,
        h.score AS score_7d_ago
      FROM rl_health_score_history h
      INNER JOIN current_customers c ON c.id = h.customer_id
      WHERE h.recorded_at BETWEEN NOW() - INTERVAL '8 days' AND NOW() - INTERVAL '6 days'
      ORDER BY h.customer_id, ABS(EXTRACT(EPOCH FROM (h.recorded_at - (NOW() - INTERVAL '7 days'))))
    ),

    -- Earliest snapshot below threshold that has no resolved intervention after it.
    alert_start AS (
      SELECT h.customer_id,
             MIN(h.recorded_at) AS alert_started_at
      FROM rl_health_score_history h
      INNER JOIN current_customers c ON c.id = h.customer_id
      WHERE h.score < ${HEALTH_ALERT_THRESHOLD}
        AND NOT EXISTS (
          SELECT 1
          FROM rl_interventions i
          WHERE i.customer_id = h.customer_id
            AND i.status = 'resolved'
            AND i.resolved_at > h.recorded_at
        )
      GROUP BY h.customer_id
    )

    SELECT
      c.id,
      c.company_name,
      c.segment,
      c.health_score::text,
      s.score_7d_ago::text,
      a.alert_started_at::text
    FROM current_customers c
    LEFT JOIN score_7d    s ON s.customer_id = c.id
    LEFT JOIN alert_start a ON a.customer_id = c.id
    ORDER BY
      CASE WHEN c.health_score IS NULL THEN 1 ELSE 0 END,
      c.health_score ASC
  `;

  return rows.map((r) => {
    const score = r.health_score !== null ? parseFloat(r.health_score) : null;
    const score7d = r.score_7d_ago !== null ? parseFloat(r.score_7d_ago) : null;

    let trend: 'up' | 'down' | 'stable' = 'stable';
    if (score !== null && score7d !== null) {
      const delta = score - score7d;
      if (delta > 0.01) trend = 'up';
      else if (delta < -0.01) trend = 'down';
    }

    const hasAlert = score !== null && score < HEALTH_ALERT_THRESHOLD;
    let alertDays: number | null = null;
    if (hasAlert && r.alert_started_at) {
      const diffMs = Date.now() - new Date(r.alert_started_at).getTime();
      alertDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    }

    return {
      id: r.id,
      company_name: r.company_name,
      segment: r.segment,
      health_score: score,
      trend,
      has_alert: hasAlert,
      alert_days: alertDays,
    };
  });
}

// ---------------------------------------------------------------------------
// Customer health detail
// ---------------------------------------------------------------------------

/**
 * Returns full health detail for a single customer: current row data,
 * contributing signals, and 30-day score history.
 *
 * Returns null when the customer does not exist or is not assigned to
 * `account_manager_id`.
 */
export async function getCustomerHealthDetail(
  customer_id: string,
  account_manager_id: string,
  sqlClient: ReturnType<typeof postgres> = defaultSql as unknown as ReturnType<typeof postgres>,
): Promise<CustomerHealthDetail | null> {
  // First verify ownership.
  const customerRows = await sqlClient<
    { id: string; company_name: string; segment: string | null; health_score: string | null }[]
  >`
    SELECT id, company_name, segment, health_score::text
    FROM rl_customers
    WHERE id = ${customer_id}
      AND account_manager_id = ${account_manager_id}
    LIMIT 1
  `;

  if (customerRows.length === 0) return null;
  const c = customerRows[0];

  // Signals — most-recent per source_label.
  const signalRows = await sqlClient<
    { id: string; source_label: string; contribution: string; recorded_at: string }[]
  >`
    SELECT DISTINCT ON (source_label)
      id, source_label, contribution::text, recorded_at::text
    FROM rl_health_signals
    WHERE customer_id = ${customer_id}
    ORDER BY source_label, recorded_at DESC
  `;

  // 30-day score history — up to one per day.
  const historyRows = await sqlClient<{ recorded_at: string; score: string }[]>`
    SELECT DISTINCT ON (DATE_TRUNC('day', recorded_at))
      recorded_at::text,
      score::text
    FROM rl_health_score_history
    WHERE customer_id = ${customer_id}
      AND recorded_at >= NOW() - INTERVAL '30 days'
    ORDER BY DATE_TRUNC('day', recorded_at), recorded_at DESC
  `;

  // Alert meta — reuse same logic as list.
  const score = c.health_score !== null ? parseFloat(c.health_score) : null;
  const hasAlert = score !== null && score < HEALTH_ALERT_THRESHOLD;

  let alertDays: number | null = null;
  if (hasAlert) {
    const alertRows = await sqlClient<{ alert_started_at: string | null }[]>`
      SELECT MIN(recorded_at)::text AS alert_started_at
      FROM rl_health_score_history
      WHERE customer_id = ${customer_id}
        AND score < ${HEALTH_ALERT_THRESHOLD}
        AND NOT EXISTS (
          SELECT 1
          FROM rl_interventions i
          WHERE i.customer_id = ${customer_id}
            AND i.status = 'resolved'
            AND i.resolved_at > rl_health_score_history.recorded_at
        )
    `;
    const alertStartedAt = alertRows[0]?.alert_started_at;
    if (alertStartedAt) {
      const diffMs = Date.now() - new Date(alertStartedAt).getTime();
      alertDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    }
  }

  // Trend relative to 7 days ago.
  const historyForTrend = await sqlClient<{ score: string }[]>`
    SELECT score::text
    FROM rl_health_score_history
    WHERE customer_id = ${customer_id}
      AND recorded_at BETWEEN NOW() - INTERVAL '8 days' AND NOW() - INTERVAL '6 days'
    ORDER BY ABS(EXTRACT(EPOCH FROM (recorded_at - (NOW() - INTERVAL '7 days'))))
    LIMIT 1
  `;
  const score7d = historyForTrend.length > 0 ? parseFloat(historyForTrend[0].score) : null;
  let trend: 'up' | 'down' | 'stable' = 'stable';
  if (score !== null && score7d !== null) {
    const delta = score - score7d;
    if (delta > 0.01) trend = 'up';
    else if (delta < -0.01) trend = 'down';
  }

  return {
    id: c.id,
    company_name: c.company_name,
    segment: c.segment,
    health_score: score,
    trend,
    has_alert: hasAlert,
    alert_days: alertDays,
    signals: signalRows.map((s) => ({
      id: s.id,
      source_label: s.source_label,
      contribution: parseFloat(s.contribution),
      recorded_at: s.recorded_at,
    })),
    score_history: historyRows
      .map((h) => ({ recorded_at: h.recorded_at, score: parseFloat(h.score) }))
      .sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime()),
  };
}
