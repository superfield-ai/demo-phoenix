/**
 * @file api/kyc
 *
 * KYC re-trigger and manual review queue endpoints (issue #52).
 *
 * ## Endpoints
 *
 *   POST /api/kyc/:prospect_id/trigger
 *     Initiates or re-triggers a KYC check for the given prospect.
 *     Archives any existing active KYCRecord, then creates a new one with a
 *     stub-deterministic outcome (verified / failed / insufficient_data).
 *     The outcome is controlled by KYC_STUB_OUTCOME env var or per-prospect
 *     seed, defaulting to a seeded pseudo-random choice.
 *     Auth: any authenticated user (sales_rep, lead_manager, superuser, etc.)
 *     On verified:   re-runs CLTV scoring and routes the prospect.
 *     On failed:     sets prospect.stage = kyc_manual_review.
 *     On insufficient_data: sets prospect.stage = kyc_manual_review without recomputing CLTV.
 *
 *   GET /api/kyc/manual-review
 *     Lists all prospects currently in kyc_manual_review stage with KYC
 *     failure reason and days since the flag was set.
 *     Auth: any authenticated user except sales_rep (compliance_officer, lead_manager, superuser).
 *
 *   PATCH /api/kyc/:prospect_id/review
 *     Reviewer clears the manual_review flag (action=verify) or rejects the
 *     prospect (action=reject).
 *     Auth: same as GET /api/kyc/manual-review.
 *
 * ## KYC stub
 *
 *   The stub outcome is resolved in this order:
 *     1. KYC_STUB_OUTCOME env var: 'verified' | 'failed' | 'insufficient_data'
 *     2. Seed: deterministic per prospect_id (char code sum mod 3).
 *        0 → verified, 1 → failed, 2 → insufficient_data
 *
 * Canonical docs: docs/prd.md §4.2
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/52
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { makeJson, isSuperuser } from '../lib/response';
import { score } from 'db/cltv-scorer';
import { route } from 'db/lead-routing';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The three possible stub KYC outcomes. */
export type KycOutcome = 'verified' | 'failed' | 'insufficient_data';

/** A row from the manual-review list query. */
export interface ManualReviewRow {
  prospect_id: string;
  company_name: string;
  industry: string | null;
  kyc_failure_reason: string | null;
  kyc_checked_at: string | null;
  /** Days since the prospect.updated_at (when the stage was set). */
  days_since_flag: number;
  /** The most-recent non-archived KYC record id. */
  kyc_record_id: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolves the KYC stub outcome.
 *
 * Uses KYC_STUB_OUTCOME env var when set, otherwise derives a deterministic
 * value from the prospect_id string to make tests predictable.
 */
export function resolveKycOutcome(
  prospectId: string,
  env: NodeJS.ProcessEnv = process.env,
): KycOutcome {
  const override = env.KYC_STUB_OUTCOME;
  if (override === 'verified' || override === 'failed' || override === 'insufficient_data') {
    return override;
  }
  // Deterministic per prospect_id: sum of char codes mod 3.
  let sum = 0;
  for (let i = 0; i < prospectId.length; i++) {
    sum += prospectId.charCodeAt(i);
  }
  const outcomes: KycOutcome[] = ['verified', 'failed', 'insufficient_data'];
  return outcomes[sum % 3]!;
}

/**
 * Returns true when the role is permitted to access the manual review queue
 * and perform review actions (i.e., NOT a plain sales_rep).
 */
function canAccessManualReview(role: string | null | undefined, userId: string): boolean {
  if (isSuperuser(userId)) return true;
  if (!role) return false;
  // sales_rep is the only excluded role.
  return role !== 'sales_rep';
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleKycRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/kyc')) return null;

  const corsHeaders = getCorsHeaders(req);
  const { sql } = appState;
  const json = makeJson(corsHeaders);

  // ── GET /api/kyc/manual-review ────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/kyc/manual-review') {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    // Resolve actor role.
    const [actorRow] = await sql<{ role: string | null }[]>`
      SELECT properties->>'role' AS role
      FROM entities
      WHERE id = ${user.id} AND type = 'user'
      LIMIT 1
    `;
    const actorRole = actorRow?.role ?? null;

    if (!canAccessManualReview(actorRole, user.id)) {
      return json({ error: 'Forbidden' }, 403);
    }

    const now = Date.now();

    const rows = await sql<
      {
        prospect_id: string;
        company_name: string;
        industry: string | null;
        kyc_failure_reason: string | null;
        kyc_checked_at: string | null;
        kyc_record_id: string | null;
        flagged_at: string | null;
      }[]
    >`
      SELECT
        p.id                                    AS prospect_id,
        p.company_name,
        p.industry,
        k.verification_status                   AS kyc_failure_reason,
        k.checked_at::text                      AS kyc_checked_at,
        k.id                                    AS kyc_record_id,
        p.updated_at::text                      AS flagged_at
      FROM rl_prospects p
      LEFT JOIN LATERAL (
        SELECT id, verification_status, checked_at
        FROM rl_kyc_records
        WHERE prospect_id = p.id
          AND verification_status != 'archived'
        ORDER BY created_at DESC
        LIMIT 1
      ) k ON true
      WHERE p.stage = 'kyc_manual_review'
      ORDER BY p.updated_at DESC
    `;

    const result: ManualReviewRow[] = rows.map((r) => {
      const flaggedMs = r.flagged_at ? new Date(r.flagged_at).getTime() : now;
      const days_since_flag = Math.max(0, Math.floor((now - flaggedMs) / (1000 * 60 * 60 * 24)));
      return {
        prospect_id: r.prospect_id,
        company_name: r.company_name,
        industry: r.industry,
        kyc_failure_reason: r.kyc_failure_reason,
        kyc_checked_at: r.kyc_checked_at,
        days_since_flag,
        kyc_record_id: r.kyc_record_id,
      };
    });

    return json({ prospects: result });
  }

  // ── POST /api/kyc/:prospect_id/trigger ────────────────────────────────────
  const triggerMatch = url.pathname.match(/^\/api\/kyc\/([^/]+)\/trigger$/);
  if (req.method === 'POST' && triggerMatch) {
    const prospectId = triggerMatch[1]!;

    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    // Verify the prospect exists.
    const [prospect] = await sql<{ id: string; stage: string }[]>`
      SELECT id, stage FROM rl_prospects WHERE id = ${prospectId}
    `;
    if (!prospect) return json({ error: 'Prospect not found' }, 404);

    // Archive any existing active KYC record.
    await sql`
      UPDATE rl_kyc_records
      SET verification_status = 'archived', updated_at = NOW()
      WHERE prospect_id = ${prospectId}
        AND verification_status != 'archived'
    `;

    // Resolve stub outcome.
    const outcome = resolveKycOutcome(prospectId);
    const checkedAt = new Date().toISOString();

    // Map outcome to verification_status for storage.
    // insufficient_data is stored as 'failed' in the KYC record but the
    // prospect stage is set to kyc_manual_review (same as 'failed').
    const verificationStatus: string = outcome === 'verified' ? 'verified' : 'failed';

    // Insert new KYC record.
    const [kycRecord] = await sql<{ id: string }[]>`
      INSERT INTO rl_kyc_records (prospect_id, verification_status, checked_at)
      VALUES (${prospectId}, ${verificationStatus}, ${checkedAt})
      RETURNING id
    `;

    if (outcome === 'verified') {
      // Update prospect stage to scored before routing.
      await sql`
        UPDATE rl_prospects SET stage = 'scored', updated_at = NOW()
        WHERE id = ${prospectId}
      `;

      // Re-run CLTV scoring.
      await score({ entity_id: prospectId, entity_type: 'prospect' }, sql);

      // Route the prospect — may qualify or disqualify.
      const routeResult = await route(prospectId, { sqlClient: sql });

      return json({
        kyc_record_id: kycRecord.id,
        outcome,
        checked_at: checkedAt,
        route_result: routeResult,
      });
    }

    // Failed or insufficient_data: set prospect stage to kyc_manual_review.
    await sql`
      UPDATE rl_prospects
      SET stage = 'kyc_manual_review', updated_at = NOW()
      WHERE id = ${prospectId}
    `;

    return json({
      kyc_record_id: kycRecord.id,
      outcome,
      checked_at: checkedAt,
      route_result: null,
    });
  }

  // ── PATCH /api/kyc/:prospect_id/review ────────────────────────────────────
  const reviewMatch = url.pathname.match(/^\/api\/kyc\/([^/]+)\/review$/);
  if (req.method === 'PATCH' && reviewMatch) {
    const prospectId = reviewMatch[1]!;

    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    // Resolve actor role.
    const [actorRow] = await sql<{ role: string | null }[]>`
      SELECT properties->>'role' AS role
      FROM entities
      WHERE id = ${user.id} AND type = 'user'
      LIMIT 1
    `;
    const actorRole = actorRow?.role ?? null;

    if (!canAccessManualReview(actorRole, user.id)) {
      return json({ error: 'Forbidden' }, 403);
    }

    // Verify the prospect exists and is in manual_review.
    const [prospect] = await sql<{ id: string; stage: string }[]>`
      SELECT id, stage FROM rl_prospects WHERE id = ${prospectId}
    `;
    if (!prospect) return json({ error: 'Prospect not found' }, 404);
    if (prospect.stage !== 'kyc_manual_review') {
      return json({ error: 'Prospect is not in kyc_manual_review stage' }, 409);
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const { action } = body as { action?: unknown };
    if (action !== 'verify' && action !== 'reject') {
      return json({ error: 'action must be "verify" or "reject"' }, 422);
    }

    if (action === 'reject') {
      // Disqualify the prospect.
      await sql`
        UPDATE rl_prospects
        SET stage = 'disqualified',
            disqualification_reason = 'kyc_not_verified',
            disqualified_at = NOW(),
            updated_at = NOW()
        WHERE id = ${prospectId}
      `;
      return json({ prospect_id: prospectId, action, stage: 'disqualified' });
    }

    // action === 'verify': update the active KYC record to verified.
    await sql`
      UPDATE rl_kyc_records
      SET verification_status = 'verified', updated_at = NOW(), checked_at = NOW()
      WHERE prospect_id = ${prospectId}
        AND verification_status != 'archived'
    `;

    // Update prospect stage to scored.
    await sql`
      UPDATE rl_prospects SET stage = 'scored', updated_at = NOW()
      WHERE id = ${prospectId}
    `;

    // Re-run CLTV scoring.
    await score({ entity_id: prospectId, entity_type: 'prospect' }, sql);

    // Route the prospect.
    const routeResult = await route(prospectId, { sqlClient: sql });

    return json({
      prospect_id: prospectId,
      action,
      stage: routeResult.stage,
      route_result: routeResult,
    });
  }

  return null;
}
