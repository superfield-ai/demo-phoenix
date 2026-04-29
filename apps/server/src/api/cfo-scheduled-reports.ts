/**
 * @file cfo-scheduled-reports
 *
 * HTTP handlers for CFO scheduled report configurations (issue #18).
 *
 * ## Endpoints
 *
 *   POST /api/cfo/scheduled-reports
 *     Creates a scheduled report config for the authenticated CFO/finance_controller.
 *     Body: { frequency: 'weekly'|'monthly', format: 'pdf'|'csv', recipient_email: string }
 *     Returns 201 on success.
 *     Returns 403 for users without cfo or finance_controller role.
 *
 *   GET /api/cfo/scheduled-reports
 *     Lists scheduled report configs belonging to the authenticated user.
 *     Returns 200 with { reports: ScheduledReport[] }.
 *
 *   DELETE /api/cfo/scheduled-reports/:id
 *     Removes a scheduled report config owned by the authenticated user.
 *     Returns 204 on success.
 *     Returns 404 if the config does not exist or belongs to another user.
 *
 * ## Role gate
 *
 * All endpoints require the authenticated user to have role 'cfo' or
 * 'finance_controller'. Superusers bypass the role check.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/18
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { isSuperuser, makeJson } from '../lib/response';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ScheduledReport {
  id: string;
  user_id: string;
  frequency: 'weekly' | 'monthly';
  format: 'pdf' | 'csv';
  recipient_email: string;
  created_at: string;
  updated_at: string;
}

interface CreateReportBody {
  frequency: string;
  format: string;
  recipient_email: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const CFO_ROLES = new Set(['cfo', 'finance_controller']);
const VALID_FREQUENCIES = new Set(['weekly', 'monthly']);
const VALID_FORMATS = new Set(['pdf', 'csv']);

// ─────────────────────────────────────────────────────────────────────────────
// Role helper
// ─────────────────────────────────────────────────────────────────────────────

async function isCfoAuthorised(userId: string, sql: AppState['sql']): Promise<boolean> {
  if (isSuperuser(userId)) return true;
  const rows = await sql<{ properties: { role?: string } }[]>`
    SELECT properties
    FROM entities
    WHERE id = ${userId}
      AND type = 'user'
    LIMIT 1
  `;
  const role = rows[0]?.properties?.role ?? null;
  return role !== null && CFO_ROLES.has(role);
}

// ─────────────────────────────────────────────────────────────────────────────
// Route handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handles all /api/cfo/scheduled-reports routes.
 * Returns null for paths that do not match.
 */
export async function handleCfoScheduledReportsRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/cfo/scheduled-reports')) return null;

  const corsHeaders = getCorsHeaders(req);
  const { sql } = appState;
  const json = makeJson(corsHeaders);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // ── POST /api/cfo/scheduled-reports ─────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/cfo/scheduled-reports') {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const authorised = await isCfoAuthorised(user.id, sql);
    if (!authorised) return json({ error: 'Forbidden' }, 403);

    let body: CreateReportBody;
    try {
      body = (await req.json()) as CreateReportBody;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const { frequency, format, recipient_email } = body;

    if (!frequency || !VALID_FREQUENCIES.has(frequency)) {
      return json({ error: 'frequency must be "weekly" or "monthly"' }, 400);
    }
    if (!format || !VALID_FORMATS.has(format)) {
      return json({ error: 'format must be "pdf" or "csv"' }, 400);
    }
    if (!recipient_email || typeof recipient_email !== 'string' || !recipient_email.includes('@')) {
      return json({ error: 'recipient_email must be a valid email address' }, 400);
    }

    const [row] = await sql<ScheduledReport[]>`
      INSERT INTO rl_cfo_scheduled_reports
        (user_id, frequency, format, recipient_email)
      VALUES
        (${user.id}, ${frequency}, ${format}, ${recipient_email})
      RETURNING
        id, user_id, frequency, format, recipient_email,
        created_at::text, updated_at::text
    `;

    return json({ report: row }, 201);
  }

  // ── GET /api/cfo/scheduled-reports ──────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/cfo/scheduled-reports') {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const authorised = await isCfoAuthorised(user.id, sql);
    if (!authorised) return json({ error: 'Forbidden' }, 403);

    const reports = await sql<ScheduledReport[]>`
      SELECT
        id, user_id, frequency, format, recipient_email,
        created_at::text, updated_at::text
      FROM rl_cfo_scheduled_reports
      WHERE user_id = ${user.id}
      ORDER BY created_at DESC
    `;

    return json({ reports }, 200);
  }

  // ── DELETE /api/cfo/scheduled-reports/:id ───────────────────────────────
  const deleteMatch = url.pathname.match(/^\/api\/cfo\/scheduled-reports\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteMatch) {
    const reportId = deleteMatch[1];

    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const authorised = await isCfoAuthorised(user.id, sql);
    if (!authorised) return json({ error: 'Forbidden' }, 403);

    const result = await sql`
      DELETE FROM rl_cfo_scheduled_reports
      WHERE id = ${reportId}
        AND user_id = ${user.id}
    `;

    if (result.count === 0) {
      return json({ error: 'Not Found' }, 404);
    }

    return new Response(null, { status: 204, headers: corsHeaders });
  }

  return null;
}
