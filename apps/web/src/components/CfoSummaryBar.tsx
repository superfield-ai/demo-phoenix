/**
 * @file CfoSummaryBar
 *
 * Sticky executive summary bar for the CFO dashboard (issue #12).
 *
 * Displays five metric tiles at the top of the CFO dashboard page:
 *   1. Pipeline by tier (A/B/C)
 *   2. Weighted close rate
 *   3. AR aging buckets (current/30/60/90/120+)
 *   4. Collection recovery rate (trailing 90 days)
 *   5. Active score model version
 *
 * Each tile is clickable and scrolls the page to the corresponding chart
 * section via its `section-` prefixed id.
 *
 * The bar is only rendered for users with role 'cfo' or 'finance_controller'.
 * The parent page must include matching section ids:
 *   - section-pipeline
 *   - section-close-rate
 *   - section-ar-aging
 *   - section-collection-recovery
 *   - section-score-model
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/12
 */

import React, { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { SkeletonBar } from './Skeleton';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PipelineByTier {
  A: number;
  B: number;
  C: number;
}

interface ArAgingBuckets {
  current: number;
  '30': number;
  '60': number;
  '90': number;
  '120+': number;
}

interface CfoSummaryData {
  pipeline_by_tier: PipelineByTier;
  weighted_close_rate: number;
  ar_aging_buckets: ArAgingBuckets;
  collection_recovery_rate_90d: number;
  active_score_model_version: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function scrollToSection(sectionId: string): void {
  const el = document.getElementById(sectionId);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

const CFO_ROLES = new Set(['cfo', 'finance_controller']);

// ---------------------------------------------------------------------------
// MetricTile
// ---------------------------------------------------------------------------

interface MetricTileProps {
  label: string;
  value: React.ReactNode;
  sectionId: string;
  /** aria-label for the clickable tile */
  ariaLabel: string;
}

function MetricTile({ label, value, sectionId, ariaLabel }: MetricTileProps) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      data-section={sectionId}
      onClick={() => scrollToSection(sectionId)}
      className="flex flex-col items-start gap-1 px-4 py-3 bg-white border border-gray-200 rounded-lg shadow-sm hover:shadow-md hover:border-blue-400 transition-all cursor-pointer min-w-[140px] text-left min-h-[44px]"
    >
      <span className="text-xs font-medium text-gray-500 uppercase tracking-wide leading-none">
        {label}
      </span>
      <span className="text-sm font-semibold text-gray-900 leading-snug">{value}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// CfoSummaryBar
// ---------------------------------------------------------------------------

export function CfoSummaryBar() {
  const { user } = useAuth();
  const [data, setData] = useState<CfoSummaryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const isCfoUser = user?.role !== undefined && user.role !== null && CFO_ROLES.has(user.role);

  useEffect(() => {
    if (!isCfoUser) {
      setLoading(false);
      return;
    }

    fetch('/api/cfo/summary', { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<CfoSummaryData>;
      })
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err: Error) => {
        setError(err.message ?? 'Failed to load summary');
      })
      .finally(() => setLoading(false));
  }, [isCfoUser]);

  // Hide for non-CFO users.
  if (!isCfoUser) return null;

  if (loading) {
    return <SkeletonBar />;
  }

  if (error) {
    return (
      <div
        aria-label="CFO executive summary bar error"
        className="sticky top-0 z-10 w-full bg-red-50 border-b border-red-200 px-6 py-3 flex items-center gap-2"
      >
        <span className="text-sm text-red-600">Summary unavailable: {error}</span>
      </div>
    );
  }

  if (!data) return null;

  const {
    pipeline_by_tier,
    weighted_close_rate,
    ar_aging_buckets,
    collection_recovery_rate_90d,
    active_score_model_version,
  } = data;

  return (
    <div
      aria-label="CFO executive summary bar"
      data-testid="cfo-summary-bar"
      className="sticky top-0 z-10 w-full bg-gray-50 border-b border-gray-200 px-6 py-3 overflow-x-auto"
    >
      <div className="flex gap-3 items-start min-w-max lg:min-w-0 lg:flex-wrap">
        {/* Tile 1: Pipeline by tier */}
        <MetricTile
          label="Pipeline"
          sectionId="section-pipeline"
          ariaLabel="Pipeline by tier — scroll to pipeline chart"
          value={
            <span className="flex gap-2">
              <span className="text-green-700">A: {fmt(pipeline_by_tier.A)}</span>
              <span className="text-yellow-700">B: {fmt(pipeline_by_tier.B)}</span>
              <span className="text-orange-700">C: {fmt(pipeline_by_tier.C)}</span>
            </span>
          }
        />

        {/* Tile 2: Weighted close rate */}
        <MetricTile
          label="Close Rate"
          sectionId="section-close-rate"
          ariaLabel="Weighted close rate — scroll to close rate chart"
          value={pct(weighted_close_rate)}
        />

        {/* Tile 3: AR aging */}
        <MetricTile
          label="AR Aging"
          sectionId="section-ar-aging"
          ariaLabel="AR aging buckets — scroll to AR aging chart"
          value={
            <span className="flex flex-col gap-0.5 text-xs">
              <span>Current: {fmt(ar_aging_buckets.current)}</span>
              <span>30d: {fmt(ar_aging_buckets['30'])}</span>
              <span>60d: {fmt(ar_aging_buckets['60'])}</span>
              <span>90d: {fmt(ar_aging_buckets['90'])}</span>
              <span>120d+: {fmt(ar_aging_buckets['120+'])}</span>
            </span>
          }
        />

        {/* Tile 4: Collection recovery rate */}
        <MetricTile
          label="Recovery (90d)"
          sectionId="section-collection-recovery"
          ariaLabel="Collection recovery rate — scroll to collection recovery chart"
          value={pct(collection_recovery_rate_90d)}
        />

        {/* Tile 5: Active score model version */}
        <MetricTile
          label="Score Model"
          sectionId="section-score-model"
          ariaLabel="Active score model version — scroll to score model section"
          value={active_score_model_version ?? '—'}
        />
      </div>
    </div>
  );
}
