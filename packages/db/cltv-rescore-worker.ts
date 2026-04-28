/**
 * @file cltv-rescore-worker.ts
 *
 * RESCORE task worker handler for Phase 0 (P0-3).
 *
 * ## Responsibility
 *
 * `handleRescoreTask` is the single entry point for processing a claimed
 * RESCORE task.  It:
 *
 *   1. Reads `entity_id` and `entity_type` from the task payload.
 *   2. Calls `score()` to compute a new CLTVScore row.
 *   3. Returns `{ cltvScoreId, compositeScore, tier }` for the task result.
 *
 * Previous CLTVScore rows for the same entity are NOT deleted; the history is
 * immutable by design.
 *
 * ## RESCORE payload
 *
 * | Field         | Type    | Description                                    |
 * |---------------|---------|------------------------------------------------|
 * | entity_id     | string  | ID of the Prospect or Customer to re-score     |
 * | entity_type   | string  | "prospect" or "customer"                       |
 * | trigger_id    | string  | ID of the row that triggered this re-score     |
 * | trigger_table | string  | "rl_macro_indicators" or "rl_industry_benchmarks" |
 *
 * ## Wiring
 *
 * The worker binary (or integration test) must:
 *   - Claim a `rescore` task from the queue.
 *   - Call `handleRescoreTask` with the claimed task row and a postgres client.
 *   - Mark the task completed (or failed) based on the result.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/5
 */

import type postgres from 'postgres';
import type { TaskQueueRow } from './task-queue';
import { score, type CLTVScoreRow, type EntityType, type ScoringConfig } from './cltv-scorer';
import { sql as defaultSql } from './index';
import { createNotification } from './notifications';

export interface RescorePayload {
  entity_id: string;
  entity_type: EntityType;
  trigger_id: string;
  trigger_table: string;
}

export interface RescoreResult {
  cltvScoreId: string;
  compositeScore: number;
  tier: string;
}

/**
 * Handles a claimed RESCORE task.
 *
 * @param task        The claimed task row (must have `agent_type = 'rescore'`).
 * @param sqlClient   Postgres client (defaults to the module-level pool).
 * @param config      Optional scoring config override (for tests).
 * @returns           Result payload to store in `task_queue.result`.
 * @throws            If `entity_id` or `entity_type` are missing from payload.
 */
export async function handleRescoreTask(
  task: TaskQueueRow,
  sqlClient: postgres.Sql = defaultSql,
  config?: ScoringConfig,
): Promise<RescoreResult> {
  const payload = task.payload as Partial<RescorePayload>;
  const entity_id = payload.entity_id;
  const entity_type = payload.entity_type;

  if (!entity_id || typeof entity_id !== 'string') {
    throw new Error(
      `[cltv-rescore-worker] RESCORE task ${task.id} is missing a valid entity_id in payload`,
    );
  }
  if (!entity_type || (entity_type !== 'prospect' && entity_type !== 'customer')) {
    throw new Error(
      `[cltv-rescore-worker] RESCORE task ${task.id} has invalid entity_type: ${String(entity_type)}`,
    );
  }

  // Read the previous score before re-scoring (for score-drop detection).
  const [prevScoreRow] = await sqlClient<{ composite_score: string | null }[]>`
    SELECT composite_score::TEXT AS composite_score
    FROM rl_cltv_scores
    WHERE entity_id = ${entity_id}
      AND entity_type = ${entity_type}
    ORDER BY computed_at DESC
    LIMIT 1
  `;
  const prevScore =
    prevScoreRow?.composite_score !== null && prevScoreRow?.composite_score !== undefined
      ? parseFloat(prevScoreRow.composite_score)
      : null;

  const cltvRow: CLTVScoreRow = await score({ entity_id, entity_type, config }, sqlClient);

  // Emit a score_drop notification when the entity is a Prospect in an active
  // pipeline (assigned_rep_id IS NOT NULL) and the new score is strictly lower.
  if (entity_type === 'prospect' && prevScore !== null && cltvRow.composite_score < prevScore) {
    const [prospectRow] = await sqlClient<
      {
        company_name: string;
        assigned_rep_id: string | null;
      }[]
    >`
      SELECT company_name, assigned_rep_id
      FROM rl_prospects
      WHERE id = ${entity_id}
    `;
    if (prospectRow?.assigned_rep_id) {
      await createNotification(
        {
          rep_id: prospectRow.assigned_rep_id,
          prospect_id: entity_id,
          event_type: 'score_drop',
          description: `Score dropped for ${prospectRow.company_name} (new: ${cltvRow.composite_score.toFixed(2)}, prev: ${prevScore.toFixed(2)})`,
        },
        sqlClient,
      );
    }
  }

  return {
    cltvScoreId: cltvRow.id,
    compositeScore: cltvRow.composite_score,
    tier: cltvRow.tier,
  };
}
