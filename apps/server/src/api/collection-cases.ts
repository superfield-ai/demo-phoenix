/**
 * @file api/collection-cases
 *
 * Collections Agent case queue and contact logging API (issue #49).
 *
 * ## Endpoints
 *
 *   GET /api/collection-cases
 *     List CollectionCases assigned to the logged-in agent.
 *     Optional query param: status — comma-separated list of statuses to filter by
 *       (default: open,escalated)
 *     Auth: collections_agent or superuser. Returns 403 for other roles.
 *
 *   GET /api/collection-cases/:id
 *     Full case detail: invoice, customer, payment history, contact log, dunning timeline.
 *     Auth: collections_agent or superuser. Returns 403 for other roles.
 *     The case must be assigned to the logged-in agent (unless superuser). Returns 403 otherwise.
 *
 *   POST /api/collection-cases/:id/contacts
 *     Log a contact attempt (type, outcome, notes).
 *     Body: { contact_type: 'call'|'email'|'portal', outcome: string, notes?: string }
 *     Auth: collections_agent or superuser. Returns 403 for other roles.
 *     The case must be assigned to the logged-in agent (unless superuser). Returns 403 otherwise.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/49
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { isSuperuser, makeJson } from '../lib/response';
import {
  listCollectionCases,
  getCollectionCaseDetail,
  createContactLog,
  type CollectionCaseStatus,
  type ContactType,
} from 'db/collection-cases';
import { createPaymentPlan } from 'db/payment-plans';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_STATUSES = new Set<CollectionCaseStatus>([
  'open',
  'resolved',
  'escalated',
  'written_off',
]);
const VALID_CONTACT_TYPES = new Set<ContactType>(['call', 'email', 'portal']);

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

export async function handleCollectionCasesRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/collection-cases')) return null;

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
    callerRole = 'collections_agent';
  } else {
    callerRole = await resolveActorRole(sql, user.id);
  }

  if (!callerRole || callerRole !== 'collections_agent') {
    return json({ error: 'Forbidden' }, 403);
  }

  // ── GET /api/collection-cases ─────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/collection-cases') {
    const statusParam = url.searchParams.get('status');

    let statuses: CollectionCaseStatus[] | undefined;
    if (statusParam) {
      const parts = statusParam.split(',').map((s) => s.trim());
      for (const s of parts) {
        if (!VALID_STATUSES.has(s as CollectionCaseStatus)) {
          return json(
            { error: `Invalid status '${s}'. Must be one of: ${[...VALID_STATUSES].join(', ')}` },
            400,
          );
        }
      }
      statuses = parts as CollectionCaseStatus[];
    }

    try {
      const cases = await listCollectionCases({ agent_id: user.id, status: statuses }, sql);
      return json({ cases }, 200);
    } catch (err) {
      console.error('[collection-cases] listCollectionCases failed:', err);
      return json({ error: 'Internal Server Error' }, 500);
    }
  }

  // Routes that require a case ID.
  const contactsMatch = url.pathname.match(/^\/api\/collection-cases\/([^/]+)\/contacts$/);
  const caseMatch = url.pathname.match(/^\/api\/collection-cases\/([^/]+)$/);

  // ── POST /api/collection-cases/:id/contacts ───────────────────────────
  const paymentPlansMatch = url.pathname.match(/^\/api\/collection-cases\/([^/]+)\/payment-plans$/);
  if (contactsMatch && req.method === 'POST') {
    const caseId = contactsMatch[1];

    // Verify the case exists and belongs to this agent.
    const detail = await getCollectionCaseDetail(caseId, sql).catch(() => null);
    if (!detail) {
      return json({ error: 'Collection case not found' }, 404);
    }
    if (!superuser && detail.agent_id !== user.id) {
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
      typeof b.contact_type !== 'string' ||
      !VALID_CONTACT_TYPES.has(b.contact_type as ContactType)
    ) {
      return json(
        {
          error: `contact_type is required and must be one of: ${[...VALID_CONTACT_TYPES].join(', ')}`,
        },
        400,
      );
    }
    if (typeof b.outcome !== 'string' || !b.outcome.trim()) {
      return json({ error: 'outcome is required and must be a non-empty string' }, 400);
    }
    if (b.notes !== undefined && b.notes !== null && typeof b.notes !== 'string') {
      return json({ error: 'notes must be a string or null' }, 400);
    }

    try {
      const contact = await createContactLog(
        {
          collection_case_id: caseId,
          agent_id: user.id,
          contact_type: b.contact_type as ContactType,
          outcome: b.outcome as string,
          notes: (b.notes as string | null | undefined) ?? null,
        },
        sql,
      );
      return json(contact, 201);
    } catch (err) {
      console.error('[collection-cases] createContactLog failed:', err);
      return json({ error: 'Internal Server Error' }, 500);
    }
  }

  // ── POST /api/collection-cases/:id/payment-plans ───────────────────────
  if (paymentPlansMatch && req.method === 'POST') {
    const caseId = paymentPlansMatch[1];

    const detail = await getCollectionCaseDetail(caseId, sql).catch(() => null);
    if (!detail) {
      return json({ error: 'Collection case not found' }, 404);
    }
    if (!superuser && detail.agent_id !== user.id) {
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
    if (typeof b.total_amount !== 'number' || b.total_amount <= 0) {
      return json({ error: 'total_amount is required and must be a positive number' }, 400);
    }
    if (
      typeof b.installment_count !== 'number' ||
      !Number.isInteger(b.installment_count) ||
      b.installment_count < 1
    ) {
      return json({ error: 'installment_count is required and must be an integer >= 1' }, 400);
    }
    if (typeof b.first_due_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.first_due_date)) {
      return json({ error: 'first_due_date is required and must be a YYYY-MM-DD string' }, 400);
    }

    try {
      const plan = await createPaymentPlan(
        {
          collection_case_id: caseId,
          total_amount: b.total_amount as number,
          installment_count: b.installment_count as number,
          first_due_date: b.first_due_date as string,
        },
        sql,
      );
      return json(plan, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.includes('active payment plan') ||
        message.includes('first_due_date cannot be in the past') ||
        message.includes('must be a positive number') ||
        message.includes('must be an integer')
      ) {
        return json({ error: message }, 409);
      }
      console.error('[collection-cases] createPaymentPlan failed:', err);
      return json({ error: 'Internal Server Error' }, 500);
    }
  }

  // ── GET /api/collection-cases/:id ────────────────────────────────────
  if (caseMatch && req.method === 'GET') {
    const caseId = caseMatch[1];

    try {
      const detail = await getCollectionCaseDetail(caseId, sql);
      if (!detail) {
        return json({ error: 'Collection case not found' }, 404);
      }
      if (!superuser && detail.agent_id !== user.id) {
        return json({ error: 'Forbidden' }, 403);
      }
      return json(detail, 200);
    } catch (err) {
      console.error('[collection-cases] getCollectionCaseDetail failed:', err);
      return json({ error: 'Internal Server Error' }, 500);
    }
  }

  return null;
}
