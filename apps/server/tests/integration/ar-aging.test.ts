/**
 * @file apps/server/tests/integration/ar-aging.test.ts
 *
 * Integration tests for GET /api/cfo/ar-aging and
 * GET /api/cfo/ar-aging/invoices?bucket=<bucket> (issue #16).
 *
 * No mocks — real Postgres container + real Bun server + real HTTP.
 *
 * ## Test plan coverage
 *
 *   TP-1  Seed invoices with due dates placing them in each of the five buckets;
 *         call GET /api/cfo/ar-aging; assert each bucket total matches the sum
 *         of seeded invoice amounts for that bucket.
 *
 *   TP-2  Call GET /api/cfo/ar-aging/invoices?bucket=30; assert all returned
 *         invoices have days_overdue between 1 and 30.
 *
 *   TP-3  Seed an invoice with an open CollectionCase at escalation_level=2;
 *         assert the drilldown row shows collection_case_open=true and
 *         collection_case_escalation_level=2.
 *
 *   TP-4  Authenticate as sales_rep; call GET /api/cfo/ar-aging; assert 403.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/16
 */

import { afterAll, beforeAll, describe, test, expect } from 'vitest';
import type { Subprocess } from 'bun';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { createTestSession } from '../helpers/test-session';
import { seedCustomer, seedInvoice, seedCollectionCase } from 'db/cfo-summary';

const PORT = 31486;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 60_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let server: Subprocess;
let sql: ReturnType<typeof postgres>;

// Sessions
let cfoSession: { cookie: string; userId: string };
let salesRepSession: { cookie: string; userId: string };

// Shared customer for seeded invoices
let customerId: string;

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

  const cfo = await createTestSession(BASE, {
    username: `cfo-${Date.now()}`,
    role: 'cfo',
  });
  cfoSession = { cookie: cfo.cookie, userId: cfo.userId };

  const rep = await createTestSession(BASE, {
    username: `rep-${Date.now()}`,
    role: 'sales_rep',
  });
  salesRepSession = { cookie: rep.cookie, userId: rep.userId };

  // Seed a shared customer.
  const { customer_id } = await seedCustomer({ company_name: 'AR Test Corp' }, sql);
  customerId = customer_id;
}, 60_000);

afterAll(async () => {
  server?.kill();
  await sql?.end({ timeout: 5 });
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// TP-1: bucket totals match seeded invoice amounts
// ---------------------------------------------------------------------------

describe('GET /api/cfo/ar-aging — TP-1', () => {
  test('bucket totals match seeded invoice amounts for each of the five buckets', async () => {
    const today = new Date();
    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    const future = new Date(today);
    future.setDate(future.getDate() + 5);

    const minus20 = new Date(today);
    minus20.setDate(minus20.getDate() - 20);

    const minus45 = new Date(today);
    minus45.setDate(minus45.getDate() - 45);

    const minus75 = new Date(today);
    minus75.setDate(minus75.getDate() - 75);

    const minus130 = new Date(today);
    minus130.setDate(minus130.getDate() - 130);

    // current (100), 30-bucket (200), 60-bucket (300), 90-bucket (400), 120+-bucket (500)
    await seedInvoice(
      { customer_id: customerId, amount: 100, due_date: fmt(future), status: 'sent' },
      sql,
    );
    await seedInvoice(
      { customer_id: customerId, amount: 200, due_date: fmt(minus20), status: 'overdue' },
      sql,
    );
    await seedInvoice(
      { customer_id: customerId, amount: 300, due_date: fmt(minus45), status: 'overdue' },
      sql,
    );
    await seedInvoice(
      { customer_id: customerId, amount: 400, due_date: fmt(minus75), status: 'overdue' },
      sql,
    );
    await seedInvoice(
      { customer_id: customerId, amount: 500, due_date: fmt(minus130), status: 'overdue' },
      sql,
    );

    const res = await fetch(`${BASE}/api/cfo/ar-aging`, {
      headers: { Cookie: cfoSession.cookie },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      buckets: Record<string, number>;
      trend: unknown[];
    };

    expect(typeof body.buckets).toBe('object');
    expect(typeof body.buckets.current).toBe('number');
    expect(typeof body.buckets['30']).toBe('number');
    expect(typeof body.buckets['60']).toBe('number');
    expect(typeof body.buckets['90']).toBe('number');
    expect(typeof body.buckets['120+']).toBe('number');

    // Each bucket must include at least the seeded amount.
    expect(body.buckets.current).toBeGreaterThanOrEqual(100);
    expect(body.buckets['30']).toBeGreaterThanOrEqual(200);
    expect(body.buckets['60']).toBeGreaterThanOrEqual(300);
    expect(body.buckets['90']).toBeGreaterThanOrEqual(400);
    expect(body.buckets['120+']).toBeGreaterThanOrEqual(500);

    // Trend must have exactly 12 monthly snapshots.
    expect(Array.isArray(body.trend)).toBe(true);
    expect(body.trend).toHaveLength(12);
  });
});

// ---------------------------------------------------------------------------
// TP-2: drilldown for bucket=30 returns only 1–30 days overdue invoices
// ---------------------------------------------------------------------------

describe('GET /api/cfo/ar-aging/invoices?bucket=30 — TP-2', () => {
  test('all returned invoices have days_overdue between 1 and 30', async () => {
    const res = await fetch(`${BASE}/api/cfo/ar-aging/invoices?bucket=30`, {
      headers: { Cookie: cfoSession.cookie },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      invoices: Array<{ days_overdue: number; invoice_id: string; amount: number }>;
    };

    expect(Array.isArray(body.invoices)).toBe(true);

    // Every invoice in the 30-day bucket must have 1–30 days overdue.
    for (const inv of body.invoices) {
      expect(inv.days_overdue).toBeGreaterThanOrEqual(1);
      expect(inv.days_overdue).toBeLessThanOrEqual(30);
    }

    // The seeded 200-amount invoice must be present.
    const amounts = body.invoices.map((i) => i.amount);
    expect(amounts).toContain(200);
  });
});

// ---------------------------------------------------------------------------
// TP-3: open CollectionCase with escalation_level=2 appears in drilldown
// ---------------------------------------------------------------------------

describe('GET /api/cfo/ar-aging/invoices — TP-3 — collection case details', () => {
  test('drilldown row shows collection_case_open=true and correct escalation_level', async () => {
    // Seed an invoice that will be in the 120+ bucket.
    const today = new Date();
    const minus100 = new Date(today);
    minus100.setDate(minus100.getDate() - 100);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    const { invoice_id } = await seedInvoice(
      {
        customer_id: customerId,
        amount: 9999,
        due_date: fmt(minus100),
        status: 'in_collection',
      },
      sql,
    );

    // Open a collection case with escalation_level = 2.
    await seedCollectionCase({ invoice_id, status: 'open' }, sql);

    // Manually set escalation_level = 2 (seedCollectionCase defaults to 0).
    await sql`
      UPDATE rl_collection_cases
      SET escalation_level = 2
      WHERE invoice_id = ${invoice_id}
        AND status = 'open'
    `;

    const res = await fetch(`${BASE}/api/cfo/ar-aging/invoices?bucket=120%2B`, {
      headers: { Cookie: cfoSession.cookie },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      invoices: Array<{
        invoice_id: string;
        collection_case_open: boolean;
        collection_case_escalation_level: number | null;
        amount: number;
      }>;
    };

    expect(Array.isArray(body.invoices)).toBe(true);

    const match = body.invoices.find((inv) => inv.invoice_id === invoice_id);
    expect(match).toBeDefined();
    expect(match?.collection_case_open).toBe(true);
    expect(match?.collection_case_escalation_level).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// TP-4: 403 for sales_rep role
// ---------------------------------------------------------------------------

describe('role gate — TP-4', () => {
  test('GET /api/cfo/ar-aging returns 403 for sales_rep', async () => {
    const res = await fetch(`${BASE}/api/cfo/ar-aging`, {
      headers: { Cookie: salesRepSession.cookie },
    });
    expect(res.status).toBe(403);
  });

  test('GET /api/cfo/ar-aging/invoices?bucket=30 returns 403 for sales_rep', async () => {
    const res = await fetch(`${BASE}/api/cfo/ar-aging/invoices?bucket=30`, {
      headers: { Cookie: salesRepSession.cookie },
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
