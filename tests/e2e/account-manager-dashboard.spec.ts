/**
 * @file account-manager-dashboard.spec.ts
 *
 * End-to-end test for the Account Manager customer health dashboard
 * (issue #55).
 *
 * ## Test plan coverage
 *
 * E2E: Account Manager logs in, verifies dashboard is the default page,
 *   opens a customer with a health alert, verifies signal labels are visible.
 *
 * Strategy:
 *   1. Boot full stack in DEMO_MODE.
 *   2. Sign in as Account Manager via demo quick-login.
 *   3. Seed a customer assigned to the AM with a health alert (score < 0.70)
 *      and at least one health signal via direct DB inserts.
 *   4. Verify the dashboard is the default landing page.
 *   5. Verify the health alert badge is visible on the seeded customer row.
 *   6. Click the customer row to open the detail panel.
 *   7. Verify signal labels are visible in the detail panel.
 *
 * Uses a real Playwright browser against a real Postgres + Bun server.
 * No mocks.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/55
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
const SERVER_PORT = 31440;
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
    throw new Error('Failed to build web assets for account-manager-dashboard e2e test.');
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

async function signInAsAccountManager(): Promise<import('@playwright/test').Page> {
  const page = await browser.newPage();
  await page.goto(demoEnv.baseUrl, { waitUntil: 'networkidle' });

  const btn = page.getByRole('button', { name: 'Sign in as Account Manager' });
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
  await page.reload({ waitUntil: 'networkidle' });

  return page;
}

// ---------------------------------------------------------------------------
// E2E: Account Manager health dashboard
// ---------------------------------------------------------------------------

describe('account manager customer health dashboard — E2E', () => {
  it(
    'Account Manager sees health dashboard as default, opens customer with alert, sees signal labels',
    async () => {
      const { sql } = demoEnv;

      // Fetch the account_manager user seeded by demo-users.
      const amRows = await sql<{ id: string }[]>`
        SELECT id FROM entities
        WHERE type = 'user'
          AND properties->>'role' = 'account_manager'
        LIMIT 1
      `;
      if (amRows.length === 0) {
        throw new Error('No account_manager user found — demo seed did not run.');
      }
      const amId = amRows[0].id;

      // Seed a customer assigned to the AM with a below-threshold health score.
      const [customerRow] = await sql<{ id: string }[]>`
        INSERT INTO rl_customers (company_name, segment, health_score, account_manager_id)
        VALUES ('Test At-Risk Corp', 'mid-market', 0.45, ${amId})
        RETURNING id
      `;
      const customerId = customerRow.id;

      // Seed a health score history entry so the trend calculation has data.
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      await sql`
        INSERT INTO rl_health_score_history (customer_id, score, recorded_at)
        VALUES (${customerId}, 0.60, ${sevenDaysAgo.toISOString()})
      `;

      // Seed a health signal with a recognisable source label.
      await sql`
        INSERT INTO rl_health_signals (customer_id, source_label, contribution, recorded_at)
        VALUES (${customerId}, 'overdue_invoice', -0.15, NOW())
      `;

      const page = await signInAsAccountManager();

      try {
        // The dashboard should be the default landing page after sign-in.
        const dashboard = page.getByTestId('account-manager-dashboard');
        await playwrightExpect(dashboard).toBeVisible({ timeout: 15_000 });

        // The seeded customer row should appear with a health alert badge.
        const customerRowEl = page.getByTestId(`customer-row-${customerId}`);
        await playwrightExpect(customerRowEl).toBeVisible({ timeout: 10_000 });

        const alertBadge = customerRowEl.getByTestId('health-alert-badge');
        await playwrightExpect(alertBadge).toBeVisible({ timeout: 5_000 });

        // Click the customer row to open the detail panel.
        await customerRowEl.click();

        // The detail panel should appear.
        const detailPanel = page.getByTestId('customer-detail-panel');
        await playwrightExpect(detailPanel).toBeVisible({ timeout: 10_000 });

        // The signal list should be visible.
        const signalList = detailPanel.getByTestId('signal-list');
        await playwrightExpect(signalList).toBeVisible({ timeout: 5_000 });

        // The signal source label for 'overdue_invoice' should be visible.
        const signalLabel = detailPanel.getByTestId('signal-label-overdue_invoice');
        await playwrightExpect(signalLabel).toBeVisible({ timeout: 5_000 });
      } finally {
        await page.close();
      }
    },
    SERVER_READY_TIMEOUT_MS + 120_000,
  );
});
