/**
 * @file api/customers
 *
 * Customer lifecycle API (issue #53) and customer health score API (issue #54).
 *
 * ## Endpoints
 *
 *   GET /api/customers
 *     List customers. Supports optional query params:
 *       - segment      — filter by customer segment (e.g. enterprise, mid_market, smb)
 *       - health_score — filter by health_score threshold (float, returns >= value)
 *     Auth: session cookie required.
 *
 *   GET /api/customers/:id
 *     Returns a single customer with company_name, segment, health_score,
 *     account_manager_id, and a linked invoice summary (count + total_amount).
 *     Auth: session cookie required.
 *
 *   PATCH /api/customers/:id
 *     Update account_manager_id for a customer.
 *     Body: { account_manager_id: string | null }
 *     Auth: session cookie required.
 *
 *   GET /api/customers/:id/health
 *     Returns the current health score and contributing signals for a customer.
 *     Response shape:
 *       {
 *         customer_id: string,
 *         score_date:  string,   // ISO date of the latest computed score
 *         score:       number,   // composite 0–100
 *         signals: [
 *           { label: string, value: number, contribution: number },
 *           ...
 *         ]
 *       }
 *     Returns 404 if no score has been computed yet for the customer.
 *     Auth: account_manager, collections_agent, finance_controller, cfo, or superuser.
 *
 * Customer records are created atomically when a Deal is transitioned to
 * closed_won (see api/leads.ts PATCH /api/leads/:id/stage).
 *
 * Canonical docs: docs/prd.md
 * Issues: https://github.com/superfield-ai/demo-phoenix/issues/53
 *         https://github.com/superfield-ai/demo-phoenix/issues/54
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { isSuperuser, makeJson } from '../lib/response';
import { getLatestCustomerHealthScore } from 'db/customer-health-scores';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CustomerRow {
  id: string;
  prospect_id: string | null;
  company_name: string;
  segment: string | null;
  health_score: number | null;
  account_manager_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CustomerDetail extends CustomerRow {
  invoice_count: number;
  invoice_total: number | null;
}

// ---------------------------------------------------------------------------
// Role constants (health score)
// ---------------------------------------------------------------------------

/** Roles that may read customer health data. */
const READ_ROLES = new Set(['account_manager', 'collections_agent', 'finance_controller', 'cfo']);

// ---------------------------------------------------------------------------
// Role resolver (health score)
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

/**
 * Handles all /api/customers/* routes.
 *
 * Returns null for any path that does not match — the caller falls through
 * to the next handler.
 */
export async function handleCustomersRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/customers')) return null;

  const corsHeaders = getCorsHeaders(req);
  const { sql } = appState;
  const json = makeJson(corsHeaders);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // ── GET /api/customers/:id/health ─────────────────────────────────────────
  const healthMatch = url.pathname.match(/^\/api\/customers\/([^/]+)\/health$/);
  if (healthMatch) {
    const customerId = healthMatch[1];

    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const superuser = isSuperuser(user.id);
    let callerRole: string | null;
    if (superuser) {
      callerRole = 'account_manager';
    } else {
      callerRole = await resolveActorRole(sql, user.id);
    }

    if (!callerRole || !READ_ROLES.has(callerRole)) {
      return json({ error: 'Forbidden' }, 403);
    }

    if (req.method !== 'GET') {
      return json({ error: 'Method Not Allowed' }, 405);
    }

    const scoreRow = await getLatestCustomerHealthScore(customerId, sql);

    if (!scoreRow) {
      return json({ error: 'No health score found for this customer' }, 404);
    }

    return json({
      customer_id: scoreRow.customer_id,
      score_date: scoreRow.score_date,
      score: scoreRow.score,
      signals: [
        {
          label: 'Days overdue on most recent invoice',
          value: scoreRow.days_overdue_value,
          contribution: scoreRow.days_overdue_signal,
        },
        {
          label: 'Payment plan breaches (last 6 months)',
          value: scoreRow.breach_count_value,
          contribution: scoreRow.breach_count_signal,
        },
        {
          label: 'Collection case escalation level',
          value: scoreRow.escalation_level_value,
          contribution: scoreRow.escalation_signal,
        },
      ],
    });
  }

  // ── GET /api/customers ────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/customers') {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const segment = url.searchParams.get('segment');
    const healthScoreRaw = url.searchParams.get('health_score');
    const healthScoreMin = healthScoreRaw !== null ? parseFloat(healthScoreRaw) : null;

    let customers: CustomerRow[];

    if (segment !== null && healthScoreMin !== null) {
      customers = await sql<CustomerRow[]>`
        SELECT id, prospect_id, company_name, segment,
               health_score::float8 AS health_score,
               account_manager_id,
               created_at::text AS created_at,
               updated_at::text AS updated_at
        FROM rl_customers
        WHERE segment = ${segment}
          AND health_score >= ${healthScoreMin}
        ORDER BY created_at DESC
      `;
    } else if (segment !== null) {
      customers = await sql<CustomerRow[]>`
        SELECT id, prospect_id, company_name, segment,
               health_score::float8 AS health_score,
               account_manager_id,
               created_at::text AS created_at,
               updated_at::text AS updated_at
        FROM rl_customers
        WHERE segment = ${segment}
        ORDER BY created_at DESC
      `;
    } else if (healthScoreMin !== null) {
      customers = await sql<CustomerRow[]>`
        SELECT id, prospect_id, company_name, segment,
               health_score::float8 AS health_score,
               account_manager_id,
               created_at::text AS created_at,
               updated_at::text AS updated_at
        FROM rl_customers
        WHERE health_score >= ${healthScoreMin}
        ORDER BY created_at DESC
      `;
    } else {
      customers = await sql<CustomerRow[]>`
        SELECT id, prospect_id, company_name, segment,
               health_score::float8 AS health_score,
               account_manager_id,
               created_at::text AS created_at,
               updated_at::text AS updated_at
        FROM rl_customers
        ORDER BY created_at DESC
      `;
    }

    return json({ customers });
  }

  // ── GET /api/customers/:id ────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname.match(/^\/api\/customers\/[^/]+$/)) {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const customerId = url.pathname.split('/')[3];

    const [customer] = await sql<CustomerRow[]>`
      SELECT id, prospect_id, company_name, segment,
             health_score::float8 AS health_score,
             account_manager_id,
             created_at::text AS created_at,
             updated_at::text AS updated_at
      FROM rl_customers
      WHERE id = ${customerId}
    `;

    if (!customer) return json({ error: 'Not found' }, 404);

    // Fetch linked invoice summary.
    const [invoiceSummary] = await sql<{ invoice_count: string; invoice_total: string | null }[]>`
      SELECT COUNT(*)::text AS invoice_count,
             SUM(amount)::text AS invoice_total
      FROM rl_invoices
      WHERE customer_id = ${customerId}
    `;

    const detail: CustomerDetail = {
      ...customer,
      invoice_count: parseInt(invoiceSummary?.invoice_count ?? '0', 10),
      invoice_total: invoiceSummary?.invoice_total
        ? parseFloat(invoiceSummary.invoice_total)
        : null,
    };

    return json(detail);
  }

  // ── PATCH /api/customers/:id ──────────────────────────────────────────────
  if (req.method === 'PATCH' && url.pathname.match(/^\/api\/customers\/[^/]+$/)) {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const customerId = url.pathname.split('/')[3];

    // Verify customer exists.
    const [existing] = await sql<{ id: string }[]>`
      SELECT id FROM rl_customers WHERE id = ${customerId}
    `;
    if (!existing) return json({ error: 'Not found' }, 404);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const { account_manager_id } = body as { account_manager_id?: unknown };

    // account_manager_id must be a string or null (explicit null to unassign).
    if (account_manager_id !== null && typeof account_manager_id !== 'string') {
      return json(
        { error: 'account_manager_id must be a string or null', code: 'INVALID_FIELD' },
        422,
      );
    }

    const [updated] = await sql<CustomerRow[]>`
      UPDATE rl_customers
      SET account_manager_id = ${account_manager_id as string | null},
          updated_at = NOW()
      WHERE id = ${customerId}
      RETURNING id, prospect_id, company_name, segment,
                health_score::float8 AS health_score,
                account_manager_id,
                created_at::text AS created_at,
                updated_at::text AS updated_at
    `;

    return json(updated);
  }

  return null;
}
