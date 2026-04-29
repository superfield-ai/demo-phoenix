/**
 * @file TierTrendChart
 *
 * Lead score tier trend chart for the CFO dashboard (issue #15).
 *
 * Renders a responsive SVG line chart showing:
 *   - Three tier percentage lines (A/B/C) on the primary Y axis (0–100 %)
 *   - Total qualified lead volume line on a secondary Y axis
 *   - Week labels on the X axis
 *
 * A quarter toggle lets the user switch between the current quarter and the
 * prior quarter. The component fetches /api/cfo/tier-trend automatically on
 * mount and on toggle change.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/15
 */

import React, { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { SkeletonChart } from './Skeleton';
import { ContextualEmptyState } from './ContextualEmptyState';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TierTrendBucket {
  week_start: string;
  tier_a_pct: number;
  tier_b_pct: number;
  tier_c_pct: number;
  total_volume: number;
}

type Period = 'current_quarter' | 'prior_quarter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CFO_ROLES = new Set(['cfo', 'finance_controller']);

/** Format an ISO date string as "MMM D" (e.g. "Jan 6"). */
function fmtWeek(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// ---------------------------------------------------------------------------
// SVG Line Chart
// ---------------------------------------------------------------------------

interface ChartProps {
  buckets: TierTrendBucket[];
}

function SvgLineChart({ buckets }: ChartProps) {
  const W = 600;
  const H = 260;
  const PAD = { top: 16, right: 70, bottom: 48, left: 44 };

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  if (buckets.length === 0) {
    // Empty state is handled by the parent TierTrendChart component.
    return null;
  }

  const n = buckets.length;

  // X scale: evenly space weeks
  const xOf = (i: number) => PAD.left + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);

  // Primary Y scale (0–100 %)
  const yPct = (v: number) => PAD.top + innerH - (v / 100) * innerH;

  // Secondary Y scale (volume)
  const maxVol = Math.max(...buckets.map((b) => b.total_volume), 1);
  const yVol = (v: number) => PAD.top + innerH - (v / maxVol) * innerH;

  // Build polyline point strings
  const pts = (accessor: (b: TierTrendBucket) => number, scale: (v: number) => number) =>
    buckets.map((b, i) => `${xOf(i).toFixed(1)},${scale(accessor(b)).toFixed(1)}`).join(' ');

  const tierAPoints = pts((b) => b.tier_a_pct, yPct);
  const tierBPoints = pts((b) => b.tier_b_pct, yPct);
  const tierCPoints = pts((b) => b.tier_c_pct, yPct);
  const volPoints = pts((b) => b.total_volume, yVol);

  // Y-axis grid lines at 0, 25, 50, 75, 100
  const yGrids = [0, 25, 50, 75, 100];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" aria-label="Tier trend line chart" role="img">
      {/* Grid lines */}
      {yGrids.map((v) => (
        <g key={v}>
          <line
            x1={PAD.left}
            y1={yPct(v)}
            x2={W - PAD.right}
            y2={yPct(v)}
            stroke="#e5e7eb"
            strokeWidth={1}
          />
          <text
            x={PAD.left - 4}
            y={yPct(v)}
            textAnchor="end"
            dominantBaseline="middle"
            fontSize={10}
            fill="#9ca3af"
          >
            {v}%
          </text>
        </g>
      ))}

      {/* X-axis week labels */}
      {buckets.map((b, i) => (
        <text
          key={b.week_start}
          x={xOf(i)}
          y={H - PAD.bottom + 14}
          textAnchor="middle"
          fontSize={9}
          fill="#6b7280"
        >
          {fmtWeek(b.week_start)}
        </text>
      ))}

      {/* Secondary Y axis label (volume) */}
      <text
        x={W - PAD.right + 4}
        y={PAD.top}
        fontSize={9}
        fill="#6b7280"
        dominantBaseline="hanging"
      >
        Vol
      </text>

      {/* Volume ticks on right axis */}
      {[0, Math.round(maxVol / 2), maxVol].map((v) => (
        <text
          key={v}
          x={W - PAD.right + 4}
          y={yVol(v)}
          fontSize={9}
          fill="#6b7280"
          dominantBaseline="middle"
        >
          {v}
        </text>
      ))}

      {/* Volume line (secondary, dashed grey) */}
      <polyline
        points={volPoints}
        fill="none"
        stroke="#9ca3af"
        strokeWidth={1.5}
        strokeDasharray="4 3"
      />

      {/* Tier C line (orange) */}
      <polyline points={tierCPoints} fill="none" stroke="#f97316" strokeWidth={2} />

      {/* Tier B line (yellow) */}
      <polyline points={tierBPoints} fill="none" stroke="#eab308" strokeWidth={2} />

      {/* Tier A line (green) */}
      <polyline points={tierAPoints} fill="none" stroke="#22c55e" strokeWidth={2.5} />

      {/* Data point dots */}
      {buckets.map((b, i) => (
        <g key={b.week_start}>
          <circle cx={xOf(i)} cy={yPct(b.tier_a_pct)} r={3} fill="#22c55e" />
          <circle cx={xOf(i)} cy={yPct(b.tier_b_pct)} r={3} fill="#eab308" />
          <circle cx={xOf(i)} cy={yPct(b.tier_c_pct)} r={3} fill="#f97316" />
        </g>
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

function Legend() {
  return (
    <div className="flex flex-wrap gap-4 text-xs text-gray-600 mt-2">
      <span className="flex items-center gap-1">
        <span className="inline-block w-4 h-0.5 bg-green-500 rounded" />
        Tier A %
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block w-4 h-0.5 bg-yellow-400 rounded" />
        Tier B %
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block w-4 h-0.5 bg-orange-400 rounded" />
        Tier C %
      </span>
      <span className="flex items-center gap-1">
        <span
          className="inline-block w-4 h-0.5 bg-gray-400 rounded"
          style={{ borderTop: '2px dashed #9ca3af', background: 'none', height: '0' }}
        />
        Volume (right axis)
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TierTrendChart (exported)
// ---------------------------------------------------------------------------

export function TierTrendChart() {
  const { user } = useAuth();
  const [period, setPeriod] = useState<Period>('current_quarter');
  const [buckets, setBuckets] = useState<TierTrendBucket[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isCfoUser = user?.role !== undefined && user.role !== null && CFO_ROLES.has(user.role);

  useEffect(() => {
    if (!isCfoUser) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    fetch(`/api/cfo/tier-trend?period=${period}`, { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<TierTrendBucket[]>;
      })
      .then((data) => {
        setBuckets(data);
      })
      .catch((err: Error) => {
        setError(err.message ?? 'Failed to load tier trend');
      })
      .finally(() => setLoading(false));
  }, [isCfoUser, period]);

  if (!isCfoUser) return null;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6">
      {/* Header + toggle */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-800">Lead Score Tier Trend</h3>
        <div
          className="flex rounded-lg border border-gray-200 overflow-hidden text-xs"
          role="group"
          aria-label="Quarter selector"
        >
          <button
            type="button"
            onClick={() => setPeriod('current_quarter')}
            aria-pressed={period === 'current_quarter'}
            className={`px-3 py-1.5 transition-colors ${
              period === 'current_quarter'
                ? 'bg-blue-600 text-white font-medium'
                : 'bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            Current Quarter
          </button>
          <button
            type="button"
            onClick={() => setPeriod('prior_quarter')}
            aria-pressed={period === 'prior_quarter'}
            className={`px-3 py-1.5 transition-colors border-l border-gray-200 ${
              period === 'prior_quarter'
                ? 'bg-blue-600 text-white font-medium'
                : 'bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            Prior Quarter
          </button>
        </div>
      </div>

      {/* Chart body */}
      {loading && <SkeletonChart />}

      {!loading && error && (
        <div className="flex items-center justify-center h-40 text-red-500 text-sm">{error}</div>
      )}

      {!loading && !error && buckets !== null && buckets.length === 0 && (
        <ContextualEmptyState
          message="No tier trend data yet — lead scoring must run for at least one week to populate this chart"
          testId="tier-trend-empty-state"
        />
      )}

      {!loading && !error && buckets !== null && buckets.length > 0 && (
        <>
          <SvgLineChart buckets={buckets} />
          <Legend />
        </>
      )}
    </div>
  );
}
