/**
 * @file customer-health-scores.ts
 *
 * Database query functions for customer health score computation (issue #54).
 *
 * Exports:
 *   computeHealthScoreSignals    — fetch raw signals for a customer from DB
 *   upsertCustomerHealthScore    — insert or return existing record for the day (idempotent)
 *   updateCustomerHealthScore    — update rl_customers.health_score with latest value
 *   getLatestCustomerHealthScore — fetch most recent score row for a customer
 *   listCustomersForHealthScore  — list customer IDs that have at least one invoice
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/54
 */

import type postgres from 'postgres';
import { sql as defaultSql } from './index';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw signals fetched from the database for one customer. */
export interface CustomerHealthSignals {
  customer_id: string;
  /** Days overdue on the most recent invoice with a past due_date. 0 if none overdue. */
  days_overdue: number;
  /** Number of payment plan breaches in the last 6 months. */
  breach_count: number;
  /** Maximum escalation_level across open/escalated collection cases. 0 if none. */
  escalation_level: number;
}

/** Per-signal contribution and label, as returned by the API. */
export interface HealthSignalContribution {
  label: string;
  value: number;
  contribution: number;
}

/** A stored health score row. */
export interface CustomerHealthScoreRow {
  id: string;
  customer_id: string;
  score_date: string;
  score: number;
  days_overdue_signal: number;
  breach_count_signal: number;
  escalation_signal: number;
  days_overdue_value: number;
  breach_count_value: number;
  escalation_level_value: number;
  computed_at: string;
}

// ---------------------------------------------------------------------------
// Score computation (pure function — no DB access)
// ---------------------------------------------------------------------------

/**
 * Score weights. Must sum to 1.0.
 *
 * days_overdue is the dominant signal (65 %). An invoice more than 60 days
 * overdue (reaching the normalisation cap) drops the score to 35, which is
 * below the critical threshold of 40.
 */
const WEIGHT_DAYS_OVERDUE = 0.65;
const WEIGHT_BREACH_COUNT = 0.2;
const WEIGHT_ESCALATION = 0.15;

/**
 * Computes a composite health score (0–100) from the three signals and returns
 * the individual penalty contribution of each signal.
 *
 * Each signal is normalised to a 0–1 penalty (higher penalty = worse health),
 * then weighted and summed.  The composite penalty is subtracted from 100.
 *
 * ### Signal normalisation
 *
 * days_overdue   — penalty = min(days / 60, 1.0).  60+ days overdue = full penalty.
 *                  At 60 days the score without other signals is 35 (< 40 critical threshold).
 * breach_count   — penalty = min(breaches / 3, 1.0). 3+ breaches = full penalty.
 * escalation     — penalty = min(level / 3, 1.0).  escalation level 3+ = full penalty.
 *
 * A customer with no overdue invoices, no breaches, and no escalated cases
 * scores 100.  A customer with all three signals at maximum scores 0.
 */
export function computeHealthScore(signals: CustomerHealthSignals): {
  score: number;
  days_overdue_signal: number;
  breach_count_signal: number;
  escalation_signal: number;
} {
  const daysOverduePenalty = Math.min(signals.days_overdue / 60, 1.0);
  const breachPenalty = Math.min(signals.breach_count / 3, 1.0);
  const escalationPenalty = Math.min(signals.escalation_level / 3, 1.0);

  const compositePenalty =
    daysOverduePenalty * WEIGHT_DAYS_OVERDUE +
    breachPenalty * WEIGHT_BREACH_COUNT +
    escalationPenalty * WEIGHT_ESCALATION;

  const rawScore = 100 * (1 - compositePenalty);
  const score = Math.max(0, Math.min(100, Math.round(rawScore * 100) / 100));

  // Per-signal contribution: the penalty each signal contributes to the score deduction.
  const days_overdue_signal =
    Math.round(daysOverduePenalty * WEIGHT_DAYS_OVERDUE * 100 * 100) / 100;
  const breach_count_signal = Math.round(breachPenalty * WEIGHT_BREACH_COUNT * 100 * 100) / 100;
  const escalation_signal = Math.round(escalationPenalty * WEIGHT_ESCALATION * 100 * 100) / 100;

  return { score, days_overdue_signal, breach_count_signal, escalation_signal };
}

// ---------------------------------------------------------------------------
// listCustomersForHealthScore
// ---------------------------------------------------------------------------

/**
 * Returns the IDs of all customers that have at least one invoice.
 * These are the customers the health-score worker will process.
 */
export async function listCustomersForHealthScore(
  sqlClient: postgres.Sql = defaultSql,
): Promise<string[]> {
  const rows = await sqlClient<{ customer_id: string }[]>`
    SELECT DISTINCT customer_id
    FROM rl_invoices
    ORDER BY customer_id
  `;
  return rows.map((r) => r.customer_id);
}

// ---------------------------------------------------------------------------
// computeHealthScoreSignals
// ---------------------------------------------------------------------------

/**
 * Fetches the three payment behaviour signals for a customer from the database:
 *
 * 1. days_overdue — days since the due_date of the customer's most recently
 *    due (and still unpaid/overdue/in_collection) invoice.  0 if none overdue.
 *
 * 2. breach_count — number of payment plans with status='breached' linked to
 *    this customer's collection cases, where the plan was created in the last
 *    6 months.
 *
 * 3. escalation_level — maximum escalation_level across all open or escalated
 *    collection cases for this customer. 0 if none.
 */
export async function computeHealthScoreSignals(
  customerId: string,
  sqlClient: postgres.Sql = defaultSql,
): Promise<CustomerHealthSignals> {
  // Signal 1: days overdue on most recent unpaid invoice.
  const overdueRows = await sqlClient<{ days_overdue: string }[]>`
    SELECT
      GREATEST(0, EXTRACT(DAY FROM (NOW() - i.due_date::timestamptz))::int)::text AS days_overdue
    FROM rl_invoices i
    WHERE i.customer_id = ${customerId}
      AND i.due_date IS NOT NULL
      AND i.due_date::date < CURRENT_DATE
      AND i.status NOT IN ('paid', 'settled', 'written_off', 'draft')
    ORDER BY i.due_date ASC
    LIMIT 1
  `;
  const days_overdue = overdueRows.length > 0 ? Number(overdueRows[0].days_overdue) : 0;

  // Signal 2: payment plan breach count in last 6 months.
  const breachRows = await sqlClient<{ breach_count: string }[]>`
    SELECT COUNT(pp.id)::text AS breach_count
    FROM rl_payment_plans pp
    JOIN rl_collection_cases cc ON cc.id = pp.collection_case_id
    JOIN rl_invoices i ON i.id = cc.invoice_id
    WHERE i.customer_id = ${customerId}
      AND pp.status = 'breached'
      AND pp.created_at >= NOW() - INTERVAL '6 months'
  `;
  const breach_count = breachRows.length > 0 ? Number(breachRows[0].breach_count) : 0;

  // Signal 3: max escalation level on open/escalated collection cases.
  const escalationRows = await sqlClient<{ escalation_level: string }[]>`
    SELECT COALESCE(MAX(cc.escalation_level), 0)::text AS escalation_level
    FROM rl_collection_cases cc
    JOIN rl_invoices i ON i.id = cc.invoice_id
    WHERE i.customer_id = ${customerId}
      AND cc.status IN ('open', 'escalated')
  `;
  const escalation_level =
    escalationRows.length > 0 ? Number(escalationRows[0].escalation_level) : 0;

  return { customer_id: customerId, days_overdue, breach_count, escalation_level };
}

// ---------------------------------------------------------------------------
// upsertCustomerHealthScore
// ---------------------------------------------------------------------------

/**
 * Inserts a health score record for the given customer and date.
 * Idempotent: if a record already exists for (customer_id, score_date),
 * the existing record is returned without modification.
 *
 * Returns the inserted or existing row.
 */
export async function upsertCustomerHealthScore(
  opts: {
    customer_id: string;
    score_date: string;
    score: number;
    days_overdue_signal: number;
    breach_count_signal: number;
    escalation_signal: number;
    days_overdue_value: number;
    breach_count_value: number;
    escalation_level_value: number;
  },
  sqlClient: postgres.Sql = defaultSql,
): Promise<CustomerHealthScoreRow> {
  const {
    customer_id,
    score_date,
    score,
    days_overdue_signal,
    breach_count_signal,
    escalation_signal,
    days_overdue_value,
    breach_count_value,
    escalation_level_value,
  } = opts;

  const rows = await sqlClient<
    {
      id: string;
      customer_id: string;
      score_date: string;
      score: string;
      days_overdue_signal: string;
      breach_count_signal: string;
      escalation_signal: string;
      days_overdue_value: string;
      breach_count_value: string;
      escalation_level_value: string;
      computed_at: string;
    }[]
  >`
    INSERT INTO rl_customer_health_scores
      (customer_id, score_date, score,
       days_overdue_signal, breach_count_signal, escalation_signal,
       days_overdue_value, breach_count_value, escalation_level_value)
    VALUES (
      ${customer_id},
      ${score_date}::date,
      ${score},
      ${days_overdue_signal},
      ${breach_count_signal},
      ${escalation_signal},
      ${days_overdue_value},
      ${breach_count_value},
      ${escalation_level_value}
    )
    ON CONFLICT (customer_id, score_date) DO NOTHING
    RETURNING
      id,
      customer_id,
      score_date::text AS score_date,
      score::text AS score,
      days_overdue_signal::text AS days_overdue_signal,
      breach_count_signal::text AS breach_count_signal,
      escalation_signal::text AS escalation_signal,
      days_overdue_value::text AS days_overdue_value,
      breach_count_value::text AS breach_count_value,
      escalation_level_value::text AS escalation_level_value,
      computed_at::text AS computed_at
  `;

  if (rows.length > 0) {
    return mapRow(rows[0]);
  }

  // Row already existed — fetch it.
  const existing = await sqlClient<
    {
      id: string;
      customer_id: string;
      score_date: string;
      score: string;
      days_overdue_signal: string;
      breach_count_signal: string;
      escalation_signal: string;
      days_overdue_value: string;
      breach_count_value: string;
      escalation_level_value: string;
      computed_at: string;
    }[]
  >`
    SELECT
      id,
      customer_id,
      score_date::text AS score_date,
      score::text AS score,
      days_overdue_signal::text AS days_overdue_signal,
      breach_count_signal::text AS breach_count_signal,
      escalation_signal::text AS escalation_signal,
      days_overdue_value::text AS days_overdue_value,
      breach_count_value::text AS breach_count_value,
      escalation_level_value::text AS escalation_level_value,
      computed_at::text AS computed_at
    FROM rl_customer_health_scores
    WHERE customer_id = ${customer_id}
      AND score_date = ${score_date}::date
    LIMIT 1
  `;

  return mapRow(existing[0]);
}

// ---------------------------------------------------------------------------
// updateCustomerHealthScore
// ---------------------------------------------------------------------------

/**
 * Updates rl_customers.health_score with the latest computed value.
 * The value is stored as a NUMERIC(5,4) — normalised to 0–1 range.
 */
export async function updateCustomerHealthScore(
  customerId: string,
  score: number,
  sqlClient: postgres.Sql = defaultSql,
): Promise<void> {
  // rl_customers.health_score is NUMERIC(5,4): store as 0–1 fraction.
  const normalised = score / 100;
  await sqlClient`
    UPDATE rl_customers
    SET health_score = ${normalised}, updated_at = NOW()
    WHERE id = ${customerId}
  `;
}

// ---------------------------------------------------------------------------
// getLatestCustomerHealthScore
// ---------------------------------------------------------------------------

/**
 * Returns the most recent health score row for the given customer.
 * Returns null if no score has been computed yet.
 */
export async function getLatestCustomerHealthScore(
  customerId: string,
  sqlClient: postgres.Sql = defaultSql,
): Promise<CustomerHealthScoreRow | null> {
  const rows = await sqlClient<
    {
      id: string;
      customer_id: string;
      score_date: string;
      score: string;
      days_overdue_signal: string;
      breach_count_signal: string;
      escalation_signal: string;
      days_overdue_value: string;
      breach_count_value: string;
      escalation_level_value: string;
      computed_at: string;
    }[]
  >`
    SELECT
      id,
      customer_id,
      score_date::text AS score_date,
      score::text AS score,
      days_overdue_signal::text AS days_overdue_signal,
      breach_count_signal::text AS breach_count_signal,
      escalation_signal::text AS escalation_signal,
      days_overdue_value::text AS days_overdue_value,
      breach_count_value::text AS breach_count_value,
      escalation_level_value::text AS escalation_level_value,
      computed_at::text AS computed_at
    FROM rl_customer_health_scores
    WHERE customer_id = ${customerId}
    ORDER BY score_date DESC
    LIMIT 1
  `;

  if (rows.length === 0) return null;
  return mapRow(rows[0]);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function mapRow(r: {
  id: string;
  customer_id: string;
  score_date: string;
  score: string;
  days_overdue_signal: string;
  breach_count_signal: string;
  escalation_signal: string;
  days_overdue_value: string;
  breach_count_value: string;
  escalation_level_value: string;
  computed_at: string;
}): CustomerHealthScoreRow {
  return {
    id: r.id,
    customer_id: r.customer_id,
    score_date: r.score_date,
    score: parseFloat(r.score),
    days_overdue_signal: parseFloat(r.days_overdue_signal),
    breach_count_signal: parseFloat(r.breach_count_signal),
    escalation_signal: parseFloat(r.escalation_signal),
    days_overdue_value: Number(r.days_overdue_value),
    breach_count_value: Number(r.breach_count_value),
    escalation_level_value: Number(r.escalation_level_value),
    computed_at: r.computed_at,
  };
}
