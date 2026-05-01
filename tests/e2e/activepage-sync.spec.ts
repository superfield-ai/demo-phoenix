/**
 * @file activepage-sync.spec.ts
 *
 * End-to-end tests for activePage sync on load and heterogeneous role-gates
 * (issue #93).
 *
 * ## Test plan coverage
 *
 * E2E-1: CFO persona login — assert cfo-portfolio view renders without hard refresh.
 * E2E-2: collections_agent persona login — assert collection-queue renders on first load.
 * E2E-3: Assert mobile nav does not show Pipeline or Leads buttons for a CFO user.
 *
 * Strategy:
 *   1. Boot full stack in DEMO_MODE so all demo role users are seeded.
 *   2. For each role, sign in via the demo quick-login button.
 *   3. Assert the expected page heading is visible on first render (no manual
 *      navigation required), proving the activePage sync effect fires correctly.
 *   4. For the mobile nav test, set a mobile viewport and assert the Pipeline
 *      and Leads buttons are absent for CFO.
 *
 * Uses a real Playwright browser against a real Postgres + Bun server.
 * No mocks.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/93
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
const SERVER_PORT = 31443;
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
    throw new Error('Failed to build web assets for activepage-sync e2e test.');
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
  const btn = page.getByRole('button', { name: labelText });
  await btn.waitFor({ state: 'visible', timeout: 10_000 });
  await btn.click();
  return page;
}

describe('activePage sync on load (issue #93)', () => {
  it('CFO persona login lands on cfo-portfolio without hard refresh', async () => {
    const page = await loginAs('CFO');
    // CFO Portfolio renders "CLTV Portfolio" heading — visible on first render
    // without any manual navigation, confirming activePage syncs after auth resolves.
    await playwrightExpect(page.getByText('CLTV Portfolio')).toBeVisible({ timeout: 10_000 });
    await page.close();
  });

  it('collections_agent persona login lands on collection-queue on first load', async () => {
    const page = await loginAs('Collections Agent');
    await playwrightExpect(page.getByText('Case Queue')).toBeVisible({ timeout: 10_000 });
    await page.close();
  });

  it('mobile nav does not show Pipeline or Leads buttons for a CFO user', async () => {
    const page = await browser.newPage();
    // Set a mobile viewport so the mobile nav renders instead of the desktop sidebar.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(env.baseUrl);

    // Sign in as CFO via quick-login.
    const btn = page.getByRole('button', { name: 'CFO' });
    await btn.waitFor({ state: 'visible', timeout: 10_000 });
    await btn.click();

    // Wait for the authenticated app to load (CFO portfolio heading visible).
    await playwrightExpect(page.getByText('CLTV Portfolio')).toBeVisible({ timeout: 10_000 });

    // Pipeline and Leads buttons must be absent from mobile nav for CFO.
    await playwrightExpect(page.getByTestId('nav-pipeline-mobile')).not.toBeVisible();
    await playwrightExpect(page.getByTestId('nav-leads-mobile')).not.toBeVisible();

    await page.close();
  });
});
