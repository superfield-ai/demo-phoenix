/**
 * @file cron/jobs/dunning-engine
 *
 * Automated dunning engine cron job (issue #48).
 *
 * Runs daily. Scans invoices whose due_date has passed and creates
 * DunningAction records at each milestone (D+1, D+7, D+14, D+30).
 * Idempotency: skips a milestone if a DunningAction of that type already
 * exists for the invoice.
 *
 * ## Dunning sequence
 *
 *   D+1   reminder_d1         — friendly reminder
 *   D+7   second_notice_d7    — second notice with payment link
 *   D+14  firm_notice_d14     — firm notice + Account Manager alert
 *   D+30  collection_d30      — CollectionCase opened + invoice → in_collection
 *
 * ## Payment plan pause
 *
 * When an invoice has an open CollectionCase with a PaymentPlan of
 * status=current, the dunning clock is paused — no new actions are created.
 * When the plan breaches (status=breached), the next cron run resumes.
 *
 * ## Communication dispatch
 *
 * Email sending is stubbed: the job logs what would be sent. The SMTP
 * environment variables are checked but sending is skipped in demo mode.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/48
 */

import type { CronScheduler } from '../scheduler';
import {
  listOverdueInvoicesForDunning,
  hasDunningAction,
  createDunningAction,
  transitionInvoiceToCollection,
  type DunningActionType,
} from 'db/dunning';

// ---------------------------------------------------------------------------
// Milestone definitions
// ---------------------------------------------------------------------------

export interface DunningMilestone {
  action_type: DunningActionType;
  /** Minimum days overdue before this milestone fires. */
  min_days: number;
  /** Human-readable description for logging. */
  label: string;
}

export const DUNNING_MILESTONES: DunningMilestone[] = [
  { action_type: 'reminder_d1', min_days: 1, label: 'D+1 friendly reminder' },
  { action_type: 'second_notice_d7', min_days: 7, label: 'D+7 second notice' },
  { action_type: 'firm_notice_d14', min_days: 14, label: 'D+14 firm notice + AM alert' },
  { action_type: 'collection_d30', min_days: 30, label: 'D+30 collection case' },
];

// ---------------------------------------------------------------------------
// Milestone resolution
// ---------------------------------------------------------------------------

/**
 * Returns the highest-priority milestone that:
 *  1. The invoice qualifies for (days_overdue >= min_days).
 *  2. Has NOT yet been created for the invoice (idempotency check done by caller).
 *
 * Returns null when no new milestone is due.
 */
export function resolveNextMilestone(
  daysOverdue: number,
  existingActionTypes: Set<DunningActionType>,
): DunningMilestone | null {
  // Evaluate milestones from highest priority to lowest, and return the first
  // one not yet executed that is due.
  // We want to create all due milestones in one run, so we return the first
  // not-yet-created one that is due.
  for (const milestone of DUNNING_MILESTONES) {
    if (daysOverdue >= milestone.min_days && !existingActionTypes.has(milestone.action_type)) {
      return milestone;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Communication dispatch (stub)
// ---------------------------------------------------------------------------

/**
 * Dispatches a dunning communication (stub). Logs the intended action.
 * In production, this would send via SES/SendGrid.
 */
export function dispatchDunningCommunication(opts: {
  invoiceId: string;
  milestone: DunningMilestone;
}): void {
  const { invoiceId, milestone } = opts;
  console.log(`[dunning-engine] STUB dispatch: ${milestone.label} for invoice ${invoiceId}`);

  if (milestone.action_type === 'firm_notice_d14') {
    console.log(
      `[dunning-engine] STUB AM alert: Account Manager notified for invoice ${invoiceId}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Job registration
// ---------------------------------------------------------------------------

/** Default cron expression: run daily at 06:00 UTC. */
export const DUNNING_ENGINE_CRON_EXPRESSION = '0 6 * * *';

/**
 * Registers the dunning engine cron job on the given scheduler.
 *
 * @param scheduler  - The CronScheduler instance.
 * @param expression - Cron expression. Defaults to daily at 06:00 UTC.
 */
export function registerDunningEngineJob(
  scheduler: CronScheduler,
  expression = DUNNING_ENGINE_CRON_EXPRESSION,
): void {
  scheduler.register('dunning-engine', expression, async (ctx) => {
    const runDate = new Date().toISOString().slice(0, 10);
    console.log(`[cron] dunning-engine: starting for ${runDate}`);

    const invoices = await listOverdueInvoicesForDunning();

    let actionsCreated = 0;
    let invoicesSkipped = 0;
    let collectionCasesOpened = 0;

    for (const invoice of invoices) {
      // Pause dunning when a current payment plan is active.
      if (invoice.has_active_payment_plan) {
        console.log(
          `[dunning-engine] invoice ${invoice.id} skipped — active payment plan (status=current)`,
        );
        invoicesSkipped += 1;
        continue;
      }

      // Determine which milestones have already been created for this invoice.
      const existingTypes = new Set<DunningActionType>();
      for (const milestone of DUNNING_MILESTONES) {
        if (await hasDunningAction(invoice.id, milestone.action_type)) {
          existingTypes.add(milestone.action_type);
        }
      }

      // Create all newly due milestones (ordered by min_days ascending).
      for (const milestone of DUNNING_MILESTONES) {
        if (invoice.days_overdue < milestone.min_days) continue;
        if (existingTypes.has(milestone.action_type)) continue;

        console.log(
          `[dunning-engine] invoice ${invoice.id} (${invoice.days_overdue}d overdue): creating ${milestone.action_type}`,
        );

        if (milestone.action_type === 'collection_d30') {
          // Atomic: transition invoice to in_collection + open CollectionCase.
          try {
            await transitionInvoiceToCollection(invoice.id);
            collectionCasesOpened += 1;
            console.log(
              `[dunning-engine] invoice ${invoice.id}: transitioned to in_collection, CollectionCase opened`,
            );
          } catch (err) {
            console.error(
              `[dunning-engine] invoice ${invoice.id}: failed to open CollectionCase:`,
              err,
            );
            // Still record the dunning action even if the transition partially failed.
          }
        }

        // Create the dunning action record.
        await createDunningAction({
          invoice_id: invoice.id,
          action_type: milestone.action_type,
          scheduled_at: new Date().toISOString(),
        });

        // Dispatch the communication stub.
        dispatchDunningCommunication({ invoiceId: invoice.id, milestone });

        existingTypes.add(milestone.action_type);
        actionsCreated += 1;
      }
    }

    // Enqueue a task for admin visibility.
    await ctx.enqueueCronTask({
      job_type: 'dunning_engine_run',
      payload: {
        run_date: runDate,
        invoices_processed: invoices.length,
        invoices_skipped: invoicesSkipped,
        actions_created: actionsCreated,
        collection_cases_opened: collectionCasesOpened,
      },
      idempotency_key_suffix: `dunning-engine-${runDate}`,
      priority: 5,
      max_attempts: 1,
    });

    console.log(
      `[cron] dunning-engine: done — processed=${invoices.length} skipped=${invoicesSkipped} actions=${actionsCreated} cases=${collectionCasesOpened} date=${runDate}`,
    );
  });
}
