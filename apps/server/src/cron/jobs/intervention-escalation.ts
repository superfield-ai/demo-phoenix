/**
 * @file cron/jobs/intervention-escalation
 *
 * Intervention escalation cron job (issue #56).
 *
 * Runs daily. Scans for interventions that have been open for at least
 * INTERVENTION_ESCALATION_DAYS (default: 3) without being moved to
 * in_progress or resolved, and creates an escalation notification for
 * the team lead.
 *
 * ## Escalation rule
 *
 *   An intervention qualifies for escalation when:
 *     - status = 'open'
 *     - created_at <= NOW() - N days  (N = INTERVENTION_ESCALATION_DAYS)
 *     - the customer has no other active (open/in_progress) intervention
 *
 * ## Idempotency
 *
 *   createEscalationNotification uses ON CONFLICT DO UPDATE so running the
 *   job twice on the same day does not produce duplicate rows.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/56
 */

import type { CronScheduler } from '../scheduler';
import {
  listAlertsNeedingEscalation,
  createEscalationNotification,
  getTeamLeadForUser,
  getAssignedAccountManager,
} from 'db/interventions';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default number of days an intervention must be open before escalation. */
export const DEFAULT_ESCALATION_DAYS = 3;

/** Default cron expression: run daily at 07:00 UTC. */
export const INTERVENTION_ESCALATION_CRON_EXPRESSION = '0 7 * * *';

// ---------------------------------------------------------------------------
// Env reader
// ---------------------------------------------------------------------------

/**
 * Reads INTERVENTION_ESCALATION_DAYS from process.env.
 * Falls back to DEFAULT_ESCALATION_DAYS when the variable is absent or invalid.
 */
export function readEscalationDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['INTERVENTION_ESCALATION_DAYS'];
  if (!raw) return DEFAULT_ESCALATION_DAYS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ESCALATION_DAYS;
}

// ---------------------------------------------------------------------------
// Core escalation logic (exported for unit tests)
// ---------------------------------------------------------------------------

export interface EscalationCandidate {
  intervention_id: string;
  customer_id: string;
  days_open: number;
}

/**
 * Runs the escalation scan for a given list of candidates.
 * For each candidate, resolves the team lead and creates an escalation row.
 *
 * @param candidates     Interventions qualifying for escalation.
 * @param sqlClient      Postgres client (injected for tests).
 * @returns              Number of escalations created.
 */
export async function processEscalationCandidates(
  candidates: EscalationCandidate[],
  sqlClient?: Parameters<typeof listAlertsNeedingEscalation>[1],
): Promise<number> {
  let created = 0;

  for (const candidate of candidates) {
    // Resolve the assigned account manager so we can find their team lead.
    const amId = await getAssignedAccountManager(candidate.customer_id, sqlClient);
    const teamLeadId = await getTeamLeadForUser(amId ?? '', sqlClient);

    if (!teamLeadId) {
      console.log(
        `[intervention-escalation] No team lead found for customer ${candidate.customer_id} — skipping`,
      );
      continue;
    }

    await createEscalationNotification(
      {
        intervention_id: candidate.intervention_id,
        customer_id: candidate.customer_id,
        notified_user_id: teamLeadId,
        days_open: candidate.days_open,
      },
      sqlClient,
    );

    console.log(
      `[intervention-escalation] Escalated intervention ${candidate.intervention_id} (${candidate.days_open}d open) → team lead ${teamLeadId}`,
    );
    created += 1;
  }

  return created;
}

// ---------------------------------------------------------------------------
// Job registration
// ---------------------------------------------------------------------------

/**
 * Registers the intervention escalation cron job on the given scheduler.
 *
 * @param scheduler  - The CronScheduler instance.
 * @param expression - Cron expression. Defaults to daily at 07:00 UTC.
 */
export function registerInterventionEscalationJob(
  scheduler: CronScheduler,
  expression = INTERVENTION_ESCALATION_CRON_EXPRESSION,
): void {
  scheduler.register('intervention-escalation', expression, async (ctx) => {
    const runDate = new Date().toISOString().slice(0, 10);
    const escalationDays = readEscalationDays();

    console.log(
      `[cron] intervention-escalation: starting for ${runDate} (threshold=${escalationDays}d)`,
    );

    const candidates = await listAlertsNeedingEscalation(escalationDays);
    const created = await processEscalationCandidates(candidates);

    await ctx.enqueueCronTask({
      job_type: 'intervention_escalation_run',
      payload: {
        run_date: runDate,
        escalation_days: escalationDays,
        candidates_found: candidates.length,
        escalations_created: created,
      },
      idempotency_key_suffix: `intervention-escalation-${runDate}`,
      priority: 5,
      max_attempts: 1,
    });

    console.log(
      `[cron] intervention-escalation: done — candidates=${candidates.length} created=${created} date=${runDate}`,
    );
  });
}
