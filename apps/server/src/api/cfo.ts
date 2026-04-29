/**
 * @file api/cfo
 *
 * CFO dashboard API — executive summary bar (issue #12), lead score tier
 * trend chart (issue #15), and AR aging dashboard endpoints (issue #16).
 *
 * GET /api/cfo/summary
 *   Returns the five portfolio metrics for the CFO executive summary bar:
 *     - pipeline_by_tier        (A/B/C totals)
 *     - weighted_close_rate
 *     - ar_aging_buckets        (current/30/60/90/120+)
 *     - collection_recovery_rate_90d
 *     - active_score_model_version
 *
 * GET /api/cfo/ar-aging
 *   Returns bucket totals and a 12-month trend line.
 *   Auth: cfo or finance_controller role (or superuser).
 *   Returns 403 for any other authenticated role.
 *
 * GET /api/cfo/ar-aging/invoices?bucket=<bucket>
 *   Returns the invoice drilldown list for the specified aging bucket.
 *   Valid buckets: current, 30, 60, 90, 120+
 *   Auth: cfo or finance_controller role (or superuser).
 *   Returns 403 for any other authenticated role.
 *   Returns 400 when `bucket` param is missing or invalid.
 *
 * GET /api/cfo/tier-trend?period=current_quarter|prior_quarter
 *   Returns weekly tier-distribution buckets (tier_a_pct, tier_b_pct,
 *   tier_c_pct, total_volume) grouped by the week of Prospect.created_at.
 *
 *   Auth: same as /api/cfo/summary.
 *
 * Canonical docs: docs/prd.md
 * Issues:
 *   https://github.com/superfield-ai/demo-phoenix/issues/12
 *   https://github.com/superfield-ai/demo-phoenix/issues/15
 *   https://github.com/superfield-ai/demo-phoenix/issues/16
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { isSuperuser, makeJson } from '../lib/response';
import { getCfoSummary } from 'db/cfo-summary';
import { getTierTrend, type TierTrendPeriod } from 'db/cfo-tier-trend';
import { getArAging, getArAgingInvoices, type AgingBucket } from 'db/ar-aging';

const VALID_BUCKETS = new Set<string>(['current', '30', '60', '90', '120+']);

const CFO_ROLES = new Set(['cfo', 'finance_controller']);

/**
 * Returns true when the user is authorised to access CFO endpoints.
 * Superusers are always permitted.
 */
async function isCfoAuthorised(userId: string, sql: AppState['sql']): Promise<boolean> {
  if (isSuperuser(userId)) return true;

  const rows = await sql<{ properties: Record<string, unknown> }[]>`
    SELECT properties
    FROM entities
    WHERE id = ${userId}
      AND type = 'user'
    LIMIT 1
  `;

  const role = typeof rows[0]?.properties?.role === 'string' ? rows[0].properties.role : null;
  return role !== null && CFO_ROLES.has(role);
}

export async function handleCfoRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/cfo')) return null;

  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);
  const { sql } = appState;

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/cfo/summary
  // ──────────────────────────────────────────────────────────────────────────

  if (req.method === 'GET' && url.pathname === '/api/cfo/summary') {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const authorised = await isCfoAuthorised(user.id, sql);
    if (!authorised) return json({ error: 'Forbidden' }, 403);

    try {
      const summary = await getCfoSummary(sql);
      return json(summary, 200);
    } catch (err) {
      console.error('[cfo] summary query failed:', err);
      return json({ error: 'Internal Server Error' }, 500);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/cfo/tier-trend?period=current_quarter|prior_quarter
  // ──────────────────────────────────────────────────────────────────────────

  if (req.method === 'GET' && url.pathname === '/api/cfo/tier-trend') {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const authorised = await isCfoAuthorised(user.id, sql);
    if (!authorised) return json({ error: 'Forbidden' }, 403);

    const periodParam = url.searchParams.get('period') ?? 'current_quarter';
    const period: TierTrendPeriod =
      periodParam === 'prior_quarter' ? 'prior_quarter' : 'current_quarter';

    try {
      const buckets = await getTierTrend(period, sql);
      return json(buckets, 200);
    } catch (err) {
      console.error('[cfo] tier-trend query failed:', err);
      return json({ error: 'Internal Server Error' }, 500);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/cfo/ar-aging/invoices?bucket=<bucket>
  // Must be checked before /api/cfo/ar-aging to avoid prefix match ambiguity.
  // ──────────────────────────────────────────────────────────────────────────

  if (req.method === 'GET' && url.pathname === '/api/cfo/ar-aging/invoices') {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const authorised = await isCfoAuthorised(user.id, sql);
    if (!authorised) return json({ error: 'Forbidden' }, 403);

    const bucket = url.searchParams.get('bucket');
    if (!bucket || !VALID_BUCKETS.has(bucket)) {
      return json(
        {
          error: 'Bad Request: bucket parameter must be one of current, 30, 60, 90, 120+',
        },
        400,
      );
    }

    try {
      const invoices = await getArAgingInvoices(bucket as AgingBucket, sql);
      return json({ invoices }, 200);
    } catch (err) {
      console.error('[cfo] ar-aging/invoices query failed:', err);
      return json({ error: 'Internal Server Error' }, 500);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/cfo/ar-aging
  // ──────────────────────────────────────────────────────────────────────────

  if (req.method === 'GET' && url.pathname === '/api/cfo/ar-aging') {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const authorised = await isCfoAuthorised(user.id, sql);
    if (!authorised) return json({ error: 'Forbidden' }, 403);

    try {
      const aging = await getArAging(sql);
      return json(aging, 200);
    } catch (err) {
      console.error('[cfo] ar-aging query failed:', err);
      return json({ error: 'Internal Server Error' }, 500);
    }
  }

  return null;
}
