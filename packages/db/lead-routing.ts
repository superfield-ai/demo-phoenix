/**
 * @file lead-routing
 *
 * Lead qualification routing engine for Phase 0 (P0-4 / issue #6).
 *
 * ## Responsibility
 *
 * `route(prospectId)` is called after each CLTVScore is written. It:
 *
 *   1. Reads the latest KYCRecord for the Prospect.
 *   2. Reads the latest CLTVScore for the Prospect.
 *   3. Evaluates the qualification rule:
 *        - KYCRecord.verification_status must be 'verified'
 *        - CLTVScore.composite_score >= QUALIFICATION_THRESHOLD (env var)
 *   4a. On qualification: sets rl_prospects.stage = 'qualified' and
 *       assigns a rep via round-robin (QUEUE_ASSIGN_MODE=round_robin) or manual
 *       override (QUEUE_ASSIGN_MODE=manual + explicit rep_id argument).
 *   4b. On disqualification: sets rl_prospects.stage = 'disqualified',
 *       populates disqualification_reason, and enqueues a RESCORE_SCHEDULE task.
 *
 * ## Environment variables
 *
 *   QUALIFICATION_THRESHOLD  — numeric (0–1); defaults to 0.5.
 *                              Changing this takes effect on the next route() call.
 *   QUEUE_ASSIGN_MODE        — 'round_robin' (default) | 'manual'.
 *
 * ## Round-robin assignment
 *
 * Active sales reps are fetched from the `entities` table where
 * `type = 'user'` and `properties->>'role' = 'sales_rep'`, ordered by id
 * for deterministic cycling. The round-robin counter is stored in memory
 * (module-level) and falls back gracefully when no reps are available — in
 * that case the Prospect is qualified but `assigned_rep_id` remains NULL.
 *
 * ## Integration test surface
 *
 * The `route()` function accepts an optional `sqlClient` override so
 * integration tests can run against an ephemeral pg-container.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/6
 */

import type postgres from 'postgres';
import { sql as defaultSql } from './index';
import type { TaskQueueRow } from './task-queue';
import { TaskType, TASK_TYPE_AGENT_MAP } from './task-queue';
import { createNotification } from './notifications';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Possible disqualification reasons stored on rl_prospects. */
export type DisqualificationReason =
  | 'score_below_threshold'
  | 'kyc_not_verified'
  | 'kyc_manual_review';

/** Stage values relevant to routing output. */
export type RoutingStage = 'qualified' | 'disqualified';

/** Prospect row shape returned after routing. */
export interface RlProspectRow {
  id: string;
  company_name: string;
  industry: string | null;
  sic_code: string | null;
  stage: string;
  assigned_rep_id: string | null;
  disqualification_reason: DisqualificationReason | null;
  disqualified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Result returned by route(). */
export interface RouteResult {
  stage: RoutingStage;
  assigned_rep_id: string | null;
  disqualification_reason: DisqualificationReason | null;
  rescore_task_id: string | null;
}

/** Options accepted by route(). */
export interface RouteOptions {
  /**
   * For QUEUE_ASSIGN_MODE=manual: the explicit rep_id to assign.
   * Ignored when QUEUE_ASSIGN_MODE=round_robin.
   */
  manualRepId?: string;
  /**
   * System user ID used as created_by on the RESCORE_SCHEDULE task.
   * Defaults to 'system'.
   */
  systemUserId?: string;
  /** Optional postgres client override (for integration tests). */
  sqlClient?: postgres.Sql;
  /** Optional env override (for unit-testing config resolution). */
  env?: NodeJS.ProcessEnv;
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory round-robin counter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Module-level counter for round-robin assignment.
 * Incremented on each qualified assignment. Wraps at Number.MAX_SAFE_INTEGER.
 */
let rrCounter = 0;

/**
 * Resets the round-robin counter. Exposed for test isolation only — do not
 * call in production code.
 */
export function resetRoundRobinCounter(): void {
  rrCounter = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves the numeric qualification threshold from the environment.
 *
 * Reads QUALIFICATION_THRESHOLD; falls back to 0.5 if missing or unparseable.
 * The threshold is a value in [0, 1] because rl_cltv_scores.composite_score
 * is stored as NUMERIC(5,4) (i.e. four decimal places, range 0–1).
 */
export function resolveQualificationThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.QUALIFICATION_THRESHOLD;
  if (!raw) return 0.5;
  const parsed = parseFloat(raw);
  return isNaN(parsed) ? 0.5 : parsed;
}

/**
 * Resolves the queue assignment mode from the environment.
 *
 * Reads QUEUE_ASSIGN_MODE; defaults to 'round_robin'.
 */
export function resolveQueueAssignMode(
  env: NodeJS.ProcessEnv = process.env,
): 'round_robin' | 'manual' {
  const raw = env.QUEUE_ASSIGN_MODE;
  if (raw === 'manual') return 'manual';
  return 'round_robin';
}

// ─────────────────────────────────────────────────────────────────────────────
// DB helpers (private)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Enqueues a task using the provided sqlClient so integration tests can inject
 * an ephemeral pg-container client rather than the module-level pool.
 * Mirrors the idempotency logic from task-queue.ts.
 */
async function enqueueTaskWithClient(
  options: {
    idempotency_key: string;
    agent_type: string;
    job_type: string;
    payload: Record<string, unknown>;
    created_by: string;
  },
  sqlClient: postgres.Sql,
): Promise<TaskQueueRow> {
  const { idempotency_key, agent_type, job_type, payload, created_by } = options;
  const [row] = await sqlClient<TaskQueueRow[]>`
    INSERT INTO task_queue
      (idempotency_key, agent_type, job_type, payload, correlation_id,
       created_by, priority, max_attempts)
    VALUES
      (${idempotency_key}, ${agent_type}, ${job_type}, ${sqlClient.json(payload as never)},
       NULL, ${created_by}, 5, 3)
    ON CONFLICT (idempotency_key) DO UPDATE
      SET updated_at = task_queue.updated_at
    RETURNING *
  `;
  return row;
}

interface KycRecordRow {
  id: string;
  prospect_id: string;
  verification_status: string;
}

interface CltvsScoreRow {
  id: string;
  entity_id: string;
  entity_type: string;
  composite_score: number | null;
  computed_at: Date;
}

interface SalesRepRow {
  id: string;
}

interface ProspectStageRow {
  id: string;
  stage: string;
}

/**
 * Fetches the current stage of a Prospect.
 * Returns null if not found.
 */
async function fetchProspectStage(
  prospectId: string,
  sqlClient: postgres.Sql,
): Promise<ProspectStageRow | null> {
  const rows = await sqlClient<ProspectStageRow[]>`
    SELECT id, stage
    FROM rl_prospects
    WHERE id = ${prospectId}
  `;
  return rows[0] ?? null;
}

/**
 * Fetches the latest non-archived KYC record for a Prospect.
 * Returns null if none exists.
 */
async function fetchLatestKycRecord(
  prospectId: string,
  sqlClient: postgres.Sql,
): Promise<KycRecordRow | null> {
  const rows = await sqlClient<KycRecordRow[]>`
    SELECT id, prospect_id, verification_status
    FROM rl_kyc_records
    WHERE prospect_id = ${prospectId}
      AND verification_status != 'archived'
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Fetches the latest CLTVScore row for a Prospect (entity_type = 'prospect').
 * Returns null if none exists.
 */
async function fetchLatestCltvScore(
  prospectId: string,
  sqlClient: postgres.Sql,
): Promise<CltvsScoreRow | null> {
  const rows = await sqlClient<CltvsScoreRow[]>`
    SELECT id, entity_id, entity_type, composite_score::FLOAT AS composite_score, computed_at
    FROM rl_cltv_scores
    WHERE entity_id = ${prospectId}
      AND entity_type = 'prospect'
    ORDER BY computed_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Fetches active sales rep entity IDs, ordered by id for deterministic cycling.
 */
async function fetchActiveSalesReps(sqlClient: postgres.Sql): Promise<SalesRepRow[]> {
  const rows = await sqlClient<SalesRepRow[]>`
    SELECT id
    FROM entities
    WHERE type = 'user'
      AND properties->>'role' = 'sales_rep'
    ORDER BY id ASC
  `;
  return rows;
}

/**
 * Updates rl_prospects to reflect the routing outcome.
 */
async function updateProspectRouting(
  prospectId: string,
  stage: RoutingStage,
  assignedRepId: string | null,
  disqualificationReason: DisqualificationReason | null,
  sqlClient: postgres.Sql,
): Promise<RlProspectRow | null> {
  const rows = await sqlClient<RlProspectRow[]>`
    UPDATE rl_prospects
    SET
      stage                   = ${stage},
      assigned_rep_id         = ${assignedRepId},
      disqualification_reason = ${disqualificationReason},
      disqualified_at         = ${stage === 'disqualified' ? sqlClient`NOW()` : null},
      updated_at              = NOW()
    WHERE id = ${prospectId}
    RETURNING *
  `;
  return rows[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluates the qualification rule for a Prospect and routes it.
 *
 * Called automatically after each CLTVScore INSERT (application hook, not DB
 * trigger). Also safe to call manually for re-evaluation.
 *
 * Qualification requires BOTH conditions:
 *   - The Prospect's latest KYC record has verification_status = 'verified'
 *   - The Prospect's latest CLTVScore.composite_score >= QUALIFICATION_THRESHOLD
 *
 * On qualification: sets stage = 'qualified' and assigns a rep.
 * On disqualification: sets stage = 'disqualified', writes disqualification_reason,
 *   and enqueues a RESCORE_SCHEDULE task.
 *
 * @param prospectId   The `rl_prospects.id` of the Prospect to route.
 * @param options      Optional configuration overrides.
 * @returns            The routing outcome.
 * @throws             If the Prospect row is not found.
 */
export async function route(prospectId: string, options: RouteOptions = {}): Promise<RouteResult> {
  const {
    manualRepId,
    systemUserId = 'system',
    sqlClient = defaultSql,
    env = process.env,
  } = options;

  const threshold = resolveQualificationThreshold(env);
  const assignMode = resolveQueueAssignMode(env);

  // 1. Read Prospect stage (covers kyc_manual_review before a KYC record exists).
  const prospectRow = await fetchProspectStage(prospectId, sqlClient);

  // 2. Read latest KYC record.
  const kycRecord = await fetchLatestKycRecord(prospectId, sqlClient);

  // 3. Read latest CLTV score.
  const cltvScore = await fetchLatestCltvScore(prospectId, sqlClient);

  // 4. Evaluate disqualification conditions.
  let disqualificationReason: DisqualificationReason | null = null;

  // Check Prospect stage first: if stage = kyc_manual_review the Prospect is
  // awaiting human review and cannot be routed to the sales queue.
  if (prospectRow?.stage === 'kyc_manual_review') {
    disqualificationReason = 'kyc_manual_review';
  } else if (!kycRecord || kycRecord.verification_status === 'failed') {
    disqualificationReason = 'kyc_not_verified';
  } else if (kycRecord.verification_status === 'pending') {
    // Still awaiting KYC — treat as not verified.
    disqualificationReason = 'kyc_not_verified';
  } else if (kycRecord.verification_status !== 'verified') {
    // Any other non-verified status is treated as not verified.
    disqualificationReason = 'kyc_not_verified';
  }

  // Check score threshold only if KYC has not already disqualified.
  if (disqualificationReason === null) {
    const score = cltvScore?.composite_score ?? null;
    if (score === null || score < threshold) {
      disqualificationReason = 'score_below_threshold';
    }
  }

  // 4. Route based on result.
  if (disqualificationReason !== null) {
    // Disqualify.
    await updateProspectRouting(
      prospectId,
      'disqualified',
      null,
      disqualificationReason,
      sqlClient,
    );

    // Enqueue RESCORE_SCHEDULE task so the Prospect is re-evaluated when
    // MacroIndicator or KYC data changes.
    const rescoreTask = await enqueueTaskWithClient(
      {
        idempotency_key: `rescore_schedule:${prospectId}`,
        agent_type: TASK_TYPE_AGENT_MAP[TaskType.RESCORE_SCHEDULE],
        job_type: TaskType.RESCORE_SCHEDULE,
        payload: { prospect_id: prospectId, disqualification_reason: disqualificationReason },
        created_by: systemUserId,
      },
      sqlClient,
    );

    return {
      stage: 'disqualified',
      assigned_rep_id: null,
      disqualification_reason: disqualificationReason,
      rescore_task_id: rescoreTask.id,
    };
  }

  // Qualify: assign a rep.
  let assignedRepId: string | null = null;

  if (assignMode === 'manual' && manualRepId) {
    assignedRepId = manualRepId;
  } else {
    // Round-robin: fetch active reps and pick by counter.
    const reps = await fetchActiveSalesReps(sqlClient);
    if (reps.length > 0) {
      const index = rrCounter % reps.length;
      assignedRepId = reps[index]!.id;
      rrCounter = (rrCounter + 1) % Number.MAX_SAFE_INTEGER;
    }
    // If no reps are available, assignedRepId stays null but Prospect is qualified.
  }

  await updateProspectRouting(prospectId, 'qualified', assignedRepId, null, sqlClient);

  // Create a new_lead notification for the assigned rep (if one was assigned).
  if (assignedRepId) {
    const [prospectNameRow] = await sqlClient<{ company_name: string }[]>`
      SELECT company_name FROM rl_prospects WHERE id = ${prospectId}
    `;
    const companyName = prospectNameRow?.company_name ?? 'Unknown';
    await createNotification(
      {
        rep_id: assignedRepId,
        prospect_id: prospectId,
        event_type: 'new_lead',
        description: `New qualified lead: ${companyName}`,
      },
      sqlClient,
    );
  }

  return {
    stage: 'qualified',
    assigned_rep_id: assignedRepId,
    disqualification_reason: null,
    rescore_task_id: null,
  };
}
