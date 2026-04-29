/**
 * @file collections-performance.ts
 *
 * Database query functions for the CFO collections performance panel (issue #17).
 *
 * Returns four metrics for the GET /api/cfo/collections-performance endpoint:
 *   1. agent_recovery_rates       — per-agent recovery rate (% of cases resolved as
 *                                   paid/settlement), with anonymized agent identifiers
 *                                   when caller role is 'cfo'; real agent_id for
 *                                   'finance_controller'
 *   2. avg_days_to_resolution     — average days from opened_at to resolved_at, broken
 *   _by_escalation_level           out by escalation_level (only resolved cases)
 *   3. write_off_rate_12m         — (written_off cases / all resolved cases) in trailing
 *                                   12 months
 *   4. write_off_amount_12m       — sum of invoice amounts for written_off cases resolved
 *                                   in trailing 12 months
 *   5. payment_plan_success_rate  — count(PaymentPlans status=completed) /
 *                                   count(PaymentPlans status IN (completed, breached))
 *
 * Agent anonymization: when callerRole is 'cfo', replace real agent_id values with
 * stable labels "Agent 1", "Agent 2", etc. (ordered by agent_id string for determinism).
 * When callerRole is 'finance_controller', return real agent_id values.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/17
 */

import type postgres from 'postgres';
import { sql as defaultSql } from './index';

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface AgentRecoveryRate {
  /** Agent identifier — anonymized ("Agent 1", …) for cfo; real agent_id for finance_controller. */
  agent_id: string;
  /** Number of collection cases assigned to this agent. */
  total_cases: number;
  /** Number resolved as paid or settlement. */
  recovered_cases: number;
  /** recovered_cases / total_cases — 0 when total_cases is 0. */
  recovery_rate: number;
}

export interface EscalationResolutionEntry {
  escalation_level: number;
  avg_days_to_resolution: number;
}

export interface CollectionsPerformance {
  agent_recovery_rates: AgentRecoveryRate[];
  avg_days_to_resolution_by_escalation_level: EscalationResolutionEntry[];
  write_off_rate_12m: number;
  write_off_amount_12m: number;
  payment_plan_success_rate: number;
}

// ---------------------------------------------------------------------------
// Main query
// ---------------------------------------------------------------------------

/**
 * Returns collections performance metrics for the CFO dashboard.
 *
 * @param callerRole  The authenticated caller's role.  When 'finance_controller',
 *                    real agent_id values are returned.  All other values
 *                    (including 'cfo') produce anonymized labels.
 * @param sqlClient   Optional postgres.js client (defaults to the app pool).
 */
export async function getCollectionsPerformance(
  callerRole: string,
  sqlClient: postgres.Sql = defaultSql,
): Promise<CollectionsPerformance> {
  const showRealNames = callerRole === 'finance_controller';

  // ── 1. Agent recovery rates ──────────────────────────────────────────────
  // Group all collection cases by agent_id, compute recovered / total per agent.
  // Cases without an agent_id are skipped.
  const agentRows = await sqlClient<
    { agent_id: string; total_cases: string; recovered_cases: string }[]
  >`
    SELECT
      agent_id,
      COUNT(*) AS total_cases,
      COUNT(*) FILTER (
        WHERE status = 'resolved'
          AND resolution_type IN ('paid', 'settlement')
      ) AS recovered_cases
    FROM rl_collection_cases
    WHERE agent_id IS NOT NULL
      AND agent_id != ''
    GROUP BY agent_id
    ORDER BY agent_id
  `;

  const agent_recovery_rates: AgentRecoveryRate[] = agentRows.map((row, idx) => {
    const total = parseInt(row.total_cases, 10);
    const recovered = parseInt(row.recovered_cases, 10);
    return {
      agent_id: showRealNames ? row.agent_id : `Agent ${idx + 1}`,
      total_cases: total,
      recovered_cases: recovered,
      recovery_rate: total > 0 ? recovered / total : 0,
    };
  });

  // ── 2. Average days to resolution by escalation level ───────────────────
  // Only resolved cases with a non-null resolved_at are included.
  const resolutionRows = await sqlClient<{ escalation_level: string; avg_days: string }[]>`
    SELECT
      escalation_level,
      AVG(
        EXTRACT(EPOCH FROM (resolved_at - opened_at)) / 86400.0
      ) AS avg_days
    FROM rl_collection_cases
    WHERE status = 'resolved'
      AND resolved_at IS NOT NULL
    GROUP BY escalation_level
    ORDER BY escalation_level
  `;

  const avg_days_to_resolution_by_escalation_level: EscalationResolutionEntry[] =
    resolutionRows.map((row) => ({
      escalation_level: parseInt(row.escalation_level, 10),
      avg_days_to_resolution: Math.round(parseFloat(row.avg_days) * 100) / 100,
    }));

  // ── 3 & 4. Write-off rate and amount (trailing 12 months) ───────────────
  // Count all cases that were closed (status = 'resolved' OR 'written_off') within
  // the trailing 12 months. Cases are closed when resolved_at is set (for 'resolved')
  // or when updated_at is within 12 months (for 'written_off' with no resolved_at).
  // write_off_rate_12m  = written_off count / total closed count
  // write_off_amount_12m = sum of linked invoice amounts for written_off cases
  const writeOffRows = await sqlClient<
    { total_resolved: string; written_off_count: string; written_off_amount: string }[]
  >`
    SELECT
      COUNT(*) AS total_resolved,
      COUNT(*) FILTER (WHERE cc.status = 'written_off') AS written_off_count,
      COALESCE(
        SUM(i.amount) FILTER (WHERE cc.status = 'written_off'),
        0
      ) AS written_off_amount
    FROM rl_collection_cases cc
    JOIN rl_invoices i ON i.id = cc.invoice_id
    WHERE cc.status IN ('resolved', 'written_off')
      AND (
        cc.resolved_at >= NOW() - INTERVAL '12 months'
        OR (cc.resolved_at IS NULL AND cc.updated_at >= NOW() - INTERVAL '12 months')
      )
  `;

  const totalResolved = parseInt(writeOffRows[0]?.total_resolved ?? '0', 10);
  const writtenOffCount = parseInt(writeOffRows[0]?.written_off_count ?? '0', 10);
  const writtenOffAmount = parseFloat(writeOffRows[0]?.written_off_amount ?? '0');

  const write_off_rate_12m = totalResolved > 0 ? writtenOffCount / totalResolved : 0;
  const write_off_amount_12m = Math.round(writtenOffAmount * 100) / 100;

  // ── 5. Payment plan success rate ─────────────────────────────────────────
  // success rate = completed / (completed + breached)
  // "completed" is the terminal paid state in the rl_payment_plans schema
  // (the issue refers to this status as "paid" in its AC).
  const paymentPlanRows = await sqlClient<{ completed_count: string; breached_count: string }[]>`
    SELECT
      COUNT(*) FILTER (WHERE status = 'completed') AS completed_count,
      COUNT(*) FILTER (WHERE status = 'breached')  AS breached_count
    FROM rl_payment_plans
    WHERE status IN ('completed', 'breached')
  `;

  const completedCount = parseInt(paymentPlanRows[0]?.completed_count ?? '0', 10);
  const breachedCount = parseInt(paymentPlanRows[0]?.breached_count ?? '0', 10);
  const denominator = completedCount + breachedCount;
  const payment_plan_success_rate = denominator > 0 ? completedCount / denominator : 0;

  return {
    agent_recovery_rates,
    avg_days_to_resolution_by_escalation_level,
    write_off_rate_12m,
    write_off_amount_12m,
    payment_plan_success_rate,
  };
}

// ---------------------------------------------------------------------------
// Seed helpers for tests
// ---------------------------------------------------------------------------

export interface SeedCollectionCaseWithAgentOptions {
  invoice_id: string;
  agent_id?: string;
  status?: 'open' | 'resolved' | 'escalated' | 'written_off';
  resolution_type?: 'paid' | 'payment_plan' | 'settlement' | 'written_off' | 'legal';
  escalation_level?: number;
  opened_at?: string;
  resolved_at?: string;
}

/**
 * Inserts a collection case with optional agent_id. Returns { case_id }.
 */
export async function seedCollectionCaseWithAgent(
  opts: SeedCollectionCaseWithAgentOptions,
  sqlClient: postgres.Sql = defaultSql,
): Promise<{ case_id: string }> {
  const {
    invoice_id,
    agent_id = null,
    status = 'open',
    resolution_type = null,
    escalation_level = 0,
    opened_at,
    resolved_at,
  } = opts;

  const [row] = await sqlClient<{ id: string }[]>`
    INSERT INTO rl_collection_cases
      (invoice_id, agent_id, status, resolution_type, escalation_level, opened_at, resolved_at)
    VALUES (
      ${invoice_id},
      ${agent_id},
      ${status},
      ${resolution_type},
      ${escalation_level},
      ${opened_at ? sqlClient`${opened_at}::timestamptz` : sqlClient`NOW()`},
      ${resolved_at ? sqlClient`${resolved_at}::timestamptz` : sqlClient`NULL`}
    )
    RETURNING id
  `;
  return { case_id: row.id };
}

export interface SeedPaymentPlanOptions {
  collection_case_id: string;
  total_amount?: number;
  installment_count?: number;
  installment_amount?: number;
  /** 'current' | 'breached' | 'completed' | 'cancelled' */
  status?: 'current' | 'breached' | 'completed' | 'cancelled';
}

/**
 * Inserts a payment plan row. Returns { plan_id }.
 */
export async function seedPaymentPlan(
  opts: SeedPaymentPlanOptions,
  sqlClient: postgres.Sql = defaultSql,
): Promise<{ plan_id: string }> {
  const {
    collection_case_id,
    total_amount = 1000,
    installment_count = 3,
    installment_amount = 333.33,
    status = 'current',
  } = opts;

  const [row] = await sqlClient<{ id: string }[]>`
    INSERT INTO rl_payment_plans
      (collection_case_id, total_amount, installment_count, installment_amount, status)
    VALUES (
      ${collection_case_id},
      ${total_amount},
      ${installment_count},
      ${installment_amount},
      ${status}
    )
    RETURNING id
  `;
  return { plan_id: row.id };
}
