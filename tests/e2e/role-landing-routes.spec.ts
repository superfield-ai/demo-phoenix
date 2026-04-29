/**
 * @file role-landing-routes.spec.ts
 *
 * End-to-end tests for role-based landing page routing (issue #75).
 *
 * ## Test plan coverage
 *
 * E2E-1: collections_agent lands on Case Queue on first render.
 * E2E-2: finance_controller lands on CFO Dashboard on first render.
 * E2E-3: cfo lands on CFO Portfolio on first render.
 * E2E-4: demo-bdm user can navigate to Campaign Analysis page via nav link.
 *
 * Strategy:
 *   1. Boot full stack in DEMO_MODE so all demo role users are seeded.
 *   2. For each role, sign in via the demo quick-login button.
 *   3. Assert the expected page heading is visible without any manual
 *      navigation (confirming defaultPage is correct).
 *   4. For BDM, assert the Campaign Analysis nav link is visible and clicking
 *      it renders the Campaign Analysis page.
 *
 * Uses a real Playwright browser against a real Postgres + Bun server.
 * No mocks.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/75
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
const SERVER_PORT = 31442;
const SERVER_READY_TIMEOUT_MS = 30_000;

type DemoEnv = {
  pg: PgContainer;
  server: Subprocess;
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
    throw new Error('Failed to build web assets for role-landing-routes e2e test.');
  }

  const pg = await startPostgres();
  await applyAuditSchema(pg.url);

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
  return { pg, server, baseUrl: `http://localhost:${SERVER_PORT}` };
}

async function stopDemoServer(env: DemoEnv): Promise<void> {
  env.server.kill();
  await env.pg.stop();
}

let browser: Browser;
let env: DemoEnv;

beforeAll(async () => {
  env = await startDemoServer();
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser.close();
  await stopDemoServer(env);
});

/**
 * Sign in via the demo quick-login button for the given label text.
 * Returns a Playwright Page already loaded and past the login screen.
 */
async function loginAs(labelText: string) {
  const page = await browser.newPage();
  await page.goto(env.baseUrl);
  // Click the quick-login button matching the role label
  const btn = page.getByRole('button', { name: labelText });
  await btn.waitFor({ state: 'visible', timeout: 10_000 });
  await btn.click();
  return page;
}

describe('role-based landing routes', () => {
  it('collections_agent lands on Case Queue on first render', async () => {
    const page = await loginAs('Collections Agent');
    await playwrightExpect(page.getByText('Case Queue')).toBeVisible({ timeout: 10_000 });
    await page.close();
  });

  it('finance_controller lands on CFO Dashboard on first render', async () => {
    const page = await loginAs('Finance Controller');
    await playwrightExpect(page.getByText('CFO Dashboard')).toBeVisible({ timeout: 10_000 });
    await page.close();
  });

  it('cfo lands on CFO Portfolio on first render', async () => {
    const page = await loginAs('CFO');
    // CFO Portfolio renders "CLTV Portfolio" heading
    await playwrightExpect(page.getByText('CLTV Portfolio')).toBeVisible({ timeout: 10_000 });
    await page.close();
  });

  it('demo-bdm user sees Campaign Analysis nav link and page renders', async () => {
    const page = await loginAs('BDM');
    // The Campaign Analysis nav button should be visible
    const navBtn = page.getByTestId('nav-campaign-analysis');
    await navBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await navBtn.click();
    // The campaign analysis page container should be visible
    await playwrightExpect(page.getByTestId('campaign-analysis-page')).toBeVisible({
      timeout: 10_000,
    });
    await page.close();
  });
});
