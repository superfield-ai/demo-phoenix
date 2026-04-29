/**
 * @file api/dunning
 *
 * Dunning timeline API (issue #48).
 *
 * ## Endpoints
 *
 *   GET /api/invoices/:id/dunning-actions
 *     Returns all DunningActions for a given invoice in chronological order.
 *     Auth: finance_controller, cfo, or superuser. Returns 403 for other roles.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/48
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { isSuperuser, makeJson } from '../lib/response';
import { getInvoice } from 'db/invoices';
import { listDunningActions } from 'db/dunning';

/** Roles that can read dunning timeline data. */
const READ_ROLES = new Set(['cfo', 'finance_controller']);

async function resolveActorRole(sql: AppState['sql'], userId: string): Promise<string | null> {
  const rows = await sql<{ properties: { role?: string } }[]>`
    SELECT properties
    FROM entities
    WHERE id = ${userId} AND type = 'user'
    LIMIT 1
  `;
  return rows[0]?.properties?.role ?? null;
}

/**
 * Route handler for dunning timeline endpoints.
 *
 * Returns null when the request does not match this handler's routes.
 */
export async function handleDunningRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  // Match /api/invoices/:id/dunning-actions
  const match = url.pathname.match(/^\/api\/invoices\/([^/]+)\/dunning-actions$/);
  if (!match) return null;

  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);
  const { sql } = appState;

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'GET') return null;

  const user = await getAuthenticatedUser(req);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  let callerRole: string | null;
  if (isSuperuser(user.id)) {
    callerRole = 'finance_controller';
  } else {
    callerRole = await resolveActorRole(sql, user.id);
  }

  if (!callerRole || !READ_ROLES.has(callerRole)) {
    return json({ error: 'Forbidden' }, 403);
  }

  const invoiceId = match[1];

  const invoice = await getInvoice(invoiceId, sql).catch(() => null);
  if (!invoice) {
    return json({ error: 'Invoice not found' }, 404);
  }

  try {
    const dunningActions = await listDunningActions(invoiceId, sql);
    return json({ dunning_actions: dunningActions }, 200);
  } catch (err) {
    console.error('[dunning] listDunningActions failed:', err);
    return json({ error: 'Internal Server Error' }, 500);
  }
}
