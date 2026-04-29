/**
 * @file api/account-manager
 *
 * Account Manager customer health dashboard API (issue #55).
 *
 * ## Endpoints
 *
 *   GET /api/account-manager/customers
 *     List customers assigned to the logged-in Account Manager.
 *     Returns customers sorted by health_score ascending (most at-risk first).
 *     Each row includes: id, company_name, segment, health_score, trend,
 *       has_alert, alert_days.
 *     Auth: account_manager or superuser. Returns 403 for other roles.
 *
 *   GET /api/account-manager/customers/:id
 *     Customer health detail: current score, contributing signals, 30-day history.
 *     Auth: account_manager or superuser. The customer must be assigned to the
 *       logged-in AM (unless superuser). Returns 404 otherwise.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/55
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { isSuperuser, makeJson } from '../lib/response';
import {
  listCustomersForAccountManager,
  getCustomerHealthDetail,
} from 'db/account-manager-customers';

// ---------------------------------------------------------------------------
// Role resolver
// ---------------------------------------------------------------------------

async function resolveActorRole(sql: AppState['sql'], userId: string): Promise<string | null> {
  const rows = await sql<{ properties: { role?: string } }[]>`
    SELECT properties
    FROM entities
    WHERE id = ${userId} AND type = 'user'
    LIMIT 1
  `;
  return rows[0]?.properties?.role ?? null;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleAccountManagerRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/account-manager')) return null;

  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);
  const { sql } = appState;

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const user = await getAuthenticatedUser(req);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const superuser = isSuperuser(user.id);
  let callerRole: string | null;
  if (superuser) {
    callerRole = 'account_manager';
  } else {
    callerRole = await resolveActorRole(sql, user.id);
  }

  if (!callerRole || callerRole !== 'account_manager') {
    return json({ error: 'Forbidden' }, 403);
  }

  // ── GET /api/account-manager/customers ──────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/account-manager/customers') {
    try {
      const customers = await listCustomersForAccountManager(user.id, sql);
      return json({ customers }, 200);
    } catch (err) {
      console.error('[account-manager] listCustomersForAccountManager failed:', err);
      return json({ error: 'Internal Server Error' }, 500);
    }
  }

  // ── GET /api/account-manager/customers/:id ───────────────────────────────
  const detailMatch = url.pathname.match(/^\/api\/account-manager\/customers\/([^/]+)$/);
  if (detailMatch && req.method === 'GET') {
    const customerId = detailMatch[1];
    try {
      const detail = await getCustomerHealthDetail(customerId, user.id, sql);
      if (!detail) {
        return json({ error: 'Customer not found' }, 404);
      }
      return json(detail, 200);
    } catch (err) {
      console.error('[account-manager] getCustomerHealthDetail failed:', err);
      return json({ error: 'Internal Server Error' }, 500);
    }
  }

  return null;
}
