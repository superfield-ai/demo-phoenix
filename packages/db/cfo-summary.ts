/**
 * @file cfo-summary.ts
 *
 * Database query functions for the CFO executive summary bar (issue #12).
 *
 * Computes five portfolio metrics:
 *   1. pipeline_by_tier       — sum of composite_score * estimated_deal_value for qualified
 *                               Prospects, grouped by tier (A/B/C)
 *   2. weighted_close_rate    — historical Closed Won / (Closed Won + Closed Lost) weighted
 *                               by tier (A=3, B=2, C=1)
 *   3. ar_aging_buckets       — sum of rl_invoices.amount grouped by days-overdue bucket
 *                               (current / 30 / 60 / 90 / 120+)
 *   4. collection_recovery_rate_90d — CollectionCases resolved as paid or settlement /
 *                                     total CollectionCases opened in trailing 90 days
 *   5. active_score_model_version   — most recently written score_version string
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/12
 */

import type postgres from 'postgres';
import { sql as defaultSql } from './index';

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

export interface PipelineByTier {
  A: number;
  B: number;
  C: number;
}

export interface ArAgingBuckets {
  current: number;
  '30': number;
  '60': number;
  '90': number;
  '120+': number;
}

export interface CfoSummary {
  pipeline_by_tier: PipelineByTier;
  weighted_close_rate: number;
  ar_aging_buckets: ArAgingBuckets;
  collection_recovery_rate_90d: number;
  active_score_model_version: string | null;
}

// ---------------------------------------------------------------------------
// Tier helpers (mirrors leads-queue.ts thresholds)
// ---------------------------------------------------------------------------

/** Tier weight for weighted close rate calculation. A=3, B=2, C=1. */
function tierWeight(tier: 'A' | 'B' | 'C'): number {
  if (tier === 'A') return 3;
  if (tier === 'B') return 2;
  return 1;
}

// ---------------------------------------------------------------------------
// Main query
// ---------------------------------------------------------------------------

/**
 * Returns the five CFO summary metrics for the current tenant.
 *
 * Uses an estimated_deal_value of 1_000_000 per prospect when computing
 * pipeline_by_tier (matches the CLTV mid-point formula used by the sales rep
 * queue: composite_score × 1_000_000).
 *
 * @param sqlClient Optional postgres.js client (defaults to the app pool).
 */
export async function getCfoSummary(sqlClient: postgres.Sql = defaultSql): Promise<CfoSummary> {
  // ── 1. Pipeline by tier ──────────────────────────────────────────────────
  // For each qualified prospect, use the latest CLTV score.
  // pipeline_value = composite_score × 1_000_000 (estimated deal value).
  // Tier thresholds: A ≥ 0.7, B ≥ 0.4, C < 0.4.
  const pipelineRows = await sqlClient<{ tier: string; total: string }[]>`
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
      ls.tier,
      COALESCE(SUM(ls.composite_score * 1000000), 0) AS total
    FROM rl_prospects p
    JOIN latest_scores ls ON ls.entity_id = p.id
    WHERE p.stage = 'qualified'
    GROUP BY ls.tier
  `;

  const pipeline_by_tier: PipelineByTier = { A: 0, B: 0, C: 0 };
  for (const row of pipelineRows) {
    const tier = row.tier as 'A' | 'B' | 'C';
    if (tier === 'A' || tier === 'B' || tier === 'C') {
      pipeline_by_tier[tier] = Math.round(parseFloat(row.total));
    }
  }

  // ── 2. Weighted close rate ───────────────────────────────────────────────
  // Weighted by tier (A=3, B=2, C=1).
  // Only deals with stage in ('closed_won', 'closed_lost') are counted.
  const dealRows = await sqlClient<{ tier: string; stage: string; deal_count: string }[]>`
    WITH latest_scores AS (
      SELECT DISTINCT ON (entity_id)
        entity_id,
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
      COALESCE(ls.tier, 'C') AS tier,
      d.stage,
      COUNT(*) AS deal_count
    FROM rl_deals d
    LEFT JOIN latest_scores ls ON ls.entity_id = d.prospect_id
    WHERE d.stage IN ('closed_won', 'closed_lost')
    GROUP BY ls.tier, d.stage
  `;

  let weightedWon = 0;
  let weightedTotal = 0;
  for (const row of dealRows) {
    const tier = (row.tier ?? 'C') as 'A' | 'B' | 'C';
    const w = tierWeight(tier);
    const count = parseInt(row.deal_count, 10);
    weightedTotal += w * count;
    if (row.stage === 'closed_won') {
      weightedWon += w * count;
    }
  }
  const weighted_close_rate = weightedTotal > 0 ? weightedWon / weightedTotal : 0;

  // ── 3. AR aging buckets ──────────────────────────────────────────────────
  // current = due_date >= today (not overdue)
  // 30      = overdue 1–30 days
  // 60      = overdue 31–60 days
  // 90      = overdue 61–90 days
  // 120+    = overdue 91+ days
  // Only invoices in status 'sent', 'partial_paid', or 'overdue' are counted
  // as receivables (draft/paid/settled/written_off are excluded).
  const agingRows = await sqlClient<{ bucket: string; total: string }[]>`
    SELECT
      CASE
        WHEN due_date >= CURRENT_DATE THEN 'current'
        WHEN due_date >= CURRENT_DATE - INTERVAL '30 days' THEN '30'
        WHEN due_date >= CURRENT_DATE - INTERVAL '60 days' THEN '60'
        WHEN due_date >= CURRENT_DATE - INTERVAL '90 days' THEN '90'
        ELSE '120+'
      END AS bucket,
      COALESCE(SUM(amount), 0) AS total
    FROM rl_invoices
    WHERE status IN ('sent', 'partial_paid', 'overdue', 'in_collection')
      AND due_date IS NOT NULL
    GROUP BY bucket
  `;

  const ar_aging_buckets: ArAgingBuckets = {
    current: 0,
    '30': 0,
    '60': 0,
    '90': 0,
    '120+': 0,
  };
  for (const row of agingRows) {
    const bucket = row.bucket as keyof ArAgingBuckets;
    if (bucket in ar_aging_buckets) {
      ar_aging_buckets[bucket] = Math.round(parseFloat(row.total));
    }
  }

  // ── 4. Collection recovery rate (trailing 90 days) ───────────────────────
  // Resolved as paid (resolution_type = 'paid') or settlement ('settlement')
  // divided by total cases opened in the trailing 90 days.
  const recoveryRows = await sqlClient<{ total: string; recovered: string }[]>`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (
        WHERE status = 'resolved'
          AND resolution_type IN ('paid', 'settlement')
      ) AS recovered
    FROM rl_collection_cases
    WHERE opened_at >= NOW() - INTERVAL '90 days'
  `;

  const totalCases = parseInt(recoveryRows[0]?.total ?? '0', 10);
  const recoveredCases = parseInt(recoveryRows[0]?.recovered ?? '0', 10);
  const collection_recovery_rate_90d = totalCases > 0 ? recoveredCases / totalCases : 0;

  // ── 5. Active score model version ────────────────────────────────────────
  // The most recently written score_version string in rl_cltv_scores.
  const versionRows = await sqlClient<{ score_version: string }[]>`
    SELECT score_version
    FROM rl_cltv_scores
    ORDER BY created_at DESC
    LIMIT 1
  `;

  const active_score_model_version = versionRows[0]?.score_version ?? null;

  return {
    pipeline_by_tier,
    weighted_close_rate,
    ar_aging_buckets,
    collection_recovery_rate_90d,
    active_score_model_version,
  };
}

// ---------------------------------------------------------------------------
// Seed helpers for tests
// ---------------------------------------------------------------------------

export interface SeedInvoiceOptions {
  customer_id: string;
  amount: number;
  /** due_date as ISO date string (YYYY-MM-DD). Defaults to today. */
  due_date?: string;
  /** Invoice status (defaults to 'sent'). Must be a valid invoice_status. */
  status?:
    | 'draft'
    | 'sent'
    | 'partial_paid'
    | 'overdue'
    | 'in_collection'
    | 'paid'
    | 'settled'
    | 'written_off';
}

/**
 * Inserts a customer and invoice row for integration tests.
 * Returns { customer_id, invoice_id }.
 */
export async function seedInvoice(
  opts: SeedInvoiceOptions,
  sqlClient: postgres.Sql = defaultSql,
): Promise<{ invoice_id: string }> {
  const { customer_id, amount, due_date, status = 'sent' } = opts;

  // For status transitions that need intermediate states, insert as 'draft'
  // then transition through valid states.
  const [inv] = await sqlClient<{ id: string }[]>`
    INSERT INTO rl_invoices (customer_id, amount, due_date, status)
    VALUES (${customer_id}, ${amount}, ${due_date ?? null}, 'draft')
    RETURNING id
  `;

  // Transition through valid states if needed
  const transitions: Record<string, string[]> = {
    draft: [],
    sent: ['sent'],
    partial_paid: ['sent', 'partial_paid'],
    overdue: ['sent', 'overdue'],
    in_collection: ['sent', 'overdue', 'in_collection'],
    paid: ['sent', 'overdue', 'in_collection', 'paid'],
    settled: ['sent', 'overdue', 'in_collection', 'settled'],
    written_off: ['sent', 'overdue', 'in_collection', 'written_off'],
  };

  for (const targetStatus of transitions[status] ?? []) {
    await sqlClient`UPDATE rl_invoices SET status = ${targetStatus} WHERE id = ${inv.id}`;
  }

  return { invoice_id: inv.id };
}

export interface SeedCustomerOptions {
  company_name: string;
}

/**
 * Inserts a customer row. Returns { customer_id }.
 */
export async function seedCustomer(
  opts: SeedCustomerOptions,
  sqlClient: postgres.Sql = defaultSql,
): Promise<{ customer_id: string }> {
  const [row] = await sqlClient<{ id: string }[]>`
    INSERT INTO rl_customers (company_name)
    VALUES (${opts.company_name})
    RETURNING id
  `;
  return { customer_id: row.id };
}

export interface SeedCollectionCaseOptions {
  invoice_id: string;
  status?: 'open' | 'resolved' | 'escalated' | 'written_off';
  resolution_type?: 'paid' | 'payment_plan' | 'settlement' | 'written_off' | 'legal';
  /** opened_at as ISO timestamp string. Defaults to now. */
  opened_at?: string;
  resolved_at?: string;
}

/**
 * Inserts a collection case row. Returns { case_id }.
 */
export async function seedCollectionCase(
  opts: SeedCollectionCaseOptions,
  sqlClient: postgres.Sql = defaultSql,
): Promise<{ case_id: string }> {
  const { invoice_id, status = 'open', resolution_type = null, opened_at, resolved_at } = opts;

  const [row] = await sqlClient<{ id: string }[]>`
    INSERT INTO rl_collection_cases
      (invoice_id, status, resolution_type, opened_at, resolved_at)
    VALUES (
      ${invoice_id},
      ${status},
      ${resolution_type},
      ${opened_at ? sqlClient`${opened_at}::timestamptz` : sqlClient`NOW()`},
      ${resolved_at ? sqlClient`${resolved_at}::timestamptz` : sqlClient`NULL`}
    )
    RETURNING id
  `;
  return { case_id: row.id };
}
