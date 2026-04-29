/**
 * @file cron/jobs/payment-plan-monitor
 *
 * Daily payment-plan reconciliation job (issue #50).
 *
 * The job performs two actions:
 * - marks current plans as breached once the next unpaid installment is past due
 * - marks fully paid plans as completed and resolves the collection case
 *
 * The plan schedule itself is derived in `db/payment-plans`; this worker is
 * the state transition point that keeps the stored status in sync.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/50
 */

import type { CronScheduler } from '../scheduler';
import { reconcilePaymentPlanLifecycle } from 'db/payment-plans';

export const PAYMENT_PLAN_MONITOR_CRON_EXPRESSION = '15 6 * * *';

export function registerPaymentPlanMonitorJob(
  scheduler: CronScheduler,
  expression = PAYMENT_PLAN_MONITOR_CRON_EXPRESSION,
): void {
  scheduler.register('payment-plan-monitor', expression, async (ctx) => {
    const runDate = new Date().toISOString().slice(0, 10);
    console.log(`[cron] payment-plan-monitor: starting for ${runDate}`);

    const result = await reconcilePaymentPlanLifecycle();

    if (result.breached.length > 0) {
      console.log(
        `[payment-plan-monitor] breached ${result.breached.length} plan(s): ${result.breached.join(', ')}`,
      );
    }
    if (result.completed.length > 0) {
      console.log(
        `[payment-plan-monitor] completed ${result.completed.length} plan(s): ${result.completed.join(', ')}`,
      );
    }

    await ctx.enqueueCronTask({
      job_type: 'payment_plan_monitor_run',
      payload: {
        run_date: runDate,
        breached: result.breached,
        completed: result.completed,
      },
      idempotency_key_suffix: `payment-plan-monitor-${runDate}`,
      priority: 5,
      max_attempts: 1,
    });

    console.log(
      `[cron] payment-plan-monitor: done — breached=${result.breached.length} completed=${result.completed.length} date=${runDate}`,
    );
  });
}
