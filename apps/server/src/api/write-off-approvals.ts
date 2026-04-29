/**
 * @file api/write-off-approvals
 *
 * Finance Controller queue and decision API for settlement proposals that
 * exceed the write-off approval threshold (issue #51).
 *
 * GET /api/write-off-approvals
 *   List pending, approved, or rejected write-off approvals.
 *   Query: ?status=pending|approved|rejected|pending_approval, ?limit=, ?offset=
 *   Auth: finance_controller role or superuser.
 *
 * PATCH /api/write-off-approvals/:id
 *   Approve or reject a pending approval.
 *   Body: { decision: 'approved' | 'rejected', notes?: string }
 *   Auth: finance_controller role or superuser.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/51
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { isSuperuser, makeJson } from '../lib/response';
import { emitAuditEvent } from '../policies/audit-service';
import {
  decideWriteOffApproval,
  getWriteOffApprovalThreshold,
  listWriteOffApprovals,
  type WriteOffApprovalDecision,
  type WriteOffApprovalStatus,
} from 'db/write-off-approvals';

async function resolveActorRole(sql: AppState['sql'], userId: string): Promise<string | null> {
  const rows = await sql<{ properties: { role?: string } }[]>`
    SELECT properties
    FROM entities
    WHERE id = ${userId} AND type = 'user'
    LIMIT 1
  `;
  return rows[0]?.properties?.role ?? null;
}

function makeAuditWriter() {
  return async (event: {
    actor_id: string;
    action: string;
    entity_type: string;
    entity_id: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    ts: string;
  }) => {
    await emitAuditEvent(event);
  };
}

function normalizeStatus(status: string | null): WriteOffApprovalStatus | undefined {
  if (!status) return undefined;
  if (status === 'pending' || status === 'pending_approval') return 'pending_approval';
  if (status === 'approved' || status === 'rejected') return status;
  return undefined;
}

export async function handleWriteOffApprovalsRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/write-off-approvals')) return null;

  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);
  const { sql } = appState;

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const user = await getAuthenticatedUser(req);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const actorRole = isSuperuser(user.id)
    ? 'finance_controller'
    : await resolveActorRole(sql, user.id);
  if (!actorRole || actorRole !== 'finance_controller') {
    return json({ error: 'Forbidden' }, 403);
  }

  const auditWriter = makeAuditWriter();

  if (req.method === 'GET' && url.pathname === '/api/write-off-approvals') {
    const statusParam = normalizeStatus(url.searchParams.get('status'));
    const limitParam = url.searchParams.get('limit');
    const offsetParam = url.searchParams.get('offset');
    const limit = Math.min(Math.max(parseInt(limitParam ?? '50', 10) || 50, 1), 200);
    const offset = Math.max(parseInt(offsetParam ?? '0', 10) || 0, 0);

    const requests = await listWriteOffApprovals(sql, {
      status: statusParam,
      limit,
      offset,
    });

    return json({
      requests,
      limit,
      offset,
      threshold: getWriteOffApprovalThreshold(),
    });
  }

  const match = url.pathname.match(/^\/api\/write-off-approvals\/([^/]+)$/);
  if (!match || req.method !== 'PATCH') return null;

  let body: { decision?: unknown; notes?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (body.decision !== 'approved' && body.decision !== 'rejected') {
    return json({ error: "decision must be 'approved' or 'rejected'" }, 400);
  }
  if (body.notes !== undefined && body.notes !== null && typeof body.notes !== 'string') {
    return json({ error: 'notes must be a string or null' }, 400);
  }

  try {
    const result = await decideWriteOffApproval(sql, {
      approval_id: match[1],
      decision: body.decision as WriteOffApprovalDecision,
      reviewed_by: user.id,
      review_notes: (body.notes as string | null | undefined) ?? null,
      actor_id: user.id,
      auditWriter,
    });
    return json(result, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found')) {
      return json({ error: msg }, 404);
    }
    return json({ error: msg }, 422);
  }
}
