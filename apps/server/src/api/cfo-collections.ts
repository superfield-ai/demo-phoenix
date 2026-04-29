/**
 * @file api/cfo-collections
 *
 * Collections performance panel API — CFO dashboard (issue #17).
 *
 * GET /api/cfo/collections-performance
 *   Returns four metrics for the collections performance panel:
 *     - agent_recovery_rates       (anonymized agent IDs for cfo; real IDs for finance_controller)
 *     - avg_days_to_resolution_by_escalation_level
 *     - write_off_rate_12m
 *     - write_off_amount_12m
 *     - payment_plan_success_rate
 *
 *   Auth: cfo or finance_controller role (or superuser).
 *   Returns 403 for any other authenticated role.
 *   Returns 401 for unauthenticated requests.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/17
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { isSuperuser, makeJson } from '../lib/response';
import { getCollectionsPerformance } from 'db/collections-performance';

const COLLECTIONS_ALLOWED_ROLES = new Set(['cfo', 'finance_controller']);

async function resolveActorRole(sql: AppState['sql'], userId: string): Promise<string | null> {
  const rows = await sql<{ properties: { role?: string } }[]>`
    SELECT properties
    FROM entities
    WHERE id = ${userId} AND type = 'user'
    LIMIT 1
  `;
  return rows[0]?.properties?.role ?? null;
}

export async function handleCfoCollectionsRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/cfo/collections-performance')) return null;

  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);
  const { sql } = appState;

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method === 'GET' && url.pathname === '/api/cfo/collections-performance') {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    let callerRole: string | null = null;
    if (!isSuperuser(user.id)) {
      callerRole = await resolveActorRole(sql, user.id);
      if (!callerRole || !COLLECTIONS_ALLOWED_ROLES.has(callerRole)) {
        return json({ error: 'Forbidden' }, 403);
      }
    } else {
      // Superusers get finance_controller visibility (real names).
      callerRole = 'finance_controller';
    }

    try {
      const performance = await getCollectionsPerformance(callerRole, sql);
      return json(performance, 200);
    } catch (err) {
      console.error('[cfo-collections] query failed:', err);
      return json({ error: 'Internal Server Error' }, 500);
    }
  }

  return null;
}
