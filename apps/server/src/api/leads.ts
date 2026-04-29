/**
 * @file leads
 *
 * HTTP handlers for the Sales Rep lead queue, lead detail, and pipeline board
 * (Phase 1, P1-1, issues #7, #9, #10).
 *
 * ## Endpoints
 *
 *   GET /api/leads/queue
 *     Returns qualified Prospects for the authenticated rep, sorted by
 *     composite_score DESC by default. Supports query parameters:
 *       - filter[tier]       — comma-separated tier values (A, B, C)
 *       - filter[industry]   — comma-separated industry strings
 *       - filter[days_min]   — minimum days in queue (integer)
 *       - filter[days_max]   — maximum days in queue (integer)
 *       - filter[rep_id]     — rep ID to filter by (superuser only; ignored for normal reps)
 *       - sort               — 'score' (default) | 'cltv' | 'days'
 *
 *   GET /api/leads/disqualified
 *     Returns disqualified Prospects with disqualification_reason (read-only).
 *     No mutating actions are available on this endpoint.
 *
 *   GET    /api/leads/:id            — fetch full lead detail (Prospect + CLTVScore +
 *                                     KYCRecord + Deal + activity timeline)
 *   PATCH  /api/leads/:id/stage      — change pipeline stage (requires note, min 1 sentence)
 *   POST   /api/leads/:id/activities — log a quick action (call, email, follow_up, note)
 *
 *   GET /api/leads/pipeline
 *     Returns the authenticated rep's Prospects grouped by Deal.stage, each with:
 *       - prospect_id, company_name
 *       - tier (A/B/C/D from latest CLTVScore)
 *       - cltv_low, cltv_high (dollar-range estimate derived from composite_score × annual_revenue_est)
 *       - days_in_stage (days since the Deal.updated_at)
 *       - deal_id, stage
 *
 *     Only Prospects whose Deal.owner_rep_id matches the authenticated user's ID
 *     are returned — a rep cannot see cards for Prospects assigned to a different rep.
 *
 * ## Authentication
 *
 * All endpoints require a valid session cookie. The authenticated user's ID is
 * used as the `assigned_rep_id` filter — reps can only see their own leads.
 *
 * ## Empty-state data
 *
 * GET /api/leads/queue also returns a `pending_kyc_count` field in the response
 * envelope. When `leads` is empty this count is used by the UI to render a
 * contextual message instead of a blank screen.
 *
 * Canonical docs: docs/prd.md §4.1
 * Issues: https://github.com/superfield-ai/demo-phoenix/issues/7
 *         https://github.com/superfield-ai/demo-phoenix/issues/9
 *         https://github.com/superfield-ai/demo-phoenix/issues/10
 */

import type postgres from 'postgres';
import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { isSuperuser, makeJson } from '../lib/response';
import {
  getQueueLeads,
  getDisqualifiedLeads,
  getPendingKycCount,
  type LeadQueueSort,
} from 'db/leads-queue';

/**
 * `postgres.TransactionSql` omits the call signatures that make typed
 * tagged-template queries work. Cast the tx parameter to `postgres.Sql` to
 * restore them — this is the same pattern used in packages/db/rls-context.ts.
 */
type TxSql = postgres.Sql;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface LeadDetailResponse {
  prospect: ProspectDetail;
  cltv_score: CltvScoreDetail | null;
  kyc_record: KycRecordDetail | null;
  deal: DealDetail | null;
  timeline: ActivityEntry[];
}

export interface ProspectDetail {
  id: string;
  company_name: string;
  industry: string | null;
  sic_code: string | null;
  stage: string;
  assigned_rep_id: string | null;
  kyc_status: string;
  disqualification_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface CltvScoreDetail {
  id: string;
  composite_score: number;
  tier: string;
  macro_score: number | null;
  industry_score: number | null;
  company_score: number | null;
  rationale_macro: string | null;
  rationale_industry: string | null;
  rationale_company: string | null;
  score_version: string;
  computed_at: string;
  macro_inputs_snapshot: unknown;
  industry_inputs_snapshot: unknown;
  company_inputs_snapshot: unknown;
}

export interface KycRecordDetail {
  id: string;
  verification_status: string;
  funding_stage: string | null;
  annual_revenue_est: number | null;
  debt_load_est: number | null;
  checked_at: string | null;
}

export interface DealDetail {
  id: string;
  stage: string;
  value: number | null;
  currency: string;
  close_date: string | null;
  owner_rep_id: string | null;
}

export interface ActivityEntry {
  id: string;
  activity_type: string;
  actor_id: string | null;
  note: string | null;
  metadata: unknown;
  occurred_at: string;
}

// Valid quick-action activity types that reps can log.
const QUICK_ACTION_TYPES = ['call', 'email', 'follow_up', 'note'] as const;
type QuickActionType = (typeof QUICK_ACTION_TYPES)[number];

// Valid pipeline stage values for PATCH /api/leads/:id/stage.
const DEAL_STAGES = ['contacted', 'qualified', 'proposal', 'closed_won', 'closed_lost'] as const;
type DealStage = (typeof DEAL_STAGES)[number];

// Pipeline stages in display order
export const PIPELINE_STAGES = [
  'contacted',
  'qualified',
  'proposal',
  'closed_won',
  'closed_lost',
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export interface PipelineCard {
  deal_id: string;
  prospect_id: string;
  company_name: string;
  stage: PipelineStage;
  tier: string | null;
  cltv_low: number | null;
  cltv_high: number | null;
  days_in_stage: number;
}

export interface PipelineResponse {
  stages: {
    [stage in PipelineStage]: PipelineCard[];
  };
}

/**
 * Derives a CLTV dollar-range estimate from the composite score (0–100) and
 * the prospect's annual revenue estimate.
 *
 * The composite score is treated as a fraction of annual revenue that
 * represents expected lifetime value (e.g. score 80 → 80% of annual revenue).
 * A ±20% band is applied to produce the low/high range.
 *
 * If annual_revenue_est is null or zero the function returns null for both
 * bounds — the UI should display a dash or "N/A" instead of $0.
 */
export function deriveCLTVRange(
  compositeScore: number | null,
  annualRevenueEst: number | null,
): { cltv_low: number | null; cltv_high: number | null } {
  if (compositeScore === null || annualRevenueEst === null || annualRevenueEst <= 0) {
    return { cltv_low: null, cltv_high: null };
  }
  const mid = (compositeScore / 100) * annualRevenueEst;
  return {
    cltv_low: Math.round(mid * 0.8),
    cltv_high: Math.round(mid * 1.2),
  };
}

interface PipelineRow {
  deal_id: string;
  prospect_id: string;
  company_name: string;
  stage: string;
  tier: string | null;
  composite_score: number | null;
  annual_revenue_est: number | null;
  deal_updated_at: Date;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Handles all /api/leads/* routes.
 *
 * Returns null for any path that does not match — the caller falls through to
 * the next handler.
 */
export async function handleLeadsRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/leads')) return null;

  const corsHeaders = getCorsHeaders(req);
  const { sql } = appState;
  const json = makeJson(corsHeaders);

  // ── GET /api/leads/queue ─────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/leads/queue') {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    // Parse sort parameter
    const rawSort = url.searchParams.get('sort') ?? 'score';
    const sort: LeadQueueSort = rawSort === 'cltv' ? 'cltv' : rawSort === 'days' ? 'days' : 'score';

    // Parse filter parameters
    const tierRaw = url.searchParams.get('filter[tier]');
    const industryRaw = url.searchParams.get('filter[industry]');
    const daysMinRaw = url.searchParams.get('filter[days_min]');
    const daysMaxRaw = url.searchParams.get('filter[days_max]');
    const repIdRaw = url.searchParams.get('filter[rep_id]');

    const tier = tierRaw
      ? tierRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const industry = industryRaw
      ? industryRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const days_min = daysMinRaw !== null ? parseInt(daysMinRaw, 10) : undefined;
    const days_max = daysMaxRaw !== null ? parseInt(daysMaxRaw, 10) : undefined;
    // rep_id filter is passed through only for informational purposes — the
    // DB query always anchors on the authenticated user's own ID. We strip it.
    void repIdRaw;

    const [leads, pending_kyc_count] = await Promise.all([
      getQueueLeads(user.id, sort, { tier, industry, days_min, days_max }, sql),
      getPendingKycCount(user.id, sql),
    ]);

    return json({ leads, pending_kyc_count });
  }

  // ── GET /api/leads/disqualified ──────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/leads/disqualified') {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const leads = await getDisqualifiedLeads(user.id, sql);
    return json({ leads });
  }

  // ── GET /api/leads/pipeline ──────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/leads/pipeline') {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const rows = await sql<PipelineRow[]>`
      SELECT
        d.id                                        AS deal_id,
        p.id                                        AS prospect_id,
        p.company_name,
        d.stage,
        cs.tier,
        cs.composite_score::float8                  AS composite_score,
        k.annual_revenue_est::float8                AS annual_revenue_est,
        d.updated_at                                AS deal_updated_at
      FROM rl_deals d
      JOIN rl_prospects p
        ON p.id = d.prospect_id
      LEFT JOIN LATERAL (
        SELECT tier, composite_score
        FROM rl_cltv_scores
        WHERE entity_id = p.id AND entity_type = 'prospect'
        ORDER BY computed_at DESC
        LIMIT 1
      ) cs ON true
      LEFT JOIN LATERAL (
        SELECT annual_revenue_est
        FROM rl_kyc_records
        WHERE prospect_id = p.id
          AND verification_status != 'archived'
        ORDER BY created_at DESC
        LIMIT 1
      ) k ON true
      WHERE d.owner_rep_id = ${user.id}
      ORDER BY d.updated_at DESC
    `;

    // Build the grouped response
    const stages: PipelineResponse['stages'] = {
      contacted: [],
      qualified: [],
      proposal: [],
      closed_won: [],
      closed_lost: [],
    };

    const now = Date.now();

    for (const row of rows) {
      const stage = row.stage as PipelineStage;
      if (!(stage in stages)) continue;

      const { cltv_low, cltv_high } = deriveCLTVRange(row.composite_score, row.annual_revenue_est);

      const dealUpdatedMs = new Date(row.deal_updated_at).getTime();
      const days_in_stage = Math.max(0, Math.floor((now - dealUpdatedMs) / (1000 * 60 * 60 * 24)));

      stages[stage].push({
        deal_id: row.deal_id,
        prospect_id: row.prospect_id,
        company_name: row.company_name,
        stage,
        tier: row.tier,
        cltv_low,
        cltv_high,
        days_in_stage,
      });
    }

    return json({ stages });
  }

  // ── GET /api/leads/:id ─────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname.match(/^\/api\/leads\/[^/]+$/)) {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const prospectId = url.pathname.split('/')[3];

    // Fetch the prospect row.
    const [prospect] = await sql<
      {
        id: string;
        company_name: string;
        industry: string | null;
        sic_code: string | null;
        stage: string;
        assigned_rep_id: string | null;
        disqualification_reason: string | null;
        created_at: string;
        updated_at: string;
      }[]
    >`
      SELECT id, company_name, industry, sic_code, stage, assigned_rep_id,
             disqualification_reason,
             created_at::text AS created_at, updated_at::text AS updated_at
      FROM rl_prospects
      WHERE id = ${prospectId}
    `;

    if (!prospect) return json({ error: 'Not found' }, 404);

    // Authorization: only the assigned rep or a superuser may view.
    if (!isSuperuser(user.id) && prospect.assigned_rep_id !== user.id) {
      return json({ error: 'Forbidden' }, 403);
    }

    // Fetch the latest CLTVScore.
    const [cltvScore] = await sql<
      {
        id: string;
        composite_score: number;
        tier: string;
        macro_score: number | null;
        industry_score: number | null;
        company_score: number | null;
        rationale_macro: string | null;
        rationale_industry: string | null;
        rationale_company: string | null;
        score_version: string;
        computed_at: string;
        macro_inputs_snapshot: unknown;
        industry_inputs_snapshot: unknown;
        company_inputs_snapshot: unknown;
      }[]
    >`
      SELECT
        id,
        composite_score::float8 AS composite_score,
        tier,
        macro_score::float8 AS macro_score,
        industry_score::float8 AS industry_score,
        company_score::float8 AS company_score,
        rationale_macro, rationale_industry, rationale_company,
        score_version,
        computed_at::text AS computed_at,
        macro_inputs_snapshot,
        industry_inputs_snapshot,
        company_inputs_snapshot
      FROM rl_cltv_scores
      WHERE entity_id = ${prospectId} AND entity_type = 'prospect'
      ORDER BY computed_at DESC
      LIMIT 1
    `;

    // Fetch the latest active KYC record.
    const [kycRecord] = await sql<
      {
        id: string;
        verification_status: string;
        funding_stage: string | null;
        annual_revenue_est: number | null;
        debt_load_est: number | null;
        checked_at: string | null;
      }[]
    >`
      SELECT
        id, verification_status, funding_stage,
        annual_revenue_est::float8 AS annual_revenue_est,
        debt_load_est::float8 AS debt_load_est,
        checked_at::text AS checked_at
      FROM rl_kyc_records
      WHERE prospect_id = ${prospectId}
        AND verification_status != 'archived'
      ORDER BY created_at DESC
      LIMIT 1
    `;

    // Fetch the latest Deal row.
    const [deal] = await sql<
      {
        id: string;
        stage: string;
        value: number | null;
        currency: string;
        close_date: string | null;
        owner_rep_id: string | null;
      }[]
    >`
      SELECT id, stage, value::float8 AS value, currency,
             close_date::text AS close_date, owner_rep_id
      FROM rl_deals
      WHERE prospect_id = ${prospectId}
      ORDER BY created_at DESC
      LIMIT 1
    `;

    // Fetch the activity timeline, ordered most-recent first.
    const timeline = await sql<ActivityEntry[]>`
      SELECT id, activity_type, actor_id, note, metadata,
             occurred_at::text AS occurred_at
      FROM rl_activities
      WHERE prospect_id = ${prospectId}
      ORDER BY occurred_at DESC
    `;

    const response: LeadDetailResponse = {
      prospect: {
        id: prospect.id,
        company_name: prospect.company_name,
        industry: prospect.industry,
        sic_code: prospect.sic_code,
        stage: prospect.stage,
        assigned_rep_id: prospect.assigned_rep_id,
        // Expose stage as kyc_status for frontend compatibility.
        kyc_status: prospect.stage,
        disqualification_reason: prospect.disqualification_reason,
        created_at: prospect.created_at,
        updated_at: prospect.updated_at,
      },
      cltv_score: cltvScore ?? null,
      kyc_record: kycRecord ?? null,
      deal: deal ?? null,
      timeline,
    };

    return json(response);
  }

  // ── PATCH /api/leads/:id/stage ─────────────────────────────────────────────
  if (req.method === 'PATCH' && url.pathname.match(/^\/api\/leads\/[^/]+\/stage$/)) {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const prospectId = url.pathname.split('/')[3];

    // Fetch the prospect to check authorization.
    const [prospect] = await sql<{ id: string; assigned_rep_id: string | null }[]>`
      SELECT id, assigned_rep_id
      FROM rl_prospects
      WHERE id = ${prospectId}
    `;

    if (!prospect) return json({ error: 'Not found' }, 404);

    if (!isSuperuser(user.id) && prospect.assigned_rep_id !== user.id) {
      return json({ error: 'Forbidden' }, 403);
    }

    // Parse and validate the request body.
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const { stage, note } = body as { stage?: unknown; note?: unknown };

    // Validate note: required, must be at least one sentence (non-empty, >= 1 word).
    if (typeof note !== 'string' || note.trim().length === 0) {
      return json({ error: 'A note is required when changing stage', code: 'NOTE_REQUIRED' }, 422);
    }

    // A "sentence" is at least one complete word (we require at least 3 chars as
    // a reasonable lower bound — single letters are not a sentence).
    if (note.trim().length < 3) {
      return json({ error: 'Note must be at least one sentence', code: 'NOTE_TOO_SHORT' }, 422);
    }

    // Validate stage value.
    if (typeof stage !== 'string' || !DEAL_STAGES.includes(stage as DealStage)) {
      return json(
        {
          error: `stage must be one of: ${DEAL_STAGES.join(', ')}`,
          code: 'INVALID_STAGE',
        },
        422,
      );
    }

    const newStage = stage as DealStage;

    // Perform the stage update, activity insert, and optional customer creation
    // in a single transaction.
    let dealId: string;
    let activityId: string;
    let customerId: string | null = null;

    await sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as TxSql;

      // Upsert the Deal row: update if one exists for this prospect, create otherwise.
      const [existingDeal] = await tx<{ id: string }[]>`
        SELECT id FROM rl_deals WHERE prospect_id = ${prospectId} ORDER BY created_at DESC LIMIT 1
      `;

      if (existingDeal) {
        dealId = existingDeal.id;
        await tx`
          UPDATE rl_deals SET stage = ${newStage}, updated_at = NOW()
          WHERE id = ${dealId}
        `;
      } else {
        const [newDeal] = await tx<{ id: string }[]>`
          INSERT INTO rl_deals (prospect_id, stage, owner_rep_id)
          VALUES (${prospectId}, ${newStage}, ${user.id})
          RETURNING id
        `;
        dealId = newDeal.id;
      }

      // When transitioning to closed_won, atomically create a Customer record
      // if one does not already exist for this prospect (idempotent).
      if (newStage === 'closed_won') {
        // Fetch the prospect for company_name and segment.
        const [prospectRow] = await tx<
          {
            company_name: string;
            company_segment: string | null;
          }[]
        >`
          SELECT company_name, company_segment
          FROM rl_prospects
          WHERE id = ${prospectId}
        `;

        // Check whether a Customer already exists for this prospect.
        const [existingCustomer] = await tx<{ id: string }[]>`
          SELECT id FROM rl_customers WHERE prospect_id = ${prospectId} LIMIT 1
        `;

        if (existingCustomer) {
          customerId = existingCustomer.id;
        } else {
          const [newCustomer] = await tx<{ id: string }[]>`
            INSERT INTO rl_customers (prospect_id, company_name, segment)
            VALUES (
              ${prospectId},
              ${prospectRow?.company_name ?? 'Unknown'},
              ${prospectRow?.company_segment ?? null}
            )
            RETURNING id
          `;
          customerId = newCustomer.id;
        }
      }

      // Write the activity timeline entry.
      const [activityRow] = await tx<{ id: string }[]>`
        INSERT INTO rl_activities (prospect_id, activity_type, actor_id, note, metadata)
        VALUES (
          ${prospectId},
          'stage_change',
          ${user.id},
          ${note.trim()},
          ${tx.json({ new_stage: newStage } as never)}
        )
        RETURNING id
      `;
      activityId = activityRow.id;
    });

    return json({
      deal_id: dealId!,
      activity_id: activityId!,
      ...(customerId !== null ? { customer_id: customerId } : {}),
    });
  }

  // ── POST /api/leads/:id/activities ─────────────────────────────────────────
  if (req.method === 'POST' && url.pathname.match(/^\/api\/leads\/[^/]+\/activities$/)) {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const prospectId = url.pathname.split('/')[3];

    // Fetch the prospect to check authorization.
    const [prospect] = await sql<{ id: string; assigned_rep_id: string | null }[]>`
      SELECT id, assigned_rep_id
      FROM rl_prospects
      WHERE id = ${prospectId}
    `;

    if (!prospect) return json({ error: 'Not found' }, 404);

    if (!isSuperuser(user.id) && prospect.assigned_rep_id !== user.id) {
      return json({ error: 'Forbidden' }, 403);
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const { type, note, metadata } = body as {
      type?: unknown;
      note?: unknown;
      metadata?: unknown;
    };

    // Validate activity type.
    if (typeof type !== 'string' || !QUICK_ACTION_TYPES.includes(type as QuickActionType)) {
      return json(
        { error: `type must be one of: ${QUICK_ACTION_TYPES.join(', ')}`, code: 'INVALID_TYPE' },
        422,
      );
    }

    const activityType = type as QuickActionType;
    const noteStr = typeof note === 'string' ? note.trim() || null : null;
    const metaObj =
      metadata !== null && typeof metadata === 'object'
        ? (metadata as Record<string, unknown>)
        : {};

    const [activityRow] = await sql<{ id: string; occurred_at: string }[]>`
      INSERT INTO rl_activities (prospect_id, activity_type, actor_id, note, metadata)
      VALUES (
        ${prospectId},
        ${activityType},
        ${user.id},
        ${noteStr},
        ${sql.json(metaObj as never)}
      )
      RETURNING id, occurred_at::text AS occurred_at
    `;

    return json({ activity_id: activityRow.id, occurred_at: activityRow.occurred_at }, 201);
  }

  return null;
}
