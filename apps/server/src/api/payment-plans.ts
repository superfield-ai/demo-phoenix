/**
 * @file api/payment-plans
 *
 * Payment-plan detail and status update API (issue #50).
 *
 * ## Endpoints
 *
 *   GET /api/payment-plans/:id
 *     Returns a payment-plan detail payload including the derived installment
 *     schedule and linked case / invoice metadata.
 *
 *   PATCH /api/payment-plans/:id/status
 *     Updates a payment plan to breached or completed.
 *
 * Collections agents may only access plans on cases assigned to them. Finance
 * controllers and superusers may access all plans.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/50
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { isSuperuser, makeJson } from '../lib/response';
import {
  getPaymentPlanDetail,
  updatePaymentPlanStatus,
  type PaymentPlanStatus,
} from 'db/payment-plans';

const READ_ROLES = new Set(['collections_agent', 'finance_controller']);
const WRITE_ROLES = new Set(['collections_agent', 'finance_controller']);
const PATCHABLE_STATUSES = ['breached', 'completed'] as const;
type PatchablePaymentPlanStatus = (typeof PATCHABLE_STATUSES)[number];

async function resolveActorRole(sql: AppState['sql'], userId: string): Promise<string | null> {
  const rows = await sql<{ properties: { role?: string } }[]>`
    SELECT properties
    FROM entities
    WHERE id = ${userId} AND type = 'user'
    LIMIT 1
  `;
  return rows[0]?.properties?.role ?? null;
}

async function hasPlanAccess(
  planId: string,
  userId: string,
  callerRole: string | null,
  sql: AppState['sql'],
): Promise<boolean> {
  if (!callerRole || !READ_ROLES.has(callerRole)) return false;
  if (callerRole === 'finance_controller') return true;

  const plan = await getPaymentPlanDetail(planId, sql).catch(() => null);
  if (!plan) return false;
  return plan.collection_case.agent_id === userId;
}

export async function handlePaymentPlansRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/payment-plans')) return null;

  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);
  const { sql } = appState;

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const user = await getAuthenticatedUser(req);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  let callerRole: string | null;
  if (isSuperuser(user.id)) {
    callerRole = 'finance_controller';
  } else {
    callerRole = await resolveActorRole(sql, user.id);
  }

  const planMatch = url.pathname.match(/^\/api\/payment-plans\/([^/]+)$/);
  const statusMatch = url.pathname.match(/^\/api\/payment-plans\/([^/]+)\/status$/);

  if (req.method === 'GET' && planMatch) {
    const planId = planMatch[1];
    if (!(await hasPlanAccess(planId, user.id, callerRole, sql))) {
      return json({ error: 'Forbidden' }, 403);
    }

    const plan = await getPaymentPlanDetail(planId, sql).catch(() => null);
    if (!plan) {
      return json({ error: 'Payment plan not found' }, 404);
    }

    return json(plan, 200);
  }

  if (req.method === 'PATCH' && statusMatch) {
    const planId = statusMatch[1];
    if (!callerRole || !WRITE_ROLES.has(callerRole)) {
      return json({ error: 'Forbidden' }, 403);
    }
    if (!(await hasPlanAccess(planId, user.id, callerRole, sql))) {
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
    if (
      typeof b.status !== 'string' ||
      !PATCHABLE_STATUSES.includes(b.status as PatchablePaymentPlanStatus)
    ) {
      return json({ error: 'status must be breached or completed' }, 400);
    }

    try {
      const nextStatus = b.status as PatchablePaymentPlanStatus;
      const plan = await updatePaymentPlanStatus(planId, nextStatus, sql);
      if (!plan) return json({ error: 'Payment plan not found' }, 404);
      return json(plan, 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('cannot be marked completed')) {
        return json({ error: message }, 409);
      }
      console.error('[payment-plans] updatePaymentPlanStatus failed:', err);
      return json({ error: 'Internal Server Error' }, 500);
    }
  }

  return null;
}
