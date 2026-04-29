/**
 * @file apps/server/tests/integration/customers.test.ts
 *
 * Integration tests for customer conversion on deal close (issue #53).
 *
 * No mocks — real Postgres container + real Bun server + real HTTP.
 *
 * ## Test plan coverage
 *
 *   TP-1  Unit: deal stage transition to closed_won creates a Customer row.
 *   TP-2  Unit: second closed_won transition for the same deal returns the
 *         existing customer without inserting a duplicate.
 *   TP-3  Integration: advance a deal to closed_won, verify Customer row created
 *         with correct prospect_id.
 *   TP-4  Integration: assign an account manager to a customer, verify
 *         account_manager_id updated in DB.
 *   TP-5  E2E: Sales Rep closes a deal, verify customer appears in
 *         GET /api/customers response.
 *   TP-6  GET /api/customers/:id returns correct fields with null health_score
 *         and null account_manager_id for a freshly converted customer.
 *   TP-7  GET /api/customers with segment filter returns only matching customers.
 *
 * @see https://github.com/superfield-ai/demo-phoenix/issues/53
 */

import { afterAll, beforeAll, describe, test, expect } from 'vitest';
import type { Subprocess } from 'bun';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { createTestSession } from '../helpers/test-session';

const PORT = 31482;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 60_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let server: Subprocess;
let sql: ReturnType<typeof postgres>;

let repCookie = '';
let repUserId = '';

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 5 });

  server = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      AUDIT_DATABASE_URL: pg.url,
      ANALYTICS_DATABASE_URL: pg.url,
      PORT: String(PORT),
      TEST_MODE: 'true',
      SUPERUSER_ID: '__placeholder__',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  await waitForServer(BASE);

  const session = await createTestSession(BASE, {
    username: `rep-customers-${Date.now()}`,
    role: 'sales_rep',
  });
  repCookie = session.cookie;
  repUserId = session.userId;
}, 60_000);

afterAll(async () => {
  server?.kill();
  await sql?.end({ timeout: 5 });
  await pg?.stop();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — direct DB inserts to set up test fixtures
// ─────────────────────────────────────────────────────────────────────────────

async function insertProspect(
  overrides: {
    stage?: string;
    assigned_rep_id?: string;
    company_name?: string;
    company_segment?: string | null;
  } = {},
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO rl_prospects (company_name, stage, assigned_rep_id, company_segment)
    VALUES (
      ${overrides.company_name ?? `Customer Co ${crypto.randomUUID().slice(0, 8)}`},
      ${overrides.stage ?? 'qualified'},
      ${overrides.assigned_rep_id ?? null},
      ${overrides.company_segment ?? null}
    )
    RETURNING id
  `;
  return row.id;
}

async function patchStage(
  prospectId: string,
  stage: string,
  note = 'Advancing deal stage for test.',
): Promise<Response> {
  return fetch(`${BASE}/api/leads/${prospectId}/stage`, {
    method: 'PATCH',
    headers: { Cookie: repCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage, note }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// TP-1 / TP-3: Advancing to closed_won creates a Customer row
// ─────────────────────────────────────────────────────────────────────────────

describe('TP-1/TP-3: PATCH /api/leads/:id/stage to closed_won creates Customer', () => {
  test('transitioning to closed_won creates a Customer row in rl_customers', async () => {
    const prospectId = await insertProspect({
      assigned_rep_id: repUserId,
      company_name: 'Acme Corp',
      company_segment: 'Enterprise',
    });

    const res = await patchStage(prospectId, 'closed_won');
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      deal_id: string;
      activity_id: string;
      customer_id?: string;
    };
    expect(body.deal_id).toBeTruthy();
    expect(body.activity_id).toBeTruthy();
    expect(body.customer_id).toBeTruthy();

    // Verify Customer row in DB.
    const [customer] = await sql<
      {
        id: string;
        prospect_id: string;
        company_name: string;
        segment: string | null;
        health_score: number | null;
        account_manager_id: string | null;
      }[]
    >`
      SELECT id, prospect_id, company_name, segment, health_score, account_manager_id
      FROM rl_customers
      WHERE id = ${body.customer_id!}
    `;

    expect(customer).toBeDefined();
    expect(customer.prospect_id).toBe(prospectId);
    expect(customer.company_name).toBe('Acme Corp');
    expect(customer.segment).toBe('Enterprise');
    expect(customer.health_score).toBeNull();
    expect(customer.account_manager_id).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TP-2: Idempotency — second closed_won returns existing customer
// ─────────────────────────────────────────────────────────────────────────────

describe('TP-2: Idempotency — re-closing closed_won does not duplicate Customer', () => {
  test('second closed_won transition returns existing customer_id without inserting', async () => {
    const prospectId = await insertProspect({ assigned_rep_id: repUserId });

    // First transition.
    const res1 = await patchStage(prospectId, 'closed_won');
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { customer_id?: string };
    const firstCustomerId = body1.customer_id;
    expect(firstCustomerId).toBeTruthy();

    // Second transition — move away then back.
    await patchStage(prospectId, 'closed_lost', 'Reopening deal for retry.');
    const res2 = await patchStage(prospectId, 'closed_won', 'Re-winning the deal.');
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { customer_id?: string };
    expect(body2.customer_id).toBe(firstCustomerId);

    // Verify only one rl_customers row for this prospect.
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM rl_customers WHERE prospect_id = ${prospectId}
    `;
    expect(rows.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TP-6: GET /api/customers/:id returns correct fields
// ─────────────────────────────────────────────────────────────────────────────

describe('TP-6: GET /api/customers/:id returns customer detail with invoice summary', () => {
  test('returns company_name, segment, health_score=null, account_manager_id=null', async () => {
    const prospectId = await insertProspect({
      assigned_rep_id: repUserId,
      company_name: 'Detail Test Ltd',
      company_segment: 'SMB',
    });

    const patchRes = await patchStage(prospectId, 'closed_won');
    const { customer_id } = (await patchRes.json()) as { customer_id: string };

    const res = await fetch(`${BASE}/api/customers/${customer_id}`, {
      headers: { Cookie: repCookie },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      id: string;
      company_name: string;
      segment: string | null;
      health_score: number | null;
      account_manager_id: string | null;
      invoice_count: number;
      invoice_total: number | null;
    };

    expect(body.id).toBe(customer_id);
    expect(body.company_name).toBe('Detail Test Ltd');
    expect(body.segment).toBe('SMB');
    expect(body.health_score).toBeNull();
    expect(body.account_manager_id).toBeNull();
    expect(typeof body.invoice_count).toBe('number');
    expect(body.invoice_count).toBe(0);
    expect(body.invoice_total).toBeNull();
  });

  test('GET /api/customers/:id returns 404 for unknown id', async () => {
    const res = await fetch(`${BASE}/api/customers/nonexistent-id`, {
      headers: { Cookie: repCookie },
    });
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TP-4: PATCH /api/customers/:id assigns account_manager_id
// ─────────────────────────────────────────────────────────────────────────────

describe('TP-4: PATCH /api/customers/:id updates account_manager_id', () => {
  test('assign account_manager_id and verify it is persisted in DB', async () => {
    const prospectId = await insertProspect({ assigned_rep_id: repUserId });

    const patchRes = await patchStage(prospectId, 'closed_won');
    const { customer_id } = (await patchRes.json()) as { customer_id: string };

    const managerId = `mgr-${crypto.randomUUID().slice(0, 8)}`;

    const updateRes = await fetch(`${BASE}/api/customers/${customer_id}`, {
      method: 'PATCH',
      headers: { Cookie: repCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_manager_id: managerId }),
    });
    expect(updateRes.status).toBe(200);

    const updated = (await updateRes.json()) as { account_manager_id: string | null };
    expect(updated.account_manager_id).toBe(managerId);

    // Verify in DB.
    const [row] = await sql<{ account_manager_id: string | null }[]>`
      SELECT account_manager_id FROM rl_customers WHERE id = ${customer_id}
    `;
    expect(row.account_manager_id).toBe(managerId);
  });

  test('set account_manager_id to null (unassign)', async () => {
    const prospectId = await insertProspect({ assigned_rep_id: repUserId });

    const patchRes = await patchStage(prospectId, 'closed_won');
    const { customer_id } = (await patchRes.json()) as { customer_id: string };

    // Assign first.
    await fetch(`${BASE}/api/customers/${customer_id}`, {
      method: 'PATCH',
      headers: { Cookie: repCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_manager_id: 'some-manager' }),
    });

    // Then unassign.
    const unassignRes = await fetch(`${BASE}/api/customers/${customer_id}`, {
      method: 'PATCH',
      headers: { Cookie: repCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_manager_id: null }),
    });
    expect(unassignRes.status).toBe(200);
    const body = (await unassignRes.json()) as { account_manager_id: string | null };
    expect(body.account_manager_id).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TP-5: E2E — Sales Rep closes deal, customer appears in GET /api/customers
// ─────────────────────────────────────────────────────────────────────────────

describe('TP-5: E2E — closed deal customer appears in GET /api/customers', () => {
  test('customer created on deal close appears in customer list', async () => {
    const uniqueName = `E2E Corp ${crypto.randomUUID().slice(0, 8)}`;
    const prospectId = await insertProspect({
      assigned_rep_id: repUserId,
      company_name: uniqueName,
    });

    const patchRes = await patchStage(prospectId, 'closed_won');
    const { customer_id } = (await patchRes.json()) as { customer_id: string };

    const listRes = await fetch(`${BASE}/api/customers`, {
      headers: { Cookie: repCookie },
    });
    expect(listRes.status).toBe(200);

    const { customers } = (await listRes.json()) as {
      customers: { id: string; company_name: string }[];
    };

    const found = customers.find((c) => c.id === customer_id);
    expect(found).toBeDefined();
    expect(found!.company_name).toBe(uniqueName);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TP-7: GET /api/customers with segment filter
// ─────────────────────────────────────────────────────────────────────────────

describe('TP-7: GET /api/customers with segment filter', () => {
  test('segment filter returns only matching customers', async () => {
    // Create two prospects — one Enterprise, one SMB.
    const enterpriseId = await insertProspect({
      assigned_rep_id: repUserId,
      company_segment: 'Enterprise',
      company_name: `Filter Enterprise ${crypto.randomUUID().slice(0, 8)}`,
    });
    const smbId = await insertProspect({
      assigned_rep_id: repUserId,
      company_segment: 'SMB',
      company_name: `Filter SMB ${crypto.randomUUID().slice(0, 8)}`,
    });

    await patchStage(enterpriseId, 'closed_won');
    await patchStage(smbId, 'closed_won');

    const res = await fetch(`${BASE}/api/customers?segment=Enterprise`, {
      headers: { Cookie: repCookie },
    });
    expect(res.status).toBe(200);

    const { customers } = (await res.json()) as {
      customers: { id: string; segment: string | null }[];
    };

    // All returned customers must have segment=Enterprise.
    for (const c of customers) {
      expect(c.segment).toBe('Enterprise');
    }

    // At minimum our enterprise prospect must be there.
    const enterpriseCustomers = await sql<{ id: string }[]>`
      SELECT id FROM rl_customers WHERE prospect_id = ${enterpriseId}
    `;
    expect(enterpriseCustomers.length).toBe(1);
    const found = customers.find((c) => c.id === enterpriseCustomers[0].id);
    expect(found).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth guard
// ─────────────────────────────────────────────────────────────────────────────

describe('Auth: unauthenticated requests return 401', () => {
  test('GET /api/customers without cookie returns 401', async () => {
    const res = await fetch(`${BASE}/api/customers`);
    expect(res.status).toBe(401);
  });

  test('GET /api/customers/:id without cookie returns 401', async () => {
    const res = await fetch(`${BASE}/api/customers/some-id`);
    expect(res.status).toBe(401);
  });

  test('PATCH /api/customers/:id without cookie returns 401', async () => {
    const res = await fetch(`${BASE}/api/customers/some-id`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_manager_id: 'x' }),
    });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

async function waitForServer(base: string): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/health/live`);
      return;
    } catch {
      await Bun.sleep(300);
    }
  }
  throw new Error(`Server at ${base} did not become ready within ${SERVER_READY_TIMEOUT_MS}ms`);
}
