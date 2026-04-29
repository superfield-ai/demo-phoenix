/**
 * @file api/interventions
 *
 * Account Manager intervention workflow API (issue #56).
 *
 * ## Endpoints
 *
 *   POST /api/interventions
 *     Create an intervention for a customer.
 *     Body: { customer_id, playbook, assigned_to, notes? }
 *     Auth: account_manager or superuser.
 *     The caller must be the assigned account manager for the customer,
 *     or a superuser. Returns 403 otherwise.
 *     Response includes collections_active:true when the customer has an open
 *     CollectionCase (collections owns primary contact).
 *
 *   PATCH /api/interventions/:id
 *     Update an intervention's status and/or outcome.
 *     Body: { status?, outcome? }
 *     Auth: account_manager or superuser.
 *     Returns 403 if the caller is not the assigned AM or a superuser.
 *     Sets resolved_at when status transitions to 'resolved'.
 *
 *   GET /api/interventions?customer_id=:id
 *     List all interventions for a customer in chronological order.
 *     Auth: account_manager or superuser.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/56
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { isSuperuser, makeJson } from '../lib/response';
import {
  createIntervention,
  updateIntervention,
  getIntervention,
  listInterventionsForCustomer,
  getAssignedAccountManager,
  type InterventionStatus,
  type InterventionPlaybook,
} from 'db/interventions';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_STATUSES = new Set<InterventionStatus>([
  'open',
  'in_progress',
  'resolved',
  'escalated',
]);
const VALID_PLAYBOOKS = new Set<InterventionPlaybook>([
  'success_call',
  'training',
  'executive_sponsor',
]);

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

export async function handleInterventionsRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/interventions')) return null;

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

  // ── POST /api/interventions ───────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/interventions') {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    if (typeof body !== 'object' || body === null) {
      return json({ error: 'Request body must be a JSON object' }, 400);
    }

    const b = body as Record<string, unknown>;

    if (typeof b.customer_id !== 'string' || !b.customer_id.trim()) {
      return json({ error: 'customer_id is required and must be a non-empty string' }, 400);
    }
    if (
      typeof b.playbook !== 'string' ||
      !VALID_PLAYBOOKS.has(b.playbook as InterventionPlaybook)
    ) {
      return json(
        {
          error: `playbook is required and must be one of: ${[...VALID_PLAYBOOKS].join(', ')}`,
        },
        400,
      );
    }
    if (typeof b.assigned_to !== 'string' || !b.assigned_to.trim()) {
      return json({ error: 'assigned_to is required and must be a non-empty string' }, 400);
    }
    if (b.notes !== undefined && b.notes !== null && typeof b.notes !== 'string') {
      return json({ error: 'notes must be a string or null' }, 400);
    }

    // Authorization: the caller must be the assigned account manager for the
    // customer, or a superuser.
    if (!superuser) {
      const assignedAm = await getAssignedAccountManager(b.customer_id as string, sql);
      if (assignedAm !== user.id) {
        return json({ error: 'Forbidden' }, 403);
      }
    }

    try {
      const intervention = await createIntervention(
        {
          customer_id: b.customer_id as string,
          playbook: b.playbook as InterventionPlaybook,
          assigned_to: b.assigned_to as string,
          notes: (b.notes as string | null | undefined) ?? null,
        },
        sql,
      );
      return json(intervention, 201);
    } catch (err) {
      console.error('[interventions] createIntervention failed:', err);
      return json({ error: 'Internal Server Error' }, 500);
    }
  }

  // ── PATCH /api/interventions/:id ─────────────────────────────────────────
  const patchMatch = url.pathname.match(/^\/api\/interventions\/([^/]+)$/);
  if (patchMatch && req.method === 'PATCH') {
    const interventionId = patchMatch[1];

    // Fetch existing row to check ownership.
    const existing = await getIntervention(interventionId, sql).catch(() => null);
    if (!existing) {
      return json({ error: 'Intervention not found' }, 404);
    }

    // Authorization: caller must be the assigned_to AM or superuser.
    if (!superuser && existing.assigned_to !== user.id) {
      return json({ error: 'Forbidden' }, 403);
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    if (typeof body !== 'object' || body === null) {
      return json({ error: 'Request body must be a JSON object' }, 400);
    }

    const b = body as Record<string, unknown>;

    if (b.status !== undefined && !VALID_STATUSES.has(b.status as InterventionStatus)) {
      return json(
        {
          error: `status must be one of: ${[...VALID_STATUSES].join(', ')}`,
        },
        400,
      );
    }
    if (b.outcome !== undefined && b.outcome !== null && typeof b.outcome !== 'string') {
      return json({ error: 'outcome must be a string or null' }, 400);
    }

    try {
      const updated = await updateIntervention(
        interventionId,
        {
          status: b.status as InterventionStatus | undefined,
          outcome: b.outcome as string | null | undefined,
        },
        sql,
      );
      if (!updated) return json({ error: 'Intervention not found' }, 404);
      return json(updated, 200);
    } catch (err) {
      console.error('[interventions] updateIntervention failed:', err);
      return json({ error: 'Internal Server Error' }, 500);
    }
  }

  // ── GET /api/interventions?customer_id=:id ───────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/interventions') {
    const customerId = url.searchParams.get('customer_id');
    if (!customerId) {
      return json({ error: 'customer_id query parameter is required' }, 400);
    }

    try {
      const interventions = await listInterventionsForCustomer(customerId, sql);
      return json({ interventions }, 200);
    } catch (err) {
      console.error('[interventions] listInterventionsForCustomer failed:', err);
      return json({ error: 'Internal Server Error' }, 500);
    }
  }

  return null;
}
