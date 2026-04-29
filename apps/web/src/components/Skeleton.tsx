/**
 * @file Skeleton
 *
 * Configurable skeleton loader components used across all data surfaces
 * while fetch requests are in flight (issue #19).
 *
 * Variants:
 *   - SkeletonRow    — matches the LeadRow layout (tier badge, company, CLTV, KYC, days, rep)
 *   - SkeletonCard   — matches the PipelineCard layout (company, tier, CLTV, days)
 *   - SkeletonChart  — matches CFO chart panel dimensions
 *   - SkeletonBar    — matches the CfoSummaryBar layout
 *
 * Each renders a shimmering placeholder with the same outer dimensions as the
 * real content so the page does not reflow when data arrives.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/19
 */

import React from 'react';

// ---------------------------------------------------------------------------
// Shimmer base
// ---------------------------------------------------------------------------

function Shimmer({ className }: { className?: string }) {
  return <div aria-hidden="true" className={`bg-zinc-200 rounded ${className ?? ''}`} />;
}

// ---------------------------------------------------------------------------
// SkeletonRow — matches LeadRow height (72 px)
// ---------------------------------------------------------------------------

export function SkeletonRow() {
  return (
    <div
      aria-hidden="true"
      data-testid="skeleton-row"
      className="animate-pulse flex items-center gap-4 px-4 py-3 border-b border-zinc-100"
      style={{ height: 72 }}
    >
      {/* Tier badge placeholder */}
      <div className="flex-shrink-0 w-10 flex justify-center">
        <Shimmer className="w-8 h-8 rounded-full" />
      </div>

      {/* Company / industry */}
      <div className="flex-1 min-w-0 space-y-1.5">
        <Shimmer className="h-3.5 w-2/3" />
        <Shimmer className="h-3 w-1/3" />
      </div>

      {/* CLTV */}
      <div className="w-32 space-y-1.5 shrink-0">
        <Shimmer className="h-3 w-full ml-auto" />
        <Shimmer className="h-3.5 w-3/4 ml-auto" />
      </div>

      {/* KYC */}
      <div className="w-24 flex justify-center shrink-0">
        <Shimmer className="h-5 w-16 rounded-full" />
      </div>

      {/* Days */}
      <div className="w-16 space-y-1.5 shrink-0">
        <Shimmer className="h-3 w-full" />
        <Shimmer className="h-3.5 w-1/2 mx-auto" />
      </div>

      {/* Rep */}
      <div className="w-28 shrink-0 hidden md:block">
        <Shimmer className="h-3 w-3/4 ml-auto" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SkeletonRows — renders N skeleton rows
// ---------------------------------------------------------------------------

/**
 * Renders N skeleton rows in a single wrapper.
 *
 * The wrapper carries `data-testid="skeleton-row"` so that integration tests
 * using `getByTestId('skeleton-row')` always find EXACTLY ONE element (Playwright
 * strict-mode locators throw if multiple elements match). Individual rows do not
 * carry the testid; the `SkeletonRow` component keeps its own testid for
 * isolated unit tests where only one row is rendered.
 */
export function SkeletonRows({ count = 8 }: { count?: number }) {
  return (
    // animate-pulse is on the wrapper (ONE animated element) so it does not
    // create per-row compositor layers that can stall the browser event loop
    // when more than ~5 rows are rendered simultaneously.
    <div
      data-testid="skeleton-row"
      aria-hidden="true"
      aria-label={`Loading ${count} rows`}
      className="animate-pulse"
    >
      {Array.from({ length: count }, (_, i) => (
        <SkeletonRowInner key={i} />
      ))}
    </div>
  );
}

/**
 * Inner skeleton row without a testid — used by SkeletonRows to avoid
 * Playwright strict-mode violations from multiple matching elements.
 */
function SkeletonRowInner() {
  return (
    <div
      className="flex items-center gap-4 px-4 py-3 border-b border-zinc-100"
      style={{ height: 72 }}
    >
      {/* Tier badge placeholder */}
      <div className="flex-shrink-0 w-10 flex justify-center">
        <Shimmer className="w-8 h-8 rounded-full" />
      </div>

      {/* Company / industry */}
      <div className="flex-1 min-w-0 space-y-1.5">
        <Shimmer className="h-3.5 w-2/3" />
        <Shimmer className="h-3 w-1/3" />
      </div>

      {/* CLTV */}
      <div className="w-32 space-y-1.5 shrink-0">
        <Shimmer className="h-3 w-full ml-auto" />
        <Shimmer className="h-3.5 w-3/4 ml-auto" />
      </div>

      {/* KYC */}
      <div className="w-24 flex justify-center shrink-0">
        <Shimmer className="h-5 w-16 rounded-full" />
      </div>

      {/* Days */}
      <div className="w-16 space-y-1.5 shrink-0">
        <Shimmer className="h-3 w-full" />
        <Shimmer className="h-3.5 w-1/2 mx-auto" />
      </div>

      {/* Rep */}
      <div className="w-28 shrink-0 hidden md:block">
        <Shimmer className="h-3 w-3/4 ml-auto" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SkeletonCard — matches PipelineCard layout
// ---------------------------------------------------------------------------

export function SkeletonCard() {
  return (
    <div
      aria-hidden="true"
      data-testid="skeleton-card"
      className="animate-pulse rounded-lg border border-zinc-200 bg-white p-3 space-y-2"
    >
      <div className="flex items-center justify-between">
        <Shimmer className="h-3.5 w-2/3" />
        <Shimmer className="h-5 w-5 rounded-full" />
      </div>
      <Shimmer className="h-3 w-1/2" />
      <div className="flex items-center justify-between">
        <Shimmer className="h-3 w-1/3" />
        <Shimmer className="h-3 w-1/4" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SkeletonChart — matches CFO chart panel outer dimensions
// ---------------------------------------------------------------------------

export function SkeletonChart() {
  return (
    <div
      aria-hidden="true"
      data-testid="skeleton-chart"
      className="animate-pulse rounded-xl border border-gray-200 bg-white p-6"
    >
      {/* Chart title area */}
      <div className="flex items-center justify-between mb-4">
        <Shimmer className="h-4 w-40" />
        <Shimmer className="h-7 w-36 rounded-lg" />
      </div>

      {/* Chart body */}
      <div className="space-y-2">
        <Shimmer className="h-40 w-full rounded-lg" />
        <div className="flex gap-4 mt-2">
          <Shimmer className="h-3 w-16" />
          <Shimmer className="h-3 w-16" />
          <Shimmer className="h-3 w-16" />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SkeletonBar — matches CfoSummaryBar layout (5 tiles)
// ---------------------------------------------------------------------------

export function SkeletonBar() {
  return (
    <div
      aria-hidden="true"
      data-testid="skeleton-bar"
      aria-label="CFO executive summary bar loading"
      className="animate-pulse sticky top-0 z-10 w-full bg-gray-50 border-b border-gray-200 px-6 py-3"
    >
      <div className="flex flex-wrap gap-3 items-start">
        {Array.from({ length: 5 }, (_, i) => (
          <div
            key={i}
            className="flex flex-col gap-2 px-4 py-3 bg-white border border-gray-200 rounded-lg min-w-[140px]"
          >
            <Shimmer className="h-3 w-16" />
            <Shimmer className="h-4 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}
