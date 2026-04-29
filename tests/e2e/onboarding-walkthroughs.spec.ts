/**
 * @file onboarding-walkthroughs.spec.ts
 *
 * End-to-end tests for first-login onboarding walkthroughs added in issue #57.
 *
 * ## Test plan coverage
 *
 * E2E-1: Collections Agent first login shows walkthrough modal; completing it
 *         suppresses it on second login.
 * E2E-2: Account Manager first login shows walkthrough modal.
 * E2E-3: Finance Controller first login shows walkthrough modal.
 *
 * Strategy:
 *   1. Boot full stack in DEMO_MODE so all five role demo users are seeded.
 *   2. For each role, ensure the demo user has onboarding_completed=false via
 *      a direct DB update before the test.
 *   3. Sign in via the demo quick-login button.
 *   4. Assert the "Onboarding walkthrough" dialog is visible.
 *   5. For the Collections Agent, complete the walkthrough by clicking "Next"
 *      twice and "Get started", then re-login and assert the modal is absent.
 *
 * Uses a real Playwright browser against a real Postgres + Bun server.
 * No mocks.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/57
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
const SERVER_PORT = 31441;
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
    throw new Error('Failed to build web assets for onboarding-walkthroughs e2e test.');
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

/** Reset onboarding_completed to false for a user with the given role. */
async function resetUserOnboarding(sql: ReturnType<typeof postgres>, role: string): Promise<void> {
  await sql`
    UPDATE entities
    SET properties = jsonb_set(properties, '{onboarding_completed}', 'false'::jsonb),
        updated_at = NOW()
    WHERE type = 'user'
      AND properties->>'role' = ${role}
  `;
}

/**
 * Sign in via demo quick-login button and wait for the authenticated shell.
 * Returns the page after successful login.
 */
async function signInAsRole(
  browser: Browser,
  baseUrl: string,
  roleLabel: string,
): Promise<import('@playwright/test').Page> {
  const page = await browser.newPage();
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  const btn = page.getByRole('button', { name: `Sign in as ${roleLabel}` });
  await playwrightExpect(btn).toBeVisible({ timeout: 10_000 });
  await btn.click();
  // Wait for the login page heading to disappear (app shell mounts).
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

// ---------------------------------------------------------------------------
// E2E-1: Collections Agent first-login walkthrough
// ---------------------------------------------------------------------------

describe('Collections Agent first-login walkthrough', () => {
  it('shows walkthrough modal on first login', async () => {
    await resetUserOnboarding(demoEnv.sql, 'collections_agent');
    const page = await signInAsRole(browser, demoEnv.baseUrl, 'Collections Agent');
    try {
      await playwrightExpect(
        page.getByRole('dialog', { name: 'Onboarding walkthrough' }),
      ).toBeVisible({ timeout: 10_000 });
      // Step 1 title should be "Case Queue"
      await playwrightExpect(page.getByRole('heading', { name: 'Case Queue' })).toBeVisible();
    } finally {
      await page.close();
    }
  });

  it('completing walkthrough suppresses it on second login', async () => {
    await resetUserOnboarding(demoEnv.sql, 'collections_agent');
    const page = await signInAsRole(browser, demoEnv.baseUrl, 'Collections Agent');
    try {
      // Wait for dialog to appear
      await playwrightExpect(
        page.getByRole('dialog', { name: 'Onboarding walkthrough' }),
      ).toBeVisible({ timeout: 10_000 });

      // Navigate through all 3 steps
      await page.getByRole('button', { name: 'Next' }).click();
      await playwrightExpect(page.getByRole('heading', { name: 'Contact Log' })).toBeVisible();
      await page.getByRole('button', { name: 'Next' }).click();
      await playwrightExpect(
        page.getByRole('heading', { name: 'Payment Plan Panel' }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Get started' }).click();

      // Modal should be gone after completing
      await playwrightExpect(
        page.getByRole('dialog', { name: 'Onboarding walkthrough' }),
      ).not.toBeVisible({ timeout: 5_000 });
    } finally {
      await page.close();
    }

    // Second login — modal should not appear
    const page2 = await signInAsRole(browser, demoEnv.baseUrl, 'Collections Agent');
    try {
      // Give the app a moment to potentially render the modal
      await page2.waitForTimeout(2_000);
      await playwrightExpect(
        page2.getByRole('dialog', { name: 'Onboarding walkthrough' }),
      ).not.toBeVisible();
    } finally {
      await page2.close();
    }
  });
});

// ---------------------------------------------------------------------------
// E2E-2: Account Manager first-login walkthrough
// ---------------------------------------------------------------------------

describe('Account Manager first-login walkthrough', () => {
  it('shows walkthrough modal on first login', async () => {
    await resetUserOnboarding(demoEnv.sql, 'account_manager');
    const page = await signInAsRole(browser, demoEnv.baseUrl, 'Account Manager');
    try {
      await playwrightExpect(
        page.getByRole('dialog', { name: 'Onboarding walkthrough' }),
      ).toBeVisible({ timeout: 10_000 });
      // Step 1 title should be "Customer Health Dashboard"
      await playwrightExpect(
        page.getByRole('heading', { name: 'Customer Health Dashboard' }),
      ).toBeVisible();
    } finally {
      await page.close();
    }
  });
});

// ---------------------------------------------------------------------------
// E2E-3: Finance Controller first-login walkthrough
// ---------------------------------------------------------------------------

describe('Finance Controller first-login walkthrough', () => {
  it('shows walkthrough modal on first login', async () => {
    await resetUserOnboarding(demoEnv.sql, 'finance_controller');
    const page = await signInAsRole(browser, demoEnv.baseUrl, 'Finance Controller');
    try {
      await playwrightExpect(
        page.getByRole('dialog', { name: 'Onboarding walkthrough' }),
      ).toBeVisible({ timeout: 10_000 });
      // Step 1 title should be "AR Aging Dashboard"
      await playwrightExpect(
        page.getByRole('heading', { name: 'AR Aging Dashboard' }),
      ).toBeVisible();
    } finally {
      await page.close();
    }
  });
});
