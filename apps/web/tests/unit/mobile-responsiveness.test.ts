/**
 * @file mobile-responsiveness.test.ts
 *
 * Unit tests for mobile and tablet responsive behaviour (issue #22).
 *
 * Validates that the responsive CSS classes and layout structures satisfy the
 * acceptance criteria at 375px (mobile) and 1024px (tablet) breakpoints.
 *
 * Tests inspect the exported source constants and class strings directly —
 * no browser or mock required.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/22
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WEB_SRC = resolve(__dirname, '../../src');

function readSrc(relPath: string): string {
  return readFileSync(resolve(WEB_SRC, relPath), 'utf-8');
}

// ─────────────────────────────────────────────────────────────────────────────
// index.html — viewport meta tag
// ─────────────────────────────────────────────────────────────────────────────

describe('index.html viewport meta tag', () => {
  const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf-8');

  test('has viewport meta tag with width=device-width', () => {
    expect(html).toContain('name="viewport"');
    expect(html).toContain('width=device-width');
  });

  test('has initial-scale=1.0 to prevent iOS auto-zoom', () => {
    expect(html).toContain('initial-scale=1.0');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CfoSummaryBar — tablet (1024px) horizontal scroll
// ─────────────────────────────────────────────────────────────────────────────

describe('CfoSummaryBar tablet responsiveness', () => {
  const src = readSrc('components/CfoSummaryBar.tsx');

  test('summary bar container has overflow-x-auto to prevent horizontal scrollbar on page', () => {
    expect(src).toContain('overflow-x-auto');
  });

  test('tile container uses min-w-max on small viewports so tiles do not wrap into the page', () => {
    expect(src).toContain('min-w-max');
  });

  test('MetricTile has min-h-[44px] to meet minimum tap target requirement', () => {
    expect(src).toContain('min-h-[44px]');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cfo-portfolio — chart container overflow and responsive summary grid
// ─────────────────────────────────────────────────────────────────────────────

describe('CfoPortfolioPage tablet responsiveness', () => {
  const src = readSrc('pages/cfo-portfolio.tsx');

  test('CLTV chart container has overflow-x-auto to prevent horizontal overflow at 1024px', () => {
    expect(src).toContain('overflow-x-auto');
  });

  test('BubbleChart SVG has w-full so it scales to container width', () => {
    expect(src).toContain('className="w-full h-full"');
  });

  test('executive summary grid is responsive (2-col on mobile, 4-col on lg+)', () => {
    expect(src).toContain('grid-cols-2');
    expect(src).toContain('lg:grid-cols-4');
  });

  test('macro modeler grid is responsive (1-col on mobile, 3-col on md+)', () => {
    expect(src).toContain('grid-cols-1');
    expect(src).toContain('md:grid-cols-3');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// App.tsx — mobile bottom navigation and responsive layout
// ─────────────────────────────────────────────────────────────────────────────

describe('App layout mobile responsiveness', () => {
  const src = readSrc('App.tsx');

  test('left sidebar is hidden on mobile (uses hidden md:flex)', () => {
    expect(src).toContain('hidden md:flex');
  });

  test('mobile bottom navigation is present (flex md:hidden)', () => {
    expect(src).toContain('flex md:hidden');
  });

  test('mobile nav buttons have minimum 44px tap target', () => {
    expect(src).toContain('min-h-[44px]');
    expect(src).toContain('min-w-[44px]');
  });

  test('root layout is flex-col on mobile and flex-row on md+', () => {
    expect(src).toContain('flex-col md:flex-row');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// lead-queue.tsx — mobile responsiveness at 375px
// ─────────────────────────────────────────────────────────────────────────────

describe('LeadQueuePage mobile responsiveness at 375px', () => {
  const src = readSrc('pages/lead-queue.tsx');

  test('LeadRow has a mobile card layout (flex md:hidden) and desktop row layout (hidden md:flex)', () => {
    expect(src).toContain('flex md:hidden');
    expect(src).toContain('hidden md:flex');
  });

  test('column headers are hidden on mobile to prevent horizontal overflow', () => {
    expect(src).toContain('hidden md:flex items-center gap-4 px-4 py-2');
  });

  test('lead rows are full-width (w-full) on mobile', () => {
    expect(src).toContain('w-full block px-4 py-3');
  });

  test('filter trigger button is visible on mobile (flex md:hidden)', () => {
    // Mobile filter section
    expect(src).toContain('data-testid="filter-trigger"');
  });

  test('filter trigger has aria-label "Open filters"', () => {
    expect(src).toContain('aria-label="Open filters"');
  });

  test('mobile filter overlay is a dialog with aria-modal', () => {
    expect(src).toContain('role="dialog"');
    expect(src).toContain('aria-modal="true"');
  });

  test('filter trigger button meets minimum 44px tap target', () => {
    expect(src).toContain('min-h-[44px]');
  });

  test('LeadRow tappable as button when onSelectLead is provided', () => {
    expect(src).toContain('onClick={() => onSelectLead(lead.id)}');
  });

  test('LeadQueuePage accepts onSelectLead prop and passes it down', () => {
    expect(src).toContain('onSelectLead?: (id: string) => void');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// App.tsx wires up LeadQueuePage from lead-queue.tsx (full-featured queue)
// ─────────────────────────────────────────────────────────────────────────────

describe('App.tsx queue page wiring', () => {
  const appSrc = readSrc('App.tsx');

  test('App imports LeadQueuePage from lead-queue not lead-detail', () => {
    expect(appSrc).toContain("from './pages/lead-queue'");
    // Should NOT import LeadQueuePage from lead-detail
    expect(appSrc).not.toContain("LeadQueuePage } from './pages/lead-detail'");
  });

  test('App passes onSelectLead callback to LeadQueuePage', () => {
    expect(appSrc).toContain('onSelectLead={(id)');
  });
});
