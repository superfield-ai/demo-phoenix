/**
 * @file kyc-worker
 *
 * KYC_VERIFY task worker handler for Phase 0 (P0-2).
 *
 * ## Responsibility
 *
 * `handleKycVerifyTask` is the single entry point for processing a claimed
 * KYC_VERIFY task. It:
 *
 *   1. Reads `prospect_id` from the task payload.
 *   2. Calls the configured `KycProvider.verify(prospectId)`.
 *   3. Writes the resulting `KYCRecord` row via `writeKycRecord`.
 *   4. Updates `Prospect.kyc_status`:
 *        - `"pass"`              → `kyc_passed`
 *        - `"fail"`              → `kyc_manual_review`
 *        - `"insufficient_data"` → `kyc_manual_review`
 *   5. Returns `{ kycRecordId }` for the task result payload.
 *
 * On provider error the function sets `kyc_status = kyc_manual_review` and
 * re-throws so the task runner can mark the task failed and schedule a retry.
 *
 * ## Wiring
 *
 * The worker binary (or integration test) must:
 *   - Claim a `kyc_verify` task from the queue.
 *   - Call `handleKycVerifyTask` with the claimed task row, a `KycProvider`
 *     instance (from `resolveKycProvider`), and a postgres client.
 *   - Mark the task completed (or failed) based on the result.
 *
 * ## Why no coupling to the task-queue claim/complete cycle here
 *
 * The handler is intentionally pure w.r.t. task status management so it can
 * be unit-tested with just a pg-container without spinning up the full worker
 * loop infrastructure.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/4
 */

import type postgres from 'postgres';
import type { TaskQueueRow } from './task-queue';
import type { KycProvider, KYCRecord } from './kyc-provider';
import { writeKycRecord, updateProspectKycStatus } from './kyc-provider';
import { sql as defaultSql } from './index';

export interface KycVerifyPayload {
  prospect_id: string;
}

export interface KycVerifyResult {
  kycRecordId: string;
  verification_status: string;
}

/**
 * Handles a claimed KYC_VERIFY task.
 *
 * @param task        The claimed task row (must have `agent_type = 'kyc_verify'`).
 * @param provider    KycProvider implementation to call.
 * @param sqlClient   Postgres client (defaults to the module-level pool).
 * @returns           Result payload to store in `task_queue.result`.
 * @throws            On provider error or if `prospect_id` is missing from payload.
 */
export async function handleKycVerifyTask(
  task: TaskQueueRow,
  provider: KycProvider,
  sqlClient: postgres.Sql = defaultSql,
): Promise<KycVerifyResult> {
  const payload = task.payload as Partial<KycVerifyPayload>;
  const prospectId = payload.prospect_id;

  if (!prospectId || typeof prospectId !== 'string') {
    throw new Error(
      `[kyc-worker] KYC_VERIFY task ${task.id} is missing a valid prospect_id in payload`,
    );
  }

  let verifyResult: Omit<KYCRecord, 'id' | 'prospect_id' | 'created_at'>;
  try {
    verifyResult = await provider.verify(prospectId);
  } catch (err) {
    // Provider threw — set manual review and re-throw so the task is marked failed.
    console.error(`[kyc-worker] provider.verify failed for prospect ${prospectId}:`, err);
    await updateProspectKycStatus(prospectId, 'kyc_manual_review', sqlClient).catch((updateErr) =>
      console.error(`[kyc-worker] failed to set kyc_manual_review on ${prospectId}:`, updateErr),
    );
    throw err;
  }

  // Write KYCRecord row.
  const kycRecord = await writeKycRecord(
    {
      prospect_id: prospectId,
      verification_status: verifyResult.verification_status,
      funding_stage: verifyResult.funding_stage,
      annual_revenue_est: verifyResult.annual_revenue_est,
      debt_load_est: verifyResult.debt_load_est,
      checked_at: verifyResult.checked_at,
      provider: verifyResult.provider,
    },
    sqlClient,
  );

  // Update Prospect.kyc_status based on result.
  const newStatus =
    verifyResult.verification_status === 'pass' ? 'kyc_passed' : 'kyc_manual_review';

  await updateProspectKycStatus(prospectId, newStatus, sqlClient);

  return {
    kycRecordId: kycRecord.id,
    verification_status: verifyResult.verification_status,
  };
}
