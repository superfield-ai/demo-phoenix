/**
 * @file dunning-timeline.spec.ts
 *
 * End-to-end test for the Finance Controller dunning timeline panel (issue #48).
 *
 * ## Test plan coverage
 *
 * E2E: Finance Controller views an invoice detail page and sees the dunning
 * timeline panel. When at least one DunningAction exists for the invoice, it is
 * shown in chronological order with action_type, scheduled_at, and sent_at.
 *
 * Strategy:
 *   1. Boot full stack in DEMO_MODE.
 *   2. Sign in as Finance Controller via demo quick-login.
 *   3. Seed an overdue invoice via direct DB insert + create a dunning action
 *      via direct DB insert (to avoid running the cron job).
 *   4. Navigate to the CFO Dashboard.
 *   5. Click the invoice row to open the detail view.
 *   6. Verify the dunning timeline panel renders with the seeded action entry.
 *
 * Uses a real Playwright browser against a real Postgres + Bun server.
 * No mocks.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/48
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
const SERVER_PORT = 31431;
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
  const build = Bun.spawnSync([BUN_BIN, 'run', '--filter', 'web', 'build'], {
    cwd: REPO_ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (build.exitCode !== 0) {
    throw new Error('Failed to build web assets for dunning-timeline e2e test.');
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

async function signInAsFinanceController(): Promise<import('@playwright/test').Page> {
  const page = await browser.newPage();
  await page.goto(demoEnv.baseUrl, { waitUntil: 'networkidle' });

  const btn = page.getByRole('button', { name: 'Sign in as Finance Controller' });
  await playwrightExpect(btn).toBeVisible({ timeout: 10_000 });
  await btn.click();

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
// E2E: Finance Controller views dunning timeline panel
// ---------------------------------------------------------------------------

describe('dunning timeline panel — E2E', () => {
  it(
    'Finance Controller sees dunning timeline panel on invoice detail with at least one entry',
    async () => {
      const { sql } = demoEnv;

      // Fetch a real customer_id from seeded demo data.
      const customerRows = await sql<{ id: string }[]>`SELECT id FROM rl_customers LIMIT 1`;
      if (customerRows.length === 0) {
        throw new Error('No customers found in DB — demo seed did not run.');
      }
      const customerId = customerRows[0].id;

      // Seed an overdue invoice (due 5 days ago, status = overdue).
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() - 5);
      const dueDateStr = dueDate.toISOString().slice(0, 10);

      const [invRow] = await sql<{ id: string }[]>`
        INSERT INTO rl_invoices (customer_id, amount, currency, due_date, status, issued_at)
        VALUES (${customerId}, 500, 'USD', ${dueDateStr}, 'overdue', NOW())
        RETURNING id
      `;
      const invoiceId = invRow.id;

      // Seed a dunning action for this invoice.
      await sql`
        INSERT INTO rl_dunning_actions (invoice_id, action_type, scheduled_at, sent_at)
        VALUES (
          ${invoiceId},
          'reminder_d1',
          NOW() - INTERVAL '4 days',
          NOW() - INTERVAL '4 days'
        )
      `;

      const page = await signInAsFinanceController();

      try {
        // Navigate to the CFO Dashboard.
        const dashboardBtn = page.getByTestId('nav-cfo-dashboard');
        await playwrightExpect(dashboardBtn).toBeVisible({ timeout: 10_000 });
        await dashboardBtn.click();

        // Wait for the invoice panel to render.
        const invoicePanel = page.getByTestId('invoice-panel');
        await playwrightExpect(invoicePanel).toBeVisible({ timeout: 10_000 });

        // Find the overdue invoice row (status badge: Overdue).
        const invoiceRow = page.getByTestId(`invoice-row-${invoiceId}`);
        await playwrightExpect(invoiceRow).toBeVisible({ timeout: 10_000 });
        await invoiceRow.click();

        // The invoice detail view should render.
        const invoiceDetail = page.getByTestId('invoice-detail');
        await playwrightExpect(invoiceDetail).toBeVisible({ timeout: 5_000 });

        // The dunning timeline panel should render.
        const dunningTimeline = page.getByTestId('dunning-timeline');
        await playwrightExpect(dunningTimeline).toBeVisible({ timeout: 5_000 });

        // At least one dunning action entry should be shown.
        const actionList = page.getByTestId('dunning-action-list');
        await playwrightExpect(actionList).toBeVisible({ timeout: 5_000 });

        // The reminder_d1 label should be shown.
        await playwrightExpect(dunningTimeline).toContainText('D+1 Friendly Reminder', {
          timeout: 5_000,
        });
      } finally {
        await page.close();
      }
    },
    SERVER_READY_TIMEOUT_MS + 120_000,
  );
});
