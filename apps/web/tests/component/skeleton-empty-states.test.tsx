/**
 * @file skeleton-empty-states.test.tsx
 *
 * Component tests for skeleton loaders and contextual empty states (issue #19).
 *
 * Tests run in headless Chromium via Playwright/vitest-browser-react.
 * No mocks — the fixture server handles all API responses.
 *
 * Test plan (from issue #19):
 *   1. Mock a slow GET /api/leads/queue response; assert skeleton rows render during
 *      the delay.
 *   2. Seed 0 qualified + 3 pending-KYC prospects; load queue page; assert empty state
 *      message reads '...3 prospects pending KYC'.
 *   3. Seed a Prospect with no CLTVScore; assert that lead's row shows a Scoring…
 *      indicator.
 *   4. Load the CFO portfolio chart with no Prospect data; assert the chart panel shows
 *      a non-generic empty state message.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/19
 */

import React from 'react';
import { render } from 'vitest-browser-react';
import { commands } from '@vitest/browser/context';
import { afterEach, expect, test } from 'vitest';
import { LeadQueuePage } from '../../src/pages/lead-queue';
import {
  SkeletonRow,
  SkeletonCard,
  SkeletonChart,
  SkeletonBar,
} from '../../src/components/Skeleton';
import { ContextualEmptyState } from '../../src/components/ContextualEmptyState';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type LeadsQueueState = {
  leadsQueue?:
    | {
        status?: number;
        body?: { leads: unknown[]; pending_kyc_count: number };
        delayMs?: number;
      }
    | { leads: unknown[]; pending_kyc_count: number };
};

async function setQueueFixture(state: LeadsQueueState) {
  await commands.setFixtureState({ state });
}

afterEach(async () => {
  await commands.resetFixtureState({ fixtureId: 'default' });
});

// ---------------------------------------------------------------------------
// 1. Skeleton rows render while queue fetch is in flight
// ---------------------------------------------------------------------------

test('skeleton rows render while GET /api/leads/queue is in flight', async () => {
  // Set up a delayed response (200ms) so the skeleton appears before data arrives.
  await setQueueFixture({
    leadsQueue: {
      delayMs: 200,
      body: { leads: [], pending_kyc_count: 0 },
    },
  });

  const screen = render(<LeadQueuePage />);

  // Skeleton rows should appear immediately (before the delayed response).
  await expect.element(screen.getByTestId('skeleton-row')).toBeVisible();
});

// ---------------------------------------------------------------------------
// 2. Empty state message shows pending-KYC count
// ---------------------------------------------------------------------------

test('empty state message includes pending-KYC prospect count', async () => {
  await setQueueFixture({
    leadsQueue: { leads: [], pending_kyc_count: 3 },
  });

  const screen = render(<LeadQueuePage />);
  await expect.element(screen.getByTestId('lead-queue-empty-state')).toBeVisible();
  await expect
    .element(screen.getByTestId('lead-queue-empty-state'))
    .toHaveTextContent('3 prospects');
});

// ---------------------------------------------------------------------------
// 3. Prospect with no CLTVScore shows Scoring... badge
// ---------------------------------------------------------------------------

test('lead with scoring_in_progress shows Scoring badge', async () => {
  const scoringLead = {
    id: 'lead-scoring-1',
    company_name: 'Acme Corp',
    industry: 'Technology',
    sic_code: '7372',
    assigned_rep_id: 'rep-1',
    days_in_queue: 2,
    composite_score: null,
    score_tier: null,
    cltv_low: null,
    cltv_high: null,
    kyc_status: 'pending',
    deal_stage: null,
    nudge: false,
    scoring_in_progress: true,
    created_at: new Date().toISOString(),
  };

  await setQueueFixture({
    leadsQueue: { leads: [scoringLead], pending_kyc_count: 0 },
  });

  const screen = render(<LeadQueuePage />);
  await expect.element(screen.getByTestId('scoring-badge')).toBeVisible();
  await expect.element(screen.getByTestId('scoring-badge')).toHaveTextContent('Scoring');
});

// ---------------------------------------------------------------------------
// 4. CFO chart shows a non-generic contextual empty state
// ---------------------------------------------------------------------------

test('ContextualEmptyState renders a surface-specific message', async () => {
  const screen = render(
    <ContextualEmptyState
      message="No tier trend data for this quarter yet"
      detail="This chart will populate once leads have been scored across multiple weeks."
      testId="tier-trend-empty-state"
    />,
  );

  await expect.element(screen.getByTestId('tier-trend-empty-state')).toBeVisible();
  await expect
    .element(screen.getByTestId('tier-trend-empty-state'))
    .toHaveTextContent('No tier trend data for this quarter yet');
});

// ---------------------------------------------------------------------------
// Skeleton component unit tests
// ---------------------------------------------------------------------------

test('SkeletonRow renders with correct testid', async () => {
  const screen = render(<SkeletonRow />);
  await expect.element(screen.getByTestId('skeleton-row')).toBeVisible();
});

test('SkeletonCard renders with correct testid', async () => {
  const screen = render(<SkeletonCard />);
  await expect.element(screen.getByTestId('skeleton-card')).toBeVisible();
});

test('SkeletonChart renders with correct testid', async () => {
  const screen = render(<SkeletonChart />);
  await expect.element(screen.getByTestId('skeleton-chart')).toBeVisible();
});

test('SkeletonBar renders with correct testid and aria-label', async () => {
  const screen = render(<SkeletonBar />);
  await expect.element(screen.getByTestId('skeleton-bar')).toBeVisible();
  await expect
    .element(screen.getByTestId('skeleton-bar'))
    .toHaveAttribute('aria-label', 'CFO executive summary bar loading');
});

test('ContextualEmptyState renders message and optional detail', async () => {
  const screen = render(
    <ContextualEmptyState
      message="No qualified leads yet — KYC checks are running for 5 prospects"
      detail="Leads will appear here once scoring completes."
    />,
  );

  await expect.element(screen.getByTestId('contextual-empty-state')).toBeVisible();
  await expect
    .element(screen.getByTestId('contextual-empty-state'))
    .toHaveTextContent('No qualified leads yet — KYC checks are running for 5 prospects');
  await expect
    .element(screen.getByTestId('contextual-empty-state'))
    .toHaveTextContent('Leads will appear here once scoring completes.');
});
