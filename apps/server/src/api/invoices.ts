/**
 * @file api/invoices
 *
 * Invoice creation and payment recording API (issue #47).
 *
 * ## Endpoints
 *
 *   POST /api/invoices
 *     Creates a new invoice for a customer.
 *     Body: { customer_id, amount, currency?, due_date?, send? }
 *     Auth: finance_controller or superuser only. Returns 403 for other roles.
 *
 *   GET /api/invoices
 *     Lists invoices. Supports optional query params:
 *       - customer_id — filter by customer
 *       - status      — filter by invoice status
 *     Auth: finance_controller, cfo, or superuser. Returns 403 for other roles.
 *
 *   GET /api/invoices/:id
 *     Returns a single invoice by ID.
 *     Auth: finance_controller, cfo, or superuser. Returns 403 for other roles.
 *
 *   GET /api/invoices/:id/payments
 *     Returns all payments for an invoice.
 *     Auth: finance_controller, cfo, or superuser. Returns 403 for other roles.
 *
 *   POST /api/invoices/:id/payments
 *     Records a payment against an invoice.
 *     Body: { amount, method?, received_at? }
 *     Auth: finance_controller or superuser only. Returns 403 for other roles.
 *
 * Canonical docs: docs/prd.md §4.3
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/47
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { isSuperuser, makeJson } from '../lib/response';
import {
  createInvoice,
  getInvoice,
  listInvoices,
  recordPayment,
  listInvoicePayments,
  type InvoiceStatus,
} from 'db/invoices';

// ---------------------------------------------------------------------------
// Role constants
// ---------------------------------------------------------------------------

/** Roles that can read invoice data. */
const READ_ROLES = new Set(['cfo', 'finance_controller']);
/** Roles that can mutate (create invoices, record payments). */
const WRITE_ROLES = new Set(['finance_controller']);

const VALID_STATUSES = new Set<string>([
  'draft',
  'sent',
  'partial_paid',
  'overdue',
  'in_collection',
  'paid',
  'settled',
  'written_off',
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

export async function handleInvoicesRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/invoices')) return null;

  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);
  const { sql } = appState;

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const user = await getAuthenticatedUser(req);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  // Resolve the caller role once (superusers get finance_controller access).
  let callerRole: string | null;
  if (isSuperuser(user.id)) {
    callerRole = 'finance_controller';
  } else {
    callerRole = await resolveActorRole(sql, user.id);
  }

  // ── POST /api/invoices — create invoice ────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/invoices') {
    if (!callerRole || !WRITE_ROLES.has(callerRole)) {
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

    if (typeof b.customer_id !== 'string' || !b.customer_id) {
      return json({ error: 'customer_id is required and must be a string' }, 400);
    }
    if (typeof b.amount !== 'number' || b.amount <= 0) {
      return json({ error: 'amount is required and must be a positive number' }, 400);
    }
    if (b.currency !== undefined && typeof b.currency !== 'string') {
      return json({ error: 'currency must be a string' }, 400);
    }
    if (b.due_date !== undefined && b.due_date !== null && typeof b.due_date !== 'string') {
      return json({ error: 'due_date must be a string (YYYY-MM-DD) or null' }, 400);
    }
    if (b.send !== undefined && typeof b.send !== 'boolean') {
      return json({ error: 'send must be a boolean' }, 400);
    }

    try {
      const invoice = await createInvoice(
        {
          customer_id: b.customer_id as string,
          amount: b.amount as number,
          currency: b.currency as string | undefined,
          due_date: (b.due_date as string | null | undefined) ?? null,
          send: (b.send as boolean | undefined) ?? false,
        },
        sql,
      );
      return json(invoice, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Foreign key violation — customer not found.
      if (msg.includes('foreign key') || msg.includes('fk_') || msg.includes('customer_id')) {
        return json({ error: 'Customer not found' }, 422);
      }
      console.error('[invoices] createInvoice failed:', err);
      return json({ error: 'Internal Server Error' }, 500);
    }
  }

  // ── GET /api/invoices — list invoices ──────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/invoices') {
    if (!callerRole || !READ_ROLES.has(callerRole)) {
      return json({ error: 'Forbidden' }, 403);
    }

    const customerId = url.searchParams.get('customer_id') ?? undefined;
    const statusParam = url.searchParams.get('status') ?? undefined;

    if (statusParam !== undefined && !VALID_STATUSES.has(statusParam)) {
      return json(
        { error: `Invalid status. Must be one of: ${[...VALID_STATUSES].join(', ')}` },
        400,
      );
    }

    try {
      const invoices = await listInvoices(
        {
          customer_id: customerId,
          status: statusParam as InvoiceStatus | undefined,
        },
        sql,
      );
      return json({ invoices }, 200);
    } catch (err) {
      console.error('[invoices] listInvoices failed:', err);
      return json({ error: 'Internal Server Error' }, 500);
    }
  }

  // ── Routes that require a valid invoice ID ─────────────────────────────
  // Match /api/invoices/:id and /api/invoices/:id/payments
  const paymentsMatch = url.pathname.match(/^\/api\/invoices\/([^/]+)\/payments$/);
  const invoiceMatch = url.pathname.match(/^\/api\/invoices\/([^/]+)$/);

  // ── POST /api/invoices/:id/payments — record payment ──────────────────
  if (paymentsMatch && req.method === 'POST') {
    if (!callerRole || !WRITE_ROLES.has(callerRole)) {
      return json({ error: 'Forbidden' }, 403);
    }

    const invoiceId = paymentsMatch[1];

    // Verify the invoice exists.
    const invoice = await getInvoice(invoiceId, sql).catch(() => null);
    if (!invoice) {
      return json({ error: 'Invoice not found' }, 404);
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

    if (typeof b.amount !== 'number' || b.amount <= 0) {
      return json({ error: 'amount is required and must be a positive number' }, 400);
    }
    if (b.method !== undefined && b.method !== null && typeof b.method !== 'string') {
      return json({ error: 'method must be a string or null' }, 400);
    }
    if (b.received_at !== undefined && typeof b.received_at !== 'string') {
      return json({ error: 'received_at must be an ISO timestamp string' }, 400);
    }

    try {
      const payment = await recordPayment(
        {
          invoice_id: invoiceId,
          amount: b.amount as number,
          method: (b.method as string | null | undefined) ?? null,
          received_at: (b.received_at as string | undefined) ?? undefined,
          recorded_by: user.id,
        },
        sql,
      );
      return json(payment, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) {
        return json({ error: 'Invoice not found' }, 404);
      }
      // Invoice is in a terminal status — payment cannot be recorded.
      if (msg.includes('transition') || msg.includes('status')) {
        return json({ error: 'Invoice status does not allow further payments' }, 422);
      }
      console.error('[invoices] recordPayment failed:', err);
      return json({ error: 'Internal Server Error' }, 500);
    }
  }

  // ── GET /api/invoices/:id/payments — list payments ────────────────────
  if (paymentsMatch && req.method === 'GET') {
    if (!callerRole || !READ_ROLES.has(callerRole)) {
      return json({ error: 'Forbidden' }, 403);
    }

    const invoiceId = paymentsMatch[1];
    const invoice = await getInvoice(invoiceId, sql).catch(() => null);
    if (!invoice) {
      return json({ error: 'Invoice not found' }, 404);
    }

    try {
      const payments = await listInvoicePayments(invoiceId, sql);
      return json({ payments }, 200);
    } catch (err) {
      console.error('[invoices] listInvoicePayments failed:', err);
      return json({ error: 'Internal Server Error' }, 500);
    }
  }

  // ── GET /api/invoices/:id — single invoice ────────────────────────────
  if (invoiceMatch && req.method === 'GET') {
    if (!callerRole || !READ_ROLES.has(callerRole)) {
      return json({ error: 'Forbidden' }, 403);
    }

    const invoiceId = invoiceMatch[1];

    try {
      const invoice = await getInvoice(invoiceId, sql);
      if (!invoice) {
        return json({ error: 'Invoice not found' }, 404);
      }
      return json(invoice, 200);
    } catch (err) {
      console.error('[invoices] getInvoice failed:', err);
      return json({ error: 'Internal Server Error' }, 500);
    }
  }

  return null;
}
