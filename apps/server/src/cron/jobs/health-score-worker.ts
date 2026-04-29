/**
 * @file cron/jobs/health-score-worker
 *
 * Daily customer health score computation job (issue #54).
 *
 * Runs daily. For every customer that has at least one invoice, this job:
 *  1. Fetches three payment behaviour signals from the database.
 *  2. Computes a composite 0–100 score.
 *  3. Writes one rl_customer_health_scores record per customer per calendar day
 *     (idempotent — duplicate runs are safe).
 *  4. Updates rl_customers.health_score with the latest computed value.
 *
 * ## Signals
 *
 *  - days_overdue     — days since the due_date of the most recent unpaid invoice
 *  - breach_count     — payment plan breaches in the last 6 months
 *  - escalation_level — maximum escalation level across open/escalated collection cases
 *
 * ## Score formula
 *
 *  Each signal is normalised to a penalty (0–1), weighted, and summed.
 *  score = 100 × (1 − composite_penalty).
 *
 *  Weights: days_overdue=0.60, breach_count=0.25, escalation=0.15
 *  Normalisation caps: 90 days → full overdue penalty; 3 breaches → full breach penalty;
 *  escalation level 3 → full escalation penalty.
 *
 * ## Idempotency
 *
 *  The unique index rl_customer_health_scores_one_per_day on (customer_id, score_date)
 *  ensures that a second run on the same day returns the existing record without
 *  inserting a duplicate.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/54
 */

import type { CronScheduler } from '../scheduler';
import {
  listCustomersForHealthScore,
  computeHealthScoreSignals,
  computeHealthScore,
  upsertCustomerHealthScore,
  updateCustomerHealthScore,
} from 'db/customer-health-scores';

/** Default cron expression: run daily at 07:00 UTC (after dunning engine at 06:00). */
export const HEALTH_SCORE_WORKER_CRON_EXPRESSION = '0 7 * * *';

/**
 * Registers the health score worker cron job on the given scheduler.
 *
 * @param scheduler  - The CronScheduler instance.
 * @param expression - Cron expression. Defaults to daily at 07:00 UTC.
 */
export function registerHealthScoreWorkerJob(
  scheduler: CronScheduler,
  expression = HEALTH_SCORE_WORKER_CRON_EXPRESSION,
): void {
  scheduler.register('health-score-worker', expression, async (ctx) => {
    const runDate = new Date().toISOString().slice(0, 10);
    console.log(`[cron] health-score-worker: starting for ${runDate}`);

    const customerIds = await listCustomersForHealthScore();

    let computed = 0;
    let skipped = 0;
    let errors = 0;

    for (const customerId of customerIds) {
      try {
        const signals = await computeHealthScoreSignals(customerId);
        const { score, days_overdue_signal, breach_count_signal, escalation_signal } =
          computeHealthScore(signals);

        const row = await upsertCustomerHealthScore({
          customer_id: customerId,
          score_date: runDate,
          score,
          days_overdue_signal,
          breach_count_signal,
          escalation_signal,
          days_overdue_value: signals.days_overdue,
          breach_count_value: signals.breach_count,
          escalation_level_value: signals.escalation_level,
        });

        if (row.computed_at < new Date().toISOString().slice(0, 11)) {
          // Row was already computed earlier today — skip the customer update.
          skipped += 1;
        } else {
          await updateCustomerHealthScore(customerId, score);
          computed += 1;
        }
      } catch (err) {
        console.error(`[health-score-worker] error processing customer ${customerId}:`, err);
        errors += 1;
      }
    }

    await ctx.enqueueCronTask({
      job_type: 'health_score_worker_run',
      payload: {
        run_date: runDate,
        customers_processed: customerIds.length,
        computed,
        skipped,
        errors,
      },
      idempotency_key_suffix: `health-score-worker-${runDate}`,
      priority: 5,
      max_attempts: 1,
    });

    console.log(
      `[cron] health-score-worker: done — processed=${customerIds.length} computed=${computed} skipped=${skipped} errors=${errors} date=${runDate}`,
    );
  });
}
