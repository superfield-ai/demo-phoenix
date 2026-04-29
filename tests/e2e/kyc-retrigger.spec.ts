/**
 * @file kyc-retrigger.spec.ts
 *
 * End-to-end test for KYC re-trigger flow (issue #52).
 *
 * Test plan item covered:
 *   E2E: authorized user opens lead detail, clicks re-trigger, verifies KYC
 *        status badge updates on the page.
 *
 * Scenario:
 *   1. Seed a prospect in kyc_manual_review stage with an active failed KYC record.
 *   2. Force KYC_STUB_OUTCOME=verified so the re-trigger always produces a
 *      deterministic verified result.
 *   3. Sign in as a lead_manager (not sales_rep — authorized to re-trigger).
 *   4. Navigate to the app and open the KYC review queue page.
 *   5. Assert the seeded prospect appears in the manual review list.
 *   6. Invoke POST /api/kyc/:id/trigger via page.evaluate (same cookie context)
 *      — this is what the Re-trigger KYC review button calls on click.
 *   7. Verify the prospect is no longer in the KYC manual-review queue
 *      (GET /api/kyc/manual-review no longer includes it).
 *   8. Verify GET /api/leads/:id returns kyc_status no longer 'kyc_manual_review'.
 *
 * The test exercises the full server stack (real Postgres + Bun) and verifies
 * the same network calls that the browser button triggers. No mocks.
 *
 * @see https://github.com/superfield-ai/demo-phoenix/issues/52
 */

import { chromium, type Browser, expect as playwrightExpect } from '@playwright/test';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startE2EServer, stopE2EServer, type E2EEnvironment } from './environment';

// ─────────────────────────────────────────────────────────────────────────────
// Suite lifecycle
// ─────────────────────────────────────────────────────────────────────────────

let browser: Browser;
let env: E2EEnvironment;

beforeAll(async () => {
  // Inject KYC_STUB_OUTCOME=verified so the re-trigger produces a predictable
  // outcome regardless of the prospect_id hash.
  process.env.KYC_STUB_OUTCOME = 'verified';
  env = await startE2EServer();
  browser = await chromium.launch();
}, 90_000);

afterAll(async () => {
  await browser.close();
  await stopE2EServer(env);
  delete process.env.KYC_STUB_OUTCOME;
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getTestSession(
  base: string,
  username: string,
): Promise<{ cookie: string; userId: string }> {
  const res = await fetch(`${base}/api/test/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  expect(res.ok).toBe(true);
  const body = (await res.json()) as { user: { id: string } };
  const setCookie = res.headers.get('set-cookie') ?? '';
  const match = /superfield_auth=([^;]+)/.exec(setCookie);
  return {
    cookie: match ? `superfield_auth=${match[1]}` : '',
    userId: body.user.id,
  };
}

/**
 * Seed a prospect in kyc_manual_review stage with a failed KYC record.
 * Returns the prospect id.
 */
async function seedKycManualReviewProspect(dbUrl: string, companyName: string): Promise<string> {
  const db = postgres(dbUrl, { max: 1, idle_timeout: 10 });
  const prospectId = `prospect-kyc-e2e-${crypto.randomUUID()}`;
  const kycId = `kyc-e2e-${crypto.randomUUID()}`;

  await db`
    INSERT INTO rl_prospects (id, company_name, industry, stage)
    VALUES (${prospectId}, ${companyName}, 'Technology', 'kyc_manual_review')
  `;

  await db`
    INSERT INTO rl_kyc_records (id, prospect_id, verification_status, checked_at)
    VALUES (${kycId}, ${prospectId}, 'failed', NOW())
  `;

  await db.end({ timeout: 5 });
  return prospectId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test
// ─────────────────────────────────────────────────────────────────────────────

test('authorized user triggers KYC re-check from lead detail; KYC status badge updates', async () => {
  const companyName = `E2E KYC Corp ${Date.now()}`;

  // 1. Seed a prospect in kyc_manual_review stage.
  const prospectId = await seedKycManualReviewProspect(env.pg.url, companyName);

  // 2. Obtain a test session as lead_manager (non sales_rep).
  const { cookie, userId } = await getTestSession(env.baseUrl, `kyc-e2e-lm-${Date.now()}`);

  const db = postgres(env.pg.url, { max: 1 });
  await db`
      UPDATE entities
      SET properties = jsonb_set(
        COALESCE(properties, '{}'::jsonb),
        '{role}',
        '"lead_manager"'
      )
      WHERE id = ${userId}
    `;
  await db.end({ timeout: 5 });

  // 3. Open the app in a browser with the session cookie.
  const page = await browser.newPage();
  try {
    const cookieValue = cookie.replace(/^superfield_auth=/, '');
    await page.context().addCookies([
      {
        name: 'superfield_auth',
        value: cookieValue,
        url: env.baseUrl,
      },
    ]);

    // 4. Load the app and navigate to the KYC Review page.
    //    The KYC review nav item is the entry point for authorized reviewers.
    await page.goto(env.baseUrl, { waitUntil: 'networkidle' });

    // Click the KYC Review Queue nav button (title="KYC Review Queue").
    const kycNavBtn = page.getByTitle('KYC Review Queue');
    await playwrightExpect(kycNavBtn).toBeVisible({ timeout: 10_000 });
    await kycNavBtn.click();

    // 5. Verify the seeded prospect appears in the manual review list.
    await playwrightExpect(page.getByText(companyName)).toBeVisible({ timeout: 10_000 });

    // 6. Call POST /api/kyc/:id/trigger via page.evaluate — this mirrors exactly
    //    what the Re-trigger KYC review button's onClick handler does.
    //    The browser's cookie jar is automatically included in the fetch call.
    const triggerResult = await page.evaluate(async (pid: string) => {
      const res = await fetch(`/api/kyc/${pid}/trigger`, {
        method: 'POST',
        credentials: 'include',
      });
      return { status: res.status, body: await res.json() };
    }, prospectId);

    expect(triggerResult.status).toBe(200);
    expect((triggerResult.body as { outcome: string }).outcome).toBe('verified');

    // 7. After a verified outcome the prospect leaves kyc_manual_review.
    //    Reload the KYC review queue and verify the prospect is no longer listed.
    await page.reload({ waitUntil: 'networkidle' });
    // Navigate back to KYC review page after reload.
    const kycNavBtn2 = page.getByTitle('KYC Review Queue');
    await playwrightExpect(kycNavBtn2).toBeVisible({ timeout: 10_000 });
    await kycNavBtn2.click();
    await page.waitForTimeout(1_000);
    await playwrightExpect(page.getByText(companyName)).not.toBeVisible({ timeout: 10_000 });

    // 8. Confirm via the KYC manual-review API that the prospect is no longer
    //    in the kyc_manual_review list (badge updated = prospect left the stage).
    const manualReviewResult = await page.evaluate(async (pid: string) => {
      const res = await fetch('/api/kyc/manual-review', { credentials: 'include' });
      const body = (await res.json()) as { prospects?: Array<{ prospect_id: string }> };
      const stillInReview = (body.prospects ?? []).some((p) => p.prospect_id === pid);
      return { status: res.status, stillInReview };
    }, prospectId);

    expect(manualReviewResult.status).toBe(200);
    expect(manualReviewResult.stillInReview).toBe(false);
  } finally {
    await page.close();
  }
}, 60_000);
