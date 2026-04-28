/**
 * @file leads
 *
 * HTTP handlers for the Sales Rep lead queue (Phase 1, P1-1).
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
 * ## Authentication
 *
 * Both endpoints require a valid session cookie. The authenticated user's ID is
 * used as the `assigned_rep_id` filter — reps can only see their own leads.
 *
 * ## Empty-state data
 *
 * GET /api/leads/queue also returns a `pending_kyc_count` field in the response
 * envelope. When `leads` is empty this count is used by the UI to render a
 * contextual message instead of a blank screen.
 *
 * Canonical docs: docs/prd.md §4.1
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/7
 */

import type { AppState } from '../index';
import { getAuthenticatedUser } from './auth';
import {
  getQueueLeads,
  getDisqualifiedLeads,
  getPendingKycCount,
  type LeadQueueSort,
} from 'db/leads-queue';

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Handles GET /api/leads/queue and GET /api/leads/disqualified.
 *
 * Returns null for any path that does not match — the caller falls through to
 * the next handler.
 */
export async function handleLeadsRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/leads/')) return null;
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const user = await getAuthenticatedUser(req);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { sql } = appState;

  // ── GET /api/leads/queue ─────────────────────────────────────────────────
  if (url.pathname === '/api/leads/queue') {
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

    return new Response(JSON.stringify({ leads, pending_kyc_count }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── GET /api/leads/disqualified ──────────────────────────────────────────
  if (url.pathname === '/api/leads/disqualified') {
    const leads = await getDisqualifiedLeads(user.id, sql);
    return new Response(JSON.stringify({ leads }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return null;
}
