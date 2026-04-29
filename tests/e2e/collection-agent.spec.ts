/**
 * @file collection-agent.spec.ts
 *
 * End-to-end test for the Collections Agent case queue and contact logging
 * feature (issue #49).
 *
 * ## Test plan coverage
 *
 * E2E: Collections Agent logs in, opens the case queue, opens a case detail,
 *   logs a contact attempt, and verifies it appears in the contact log.
 *
 * Strategy:
 *   1. Boot full stack in DEMO_MODE.
 *   2. Sign in as Collections Agent via demo quick-login.
 *   3. Seed a collection case assigned to the agent via direct DB inserts.
 *   4. Navigate to the case queue page.
 *   5. Click on the case row to open the detail page.
 *   6. Submit a contact attempt form.
 *   7. Verify the new contact log entry appears in the contact log.
 *
 * Uses a real Playwright browser against a real Postgres + Bun server.
 * No mocks.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/49
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
const SERVER_PORT = 31432;
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
    throw new Error('Failed to build web assets for collection-agent e2e test.');
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

async function signInAsCollectionsAgent(): Promise<import('@playwright/test').Page> {
  const page = await browser.newPage();
  await page.goto(demoEnv.baseUrl, { waitUntil: 'networkidle' });

  const btn = page.getByRole('button', { name: 'Sign in as Collections Agent' });
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
// E2E: Collections Agent case queue and contact logging
// ---------------------------------------------------------------------------

describe('collections agent case queue — E2E', () => {
  it(
    'Collections Agent sees case queue, opens detail, logs a contact attempt',
    async () => {
      const { sql } = demoEnv;

      // Fetch a real collections_agent user from demo data.
      const agentRows = await sql<{ id: string }[]>`
        SELECT id FROM entities
        WHERE type = 'user'
          AND properties->>'role' = 'collections_agent'
        LIMIT 1
      `;
      if (agentRows.length === 0) {
        throw new Error('No collections_agent user found — demo seed did not run.');
      }
      const agentId = agentRows[0].id;

      // Fetch a real customer from seeded demo data.
      const customerRows = await sql<{ id: string; company_name: string }[]>`
        SELECT id, company_name FROM rl_customers LIMIT 1
      `;
      if (customerRows.length === 0) {
        throw new Error('No customers found — demo seed did not run.');
      }
      const customerId = customerRows[0].id;
      const companyName = customerRows[0].company_name;

      // Seed an overdue invoice.
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() - 35);
      const dueDateStr = dueDate.toISOString().slice(0, 10);

      const [invRow] = await sql<{ id: string }[]>`
        INSERT INTO rl_invoices (customer_id, amount, currency, due_date, status, issued_at)
        VALUES (${customerId}, 1500, 'USD', ${dueDateStr}, 'overdue', NOW())
        RETURNING id
      `;
      const invoiceId = invRow.id;

      // Transition invoice to in_collection and open a case.
      await sql`
        UPDATE rl_invoices SET status = 'in_collection', updated_at = NOW()
        WHERE id = ${invoiceId}
      `;

      const [caseRow] = await sql<{ id: string }[]>`
        INSERT INTO rl_collection_cases (invoice_id, agent_id, status)
        VALUES (${invoiceId}, ${agentId}, 'open')
        RETURNING id
      `;
      const caseId = caseRow.id;

      const page = await signInAsCollectionsAgent();

      try {
        // Navigate to the case queue.
        const queueBtn = page.getByTestId('nav-collection-queue');
        await playwrightExpect(queueBtn).toBeVisible({ timeout: 10_000 });
        await queueBtn.click();

        // The case queue heading should appear.
        const heading = page.getByRole('heading', { name: 'Case Queue' });
        await playwrightExpect(heading).toBeVisible({ timeout: 10_000 });

        // The case row for our seeded case should appear.
        const caseRowEl = page.getByTestId(`case-row-${caseId}`);
        await playwrightExpect(caseRowEl).toBeVisible({ timeout: 10_000 });

        // The customer name should be shown.
        await playwrightExpect(caseRowEl).toContainText(companyName, { timeout: 5_000 });

        // Click to open the case detail.
        await caseRowEl.click();

        // The case detail panel should appear.
        const caseDetail = page.getByTestId('case-detail');
        await playwrightExpect(caseDetail).toBeVisible({ timeout: 10_000 });

        // Click the Log Contact Attempt button to expand the form.
        const logBtn = page.getByTestId('log-contact-btn');
        await playwrightExpect(logBtn).toBeVisible({ timeout: 5_000 });
        await logBtn.click();

        // The form should appear.
        const form = page.getByTestId('contact-log-form');
        await playwrightExpect(form).toBeVisible({ timeout: 5_000 });

        // Select contact type = email.
        await page.getByTestId('contact-type-email').click();

        // Fill in the outcome.
        const outcomeInput = page.getByTestId('contact-outcome-input');
        await outcomeInput.fill('Spoke to accounts payable — payment committed for next week');

        // Fill in notes.
        const notesInput = page.getByTestId('contact-notes-input');
        await notesInput.fill('Contact was polite and cooperative');

        // Submit.
        const submitBtn = page.getByTestId('contact-submit-btn');
        await submitBtn.click();

        // The form should close and the new contact log entry should appear.
        await playwrightExpect(form).not.toBeVisible({ timeout: 10_000 });

        const contactLog = page.getByTestId('contact-log');
        await playwrightExpect(contactLog).toBeVisible({ timeout: 5_000 });
        await playwrightExpect(contactLog).toContainText(
          'Spoke to accounts payable — payment committed for next week',
          { timeout: 5_000 },
        );
      } finally {
        await page.close();
      }
    },
    SERVER_READY_TIMEOUT_MS + 120_000,
  );
});
