/**
 * @file invoice-payment.spec.ts
 *
 * End-to-end tests for the invoice creation and payment recording flow
 * (issue #47, TP-6).
 *
 * ## Test plan coverage
 *
 * TP-6  Finance Controller logs in, creates an invoice, records a payment,
 *       and verifies the status badge updates on the detail page.
 *
 * Strategy:
 *   1. Boot full stack in DEMO_MODE.
 *   2. Sign in as Finance Controller via demo quick-login.
 *   3. Navigate to the CFO Dashboard (nav-cfo-dashboard button).
 *   4. Use the API to pre-fetch a real customer_id from the seeded demo data.
 *   5. Fill in the create-invoice form with that customer_id and create a
 *      sent invoice (send=true checkbox).
 *   6. Locate the new invoice row in the list (status: Sent).
 *   7. Open the invoice detail and record a full payment.
 *   8. Verify the status badge updates to 'Paid'.
 *
 * Uses a real Playwright browser against a real Postgres + Bun server.
 * No mocks.
 *
 * Canonical docs: docs/prd.md §4.3
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/47
 */

import { chromium, type Browser, expect as playwrightExpect } from '@playwright/test';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { startPostgres, type PgContainer } from '../../packages/db/pg-container';
import postgres from 'postgres';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;
const SERVER_ENTRY_ABS = join(REPO_ROOT, 'apps/server/src/index.ts');
const AUDIT_SCHEMA_PATH = join(REPO_ROOT, 'packages/db/audit-schema.sql');
const BUN_BIN =
  process.env.BUN_BIN ?? (existsSync('/usr/local/bin/bun') ? '/usr/local/bin/bun' : 'bun');
// Use a distinct port to avoid conflicts with other e2e suites.
const SERVER_PORT = 31430;
const SERVER_READY_TIMEOUT_MS = 30_000;

type DemoEnv = {
  pg: PgContainer;
  server: Subprocess;
  sql: ReturnType<typeof postgres>;
  baseUrl: string;
};

async function applyAuditSchema(pgUrl: string): Promise<void> {
  const rawSql = readFileSync(AUDIT_SCHEMA_PATH, 'utf-8');
  const stripped = rawSql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  const statements = stripped
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const sql = postgres(pgUrl, { max: 1, idle_timeout: 5, connect_timeout: 10 });
  try {
    for (const stmt of statements) {
      await sql.unsafe(stmt);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  const base = `http://localhost:${SERVER_PORT}`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health/live`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await Bun.sleep(300);
  }
  throw new Error(`Server at ${base} did not become ready within ${SERVER_READY_TIMEOUT_MS}ms`);
}

async function startDemoServer(): Promise<DemoEnv> {
  // Build the web assets so the server can serve them.
  const build = Bun.spawnSync([BUN_BIN, 'run', '--filter', 'web', 'build'], {
    cwd: REPO_ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (build.exitCode !== 0) {
    throw new Error('Failed to build web assets for invoice-payment e2e test.');
  }

  const pg = await startPostgres();
  await applyAuditSchema(pg.url);

  const sql = postgres(pg.url, { max: 3 });

  const server = Bun.spawn([BUN_BIN, 'run', SERVER_ENTRY_ABS], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      AUDIT_DATABASE_URL: pg.url,
      PORT: String(SERVER_PORT),
      DEMO_MODE: 'true',
      CSRF_DISABLED: 'true',
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });

  await waitForServer();
  return { pg, server, sql, baseUrl: `http://localhost:${SERVER_PORT}` };
}

async function stopDemoServer(env: DemoEnv): Promise<void> {
  env.server.kill();
  await env.sql.end({ timeout: 5 });
  await env.pg.stop();
}

let browser: Browser;
let demoEnv: DemoEnv;

beforeAll(async () => {
  demoEnv = await startDemoServer();
  browser = await chromium.launch();
}, SERVER_READY_TIMEOUT_MS + 60_000);

afterAll(async () => {
  await browser.close();
  await stopDemoServer(demoEnv);
});

/**
 * Sign in as Finance Controller via demo quick-login.
 * Returns the authenticated Playwright page.
 */
async function signInAsFinanceController(): Promise<import('@playwright/test').Page> {
  const page = await browser.newPage();
  await page.goto(demoEnv.baseUrl, { waitUntil: 'networkidle' });

  const btn = page.getByRole('button', { name: 'Sign in as Finance Controller' });
  await playwrightExpect(btn).toBeVisible({ timeout: 10_000 });
  await btn.click();

  // Wait for login page to disappear (authenticated shell mounts).
  await page.waitForFunction(
    () => {
      const loginHeading = Array.from(document.querySelectorAll('h1')).find(
        (el) => el.textContent?.trim() === 'Superfield' && el.closest('.min-h-screen'),
      );
      return !loginHeading;
    },
    { timeout: 15_000 },
  );

  return page;
}

// ---------------------------------------------------------------------------
// TP-6: Finance Controller — create invoice → record payment → verify status
// ---------------------------------------------------------------------------

describe('invoice creation and payment recording — TP-6', () => {
  it(
    'Finance Controller creates a sent invoice, records a full payment, and sees Paid badge',
    async () => {
      // Fetch a real customer_id from the seeded demo data (direct DB query).
      const rows = await demoEnv.sql<{ id: string }[]>`
        SELECT id FROM rl_customers LIMIT 1
      `;
      if (rows.length === 0) {
        throw new Error('No customers found in DB — demo seed did not run.');
      }
      const customerId = rows[0].id;

      const page = await signInAsFinanceController();

      try {
        // Navigate to the CFO Dashboard (nav-cfo-dashboard button in the sidebar).
        const dashboardBtn = page.getByTestId('nav-cfo-dashboard');
        await playwrightExpect(dashboardBtn).toBeVisible({ timeout: 10_000 });
        await dashboardBtn.click();

        // The InvoicePanel should render.
        const invoicePanel = page.getByTestId('invoice-panel');
        await playwrightExpect(invoicePanel).toBeVisible({ timeout: 10_000 });

        // The create-invoice form should be visible for finance_controller.
        const createForm = page.getByTestId('invoice-create-form');
        await playwrightExpect(createForm).toBeVisible({ timeout: 5_000 });

        // Fill in customer_id (plain text input).
        const customerInput = createForm.locator('#inv-customer-id');
        await customerInput.fill(customerId);

        // Fill in amount.
        const amountInput = createForm.locator('#inv-amount');
        await amountInput.fill('250');

        // Tick "Send immediately" so the invoice is created with status='sent'.
        const sendCheckbox = createForm.locator('#inv-send');
        await sendCheckbox.check();

        // Submit the form.
        const submitBtn = page.getByTestId('invoice-submit-btn');
        await submitBtn.click();

        // Wait for a 'Sent' invoice row to appear in the list.
        const sentRow = page
          .locator('[data-testid^="invoice-row-"]')
          .filter({ hasText: /sent/i })
          .first();
        await playwrightExpect(sentRow).toBeVisible({ timeout: 10_000 });

        // Click the sent invoice row to open the detail view.
        await sentRow.click();

        // Invoice detail view should be visible and show 'Sent' status badge.
        const invoiceDetail = page.getByTestId('invoice-detail');
        await playwrightExpect(invoiceDetail).toBeVisible({ timeout: 5_000 });
        await playwrightExpect(invoiceDetail).toContainText('Sent', { timeout: 5_000 });

        // Record a full payment ($250 = invoice total → status should become 'Paid').
        const paymentForm = page.getByTestId('payment-record-form');
        await playwrightExpect(paymentForm).toBeVisible({ timeout: 5_000 });

        const payAmountInput = paymentForm.locator('#pay-amount');
        await payAmountInput.fill('250');

        const paySubmitBtn = page.getByTestId('payment-submit-btn');
        await paySubmitBtn.click();

        // After the full payment, the status badge on the detail page should
        // update to 'Paid'.
        await playwrightExpect(invoiceDetail).toContainText('Paid', { timeout: 10_000 });
      } finally {
        await page.close();
      }
    },
    SERVER_READY_TIMEOUT_MS + 120_000,
  );
});
