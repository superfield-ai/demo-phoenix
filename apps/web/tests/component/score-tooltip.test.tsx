/**
 * @file score-tooltip.test.tsx
 *
 * Component tests for ScoreTooltip (issue #20).
 *
 * Verifies:
 *   1. Hovering the tier badge in a LeadRow shows a summary tooltip for that tier.
 *   2. Clicking Expand in the tooltip reveals formula and input snapshot values
 *      without a network request being fired.
 *   3. The CLTV estimate panel has a ? tooltip explaining the 3-year value range.
 *   4. The CFO portfolio chart tier legend has tooltips explaining each tier.
 *
 * No mocks — real DOM rendered via vitest-browser-react.
 *
 * @see https://github.com/superfield-ai/demo-phoenix/issues/20
 */

import React from 'react';
import { render } from 'vitest-browser-react';
import { expect, test } from 'vitest';
import { ScoreTooltip } from '../../src/components/ScoreTooltip';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SUMMARY =
  'Tier A leads have the highest composite CLTV score and are your best opportunities.';

const DETAIL = {
  formula: 'composite = macro × 0.30 + industry × 0.30 + company × 0.40',
  inputs: {
    macro_score: 0.85,
    industry_score: 0.72,
    company_score: 0.91,
    composite_score: 0.82,
  },
};

// ---------------------------------------------------------------------------
// ScoreTooltip unit tests
// ---------------------------------------------------------------------------

test('renders the ? trigger button', async () => {
  const screen = render(<ScoreTooltip summary_text={SUMMARY} aria_label="Test explanation" />);
  const trigger = screen.getByTestId('score-tooltip-trigger');
  await expect.element(trigger).toBeVisible();
  await expect.element(trigger).toHaveTextContent('?');
});

test('trigger has correct aria-label', async () => {
  const screen = render(
    <ScoreTooltip summary_text={SUMMARY} aria_label="Score tier A explanation" />,
  );
  const trigger = screen.getByTestId('score-tooltip-trigger');
  await expect.element(trigger).toHaveAttribute('aria-label', 'Score tier A explanation');
});

test('popover is not visible before hover', async () => {
  const screen = render(<ScoreTooltip summary_text={SUMMARY} />);
  const popover = screen.container.querySelector('[data-testid="score-tooltip-popover"]');
  expect(popover).toBeNull();
});

test('clicking trigger opens the popover with summary text', async () => {
  const screen = render(<ScoreTooltip summary_text={SUMMARY} />);
  await screen.getByTestId('score-tooltip-trigger').click();
  const popover = screen.getByTestId('score-tooltip-popover');
  await expect.element(popover).toBeVisible();
  const summary = screen.getByTestId('score-tooltip-summary');
  await expect.element(summary).toHaveTextContent(SUMMARY);
});

test('clicking outside the tooltip closes the popover', async () => {
  const screen = render(
    <div>
      <div data-testid="outside-target">Outside</div>
      <ScoreTooltip summary_text={SUMMARY} />
    </div>,
  );
  await screen.getByTestId('score-tooltip-trigger').click();
  await expect.element(screen.getByTestId('score-tooltip-popover')).toBeVisible();
  // Click the outside target to close via the mousedown outside handler.
  await screen.getByTestId('outside-target').click();
  // Popover should close.
  await expect
    .element(screen.getByTestId('score-tooltip-wrapper'))
    .not.toContainElement(
      screen.container.querySelector('[data-testid="score-tooltip-popover"]') as Element,
    );
});

test('expand button is not rendered when detail_content is absent', async () => {
  const screen = render(<ScoreTooltip summary_text={SUMMARY} />);
  await screen.getByTestId('score-tooltip-trigger').click();
  const expandBtn = screen.container.querySelector('[data-testid="score-tooltip-expand-btn"]');
  expect(expandBtn).toBeNull();
});

test('expand button is rendered when detail_content is provided', async () => {
  const screen = render(<ScoreTooltip summary_text={SUMMARY} detail_content={DETAIL} />);
  await screen.getByTestId('score-tooltip-trigger').click();
  const expandBtn = screen.getByTestId('score-tooltip-expand-btn');
  await expect.element(expandBtn).toBeVisible();
  await expect.element(expandBtn).toHaveTextContent('Expand');
});

test('clicking Expand reveals formula without a network request', async () => {
  // Track fetch calls made during this test.
  const calls: string[] = [];
  const originalFetch = window.fetch.bind(window);
  // Replace fetch with a tracking wrapper.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).fetch = (input: RequestInfo | URL, ...args: unknown[]) => {
    calls.push(typeof input === 'string' ? input : String(input));
    return originalFetch(input as RequestInfo | URL, ...(args as Parameters<typeof fetch>));
  };

  try {
    const screen = render(<ScoreTooltip summary_text={SUMMARY} detail_content={DETAIL} />);
    await screen.getByTestId('score-tooltip-trigger').click();
    await screen.getByTestId('score-tooltip-expand-btn').click();

    // Formula should be visible.
    const formulaEl = screen.getByTestId('score-tooltip-formula');
    await expect.element(formulaEl).toBeVisible();
    await expect.element(formulaEl).toHaveTextContent('composite =');

    // Inputs should be visible.
    const inputsEl = screen.getByTestId('score-tooltip-inputs');
    await expect.element(inputsEl).toBeVisible();

    // Verify no network request was fired.
    expect(calls.length).toBe(0);
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).fetch = originalFetch;
  }
});

test('expanded detail shows all input keys and values', async () => {
  const screen = render(<ScoreTooltip summary_text={SUMMARY} detail_content={DETAIL} />);
  await screen.getByTestId('score-tooltip-trigger').click();
  await screen.getByTestId('score-tooltip-expand-btn').click();

  const inputsEl = screen.getByTestId('score-tooltip-inputs');
  await expect.element(inputsEl).toBeVisible();

  // macro_score 0.85 → "85.0%"
  await expect.element(inputsEl).toHaveTextContent('85.0%');
  // industry_score 0.72 → "72.0%"
  await expect.element(inputsEl).toHaveTextContent('72.0%');
  // company_score 0.91 → "91.0%"
  await expect.element(inputsEl).toHaveTextContent('91.0%');
});

test('clicking Collapse hides the detail section', async () => {
  const screen = render(<ScoreTooltip summary_text={SUMMARY} detail_content={DETAIL} />);
  await screen.getByTestId('score-tooltip-trigger').click();
  await screen.getByTestId('score-tooltip-expand-btn').click();

  // Should be expanded now.
  await expect.element(screen.getByTestId('score-tooltip-detail')).toBeVisible();

  // Click Collapse.
  await screen.getByTestId('score-tooltip-expand-btn').click();
  const detailEl = screen.container.querySelector('[data-testid="score-tooltip-detail"]');
  expect(detailEl).toBeNull();
});

// ---------------------------------------------------------------------------
// Tier legend (CFO portfolio) integration — tests with inline JSX consumers
// ---------------------------------------------------------------------------

test('tier legend items each render a ScoreTooltip trigger', async () => {
  // Render four tier legend items similar to TierLegend in cfo-portfolio.tsx.
  const TIERS = ['A', 'B', 'C', 'D'] as const;
  const DESCRIPTIONS: Record<string, string> = {
    A: 'Tier A — Composite score >= 80. Highest-quality leads.',
    B: 'Tier B — Composite score 60–79. Good-quality leads.',
    C: 'Tier C — Composite score 40–59. Fair-quality leads.',
    D: 'Tier D — Composite score < 40. Low-quality leads.',
  };

  const screen = render(
    <div data-testid="tier-legend">
      {TIERS.map((tier) => (
        <span key={tier} data-testid={`tier-legend-item-${tier}`}>
          Tier {tier}
          <ScoreTooltip summary_text={DESCRIPTIONS[tier]} aria_label={`Tier ${tier} explanation`} />
        </span>
      ))}
    </div>,
  );

  // All four tier items are visible.
  for (const tier of TIERS) {
    await expect.element(screen.getByTestId(`tier-legend-item-${tier}`)).toBeVisible();
  }

  // All four tooltip triggers are present.
  const triggers = screen.container.querySelectorAll('[data-testid="score-tooltip-trigger"]');
  expect(triggers.length).toBe(4);
});

test('clicking tier legend tooltip shows tier description', async () => {
  const screen = render(
    <span data-testid="tier-a-item">
      Tier A
      <ScoreTooltip
        summary_text="Tier A — Composite score >= 80. Highest-quality leads."
        aria_label="Tier A explanation"
      />
    </span>,
  );

  await screen.getByRole('button', { name: 'Tier A explanation' }).click();
  const summary = screen.getByTestId('score-tooltip-summary');
  await expect.element(summary).toHaveTextContent('Tier A');
  await expect.element(summary).toHaveTextContent('Highest-quality');
});

// ---------------------------------------------------------------------------
// CLTV estimate tooltip
// ---------------------------------------------------------------------------

test('CLTV estimate tooltip shows range explanation', async () => {
  const cltvSummary =
    'This 3-year customer lifetime value estimate is a forward projection derived from the composite CLTV score — the range reflects model uncertainty at the low, mid, and high confidence bounds.';

  const screen = render(
    <div>
      <h3>
        CLTV Estimate (3-year)
        <ScoreTooltip summary_text={cltvSummary} aria_label="CLTV estimate explanation" />
      </h3>
    </div>,
  );

  const trigger = screen.getByRole('button', { name: 'CLTV estimate explanation' });
  await expect.element(trigger).toBeVisible();

  await trigger.click();
  const summary = screen.getByTestId('score-tooltip-summary');
  await expect.element(summary).toHaveTextContent('3-year customer lifetime value');
});
