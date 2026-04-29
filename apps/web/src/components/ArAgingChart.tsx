/**
 * @file ArAgingChart
 *
 * AR Aging stacked bar chart with 12-month trend line and invoice drilldown
 * panel (issue #16).
 *
 * Renders:
 *   - A stacked bar chart with five aging buckets (current / 30 / 60 / 90 / 120+)
 *     colored on a green-to-red spectrum by risk level.
 *   - A 12-month trend line overlay showing the total AR over time.
 *   - A drilldown panel that opens when a bar segment is clicked, showing the
 *     invoice list for that bucket sorted by amount descending (read-only).
 *
 * Role-gated to 'cfo' and 'finance_controller'.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/16
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { SkeletonChart } from './Skeleton';
import { ContextualEmptyState } from './ContextualEmptyState';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AgingBucket = 'current' | '30' | '60' | '90' | '120+';

interface ArAgingBuckets {
  current: number;
  '30': number;
  '60': number;
  '90': number;
  '120+': number;
}

interface ArAgingMonthlySnapshot {
  month: string;
  buckets: ArAgingBuckets;
}

interface ArAgingData {
  buckets: ArAgingBuckets;
  trend: ArAgingMonthlySnapshot[];
}

interface InvoiceRow {
  invoice_id: string;
  customer_name: string;
  amount: number;
  due_date: string;
  days_overdue: number;
  status: string;
  assigned_agent_name: string | null;
  collection_case_open: boolean;
  collection_case_escalation_level: number | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BUCKET_LABELS: AgingBucket[] = ['current', '30', '60', '90', '120+'];

const BUCKET_DISPLAY: Record<AgingBucket, string> = {
  current: 'Current',
  '30': '1–30 days',
  '60': '31–60 days',
  '90': '61–90 days',
  '120+': '91+ days',
};

/** Tailwind bg / text color per bucket (green → red spectrum). */
const BUCKET_COLORS: Record<AgingBucket, { bg: string; text: string; bar: string }> = {
  current: { bg: 'bg-green-100', text: 'text-green-800', bar: '#16a34a' },
  '30': { bg: 'bg-lime-100', text: 'text-lime-800', bar: '#65a30d' },
  '60': { bg: 'bg-yellow-100', text: 'text-yellow-800', bar: '#ca8a04' },
  '90': { bg: 'bg-orange-100', text: 'text-orange-800', bar: '#ea580c' },
  '120+': { bg: 'bg-red-100', text: 'text-red-800', bar: '#dc2626' },
};

const CFO_ROLES = new Set(['cfo', 'finance_controller']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function totalBuckets(b: ArAgingBuckets): number {
  return b.current + b['30'] + b['60'] + b['90'] + b['120+'];
}

// ---------------------------------------------------------------------------
// DrilldownPanel
// ---------------------------------------------------------------------------

interface DrilldownPanelProps {
  bucket: AgingBucket;
  onClose: () => void;
}

function DrilldownPanel({ bucket, onClose }: DrilldownPanelProps) {
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/cfo/ar-aging/invoices?bucket=${encodeURIComponent(bucket)}`, {
      credentials: 'include',
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<{ invoices: InvoiceRow[] }>;
      })
      .then((data) => setInvoices(data.invoices))
      .catch((err: Error) => setError(err.message ?? 'Failed to load invoices'))
      .finally(() => setLoading(false));
  }, [bucket]);

  const bucketColor = BUCKET_COLORS[bucket];

  return (
    <div
      role="dialog"
      aria-label={`Invoice drilldown for ${BUCKET_DISPLAY[bucket]} bucket`}
      className="mt-6 rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden"
    >
      {/* Header */}
      <div className={`flex items-center justify-between px-6 py-4 ${bucketColor.bg}`}>
        <div>
          <h3 className={`text-base font-semibold ${bucketColor.text}`}>
            Invoices — {BUCKET_DISPLAY[bucket]} overdue
          </h3>
          {!loading && !error && (
            <p className="text-xs text-gray-500 mt-0.5">
              {invoices.length} invoice{invoices.length !== 1 ? 's' : ''}, sorted by amount
              descending
            </p>
          )}
        </div>
        <button
          type="button"
          aria-label="Close drilldown panel"
          onClick={onClose}
          className="rounded-md p-1 text-gray-500 hover:bg-white/50 hover:text-gray-800 transition-colors"
        >
          ✕
        </button>
      </div>

      {/* Body */}
      <div className="overflow-x-auto">
        {loading && (
          <p className="px-6 py-8 text-sm text-gray-400 text-center">Loading invoices…</p>
        )}

        {error && <p className="px-6 py-8 text-sm text-red-600 text-center">Error: {error}</p>}

        {!loading && !error && invoices.length === 0 && (
          <p className="px-6 py-8 text-sm text-gray-400 text-center">No invoices in this bucket.</p>
        )}

        {!loading && !error && invoices.length > 0 && (
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wide text-xs">
                  Customer
                </th>
                <th className="px-4 py-3 text-right font-medium text-gray-500 uppercase tracking-wide text-xs">
                  Amount
                </th>
                <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wide text-xs">
                  Due Date
                </th>
                <th className="px-4 py-3 text-right font-medium text-gray-500 uppercase tracking-wide text-xs">
                  Days Overdue
                </th>
                <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wide text-xs">
                  Status
                </th>
                <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wide text-xs">
                  Assigned Agent
                </th>
                <th className="px-4 py-3 text-center font-medium text-gray-500 uppercase tracking-wide text-xs">
                  Collection Case
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {invoices.map((inv) => (
                <tr key={inv.invoice_id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">
                    {inv.customer_name}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-gray-800 whitespace-nowrap">
                    {fmt(inv.amount)}
                  </td>
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{inv.due_date}</td>
                  <td className="px-4 py-3 text-right text-gray-600 whitespace-nowrap">
                    {inv.days_overdue > 0 ? inv.days_overdue : '—'}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        inv.status === 'in_collection'
                          ? 'bg-red-100 text-red-700'
                          : inv.status === 'overdue'
                            ? 'bg-orange-100 text-orange-700'
                            : inv.status === 'partial_paid'
                              ? 'bg-yellow-100 text-yellow-700'
                              : 'bg-blue-100 text-blue-700'
                      }`}
                    >
                      {inv.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                    {inv.assigned_agent_name ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-center whitespace-nowrap">
                    {inv.collection_case_open ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
                        Open
                        {inv.collection_case_escalation_level != null && (
                          <span className="ml-0.5 text-red-500">
                            L{inv.collection_case_escalation_level}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-gray-400 text-xs">None</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ArAgingChart (main export)
// ---------------------------------------------------------------------------

export function ArAgingChart() {
  const { user } = useAuth();
  const [data, setData] = useState<ArAgingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeBucket, setActiveBucket] = useState<AgingBucket | null>(null);

  const isCfoUser = user?.role !== undefined && user.role !== null && CFO_ROLES.has(user.role);

  useEffect(() => {
    if (!isCfoUser) {
      setLoading(false);
      return;
    }

    fetch('/api/cfo/ar-aging', { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<ArAgingData>;
      })
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err: Error) => setError(err.message ?? 'Failed to load AR aging data'))
      .finally(() => setLoading(false));
  }, [isCfoUser]);

  const handleBarClick = useCallback((bucket: AgingBucket) => {
    setActiveBucket((prev) => (prev === bucket ? null : bucket));
  }, []);

  const handleCloseDrilldown = useCallback(() => setActiveBucket(null), []);

  if (!isCfoUser) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-gray-400 text-sm">
        AR aging data is only available to CFO and Finance Controller roles.
      </div>
    );
  }

  if (loading) {
    return <SkeletonChart />;
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-8 text-center text-red-600 text-sm">
        Failed to load AR aging data: {error}
      </div>
    );
  }

  if (!data) return null;

  const { buckets, trend } = data;
  const grandTotal = totalBuckets(buckets);

  // Compute max total across all months for bar chart scaling.
  const maxMonthTotal = Math.max(1, ...trend.map((snap) => totalBuckets(snap.buckets)));

  return (
    <div aria-label="AR aging dashboard">
      {/* Current snapshot: bucket summary tiles */}
      <div className="grid grid-cols-5 gap-3 mb-6">
        {BUCKET_LABELS.map((bucket) => {
          const amount = buckets[bucket];
          const pct = grandTotal > 0 ? ((amount / grandTotal) * 100).toFixed(1) : '0.0';
          const colors = BUCKET_COLORS[bucket];
          const isActive = activeBucket === bucket;
          return (
            <button
              key={bucket}
              type="button"
              aria-label={`${BUCKET_DISPLAY[bucket]} bucket: ${fmt(amount)} — click to drill down`}
              aria-pressed={isActive}
              onClick={() => handleBarClick(bucket)}
              className={`rounded-xl border p-4 text-left transition-all cursor-pointer ${colors.bg} ${
                isActive ? 'ring-2 ring-offset-1 ring-gray-400 shadow-md' : 'hover:shadow-md'
              }`}
            >
              <div className={`text-xs font-medium uppercase tracking-wide ${colors.text} mb-1`}>
                {BUCKET_DISPLAY[bucket]}
              </div>
              <div className={`text-lg font-bold ${colors.text}`}>{fmt(amount)}</div>
              <div className="text-xs text-gray-500 mt-0.5">{pct}% of total</div>
            </button>
          );
        })}
      </div>

      {/* 12-month trend: stacked bar chart (SVG) */}
      <div className="rounded-xl border border-gray-200 bg-white p-6 mb-6">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">12-Month AR Aging Trend</h3>

        {trend.length === 0 ? (
          <ContextualEmptyState
            message="No AR aging history yet — this chart populates once invoices have been tracked for at least one month"
            testId="ar-aging-trend-empty-state"
          />
        ) : (
          <div className="overflow-x-auto">
            <svg
              role="img"
              aria-label="12-month AR aging stacked bar chart"
              viewBox={`0 0 ${trend.length * 52} 200`}
              className="w-full"
              style={{ minWidth: `${trend.length * 52}px`, height: '200px' }}
            >
              {trend.map((snap, i) => {
                const x = i * 52 + 4;
                const barWidth = 40;
                const chartHeight = 160;
                const total = totalBuckets(snap.buckets);
                let yOffset = chartHeight; // start from bottom

                const segments = BUCKET_LABELS.map((bucket) => {
                  const val = snap.buckets[bucket];
                  const h = total > 0 ? (val / maxMonthTotal) * chartHeight : 0;
                  yOffset -= h;
                  return { bucket, h, y: yOffset };
                });

                return (
                  <g key={snap.month}>
                    {segments.map(({ bucket, h, y }) =>
                      h > 0 ? (
                        <rect
                          key={bucket}
                          x={x}
                          y={y}
                          width={barWidth}
                          height={h}
                          fill={BUCKET_COLORS[bucket].bar}
                          opacity={activeBucket === null || activeBucket === bucket ? 1 : 0.3}
                          style={{ cursor: 'pointer' }}
                          onClick={() => handleBarClick(bucket)}
                          aria-label={`${snap.month} ${BUCKET_DISPLAY[bucket]}: ${fmt(snap.buckets[bucket])}`}
                        />
                      ) : null,
                    )}
                    {/* Trend total dot */}
                    {total > 0 && (
                      <circle
                        cx={x + barWidth / 2}
                        cy={chartHeight - (total / maxMonthTotal) * chartHeight}
                        r={3}
                        fill="#6366f1"
                        opacity={0.8}
                      />
                    )}
                    {/* Month label */}
                    <text
                      x={x + barWidth / 2}
                      y={chartHeight + 16}
                      textAnchor="middle"
                      fontSize={9}
                      fill="#6b7280"
                    >
                      {snap.month.slice(5)} {/* MM */}
                    </text>
                  </g>
                );
              })}
              {/* Connect trend dots with a line */}
              {trend.length > 1 && (
                <polyline
                  points={trend
                    .map((snap, i) => {
                      const x = i * 52 + 4 + 20;
                      const total = totalBuckets(snap.buckets);
                      const y = total > 0 ? 160 - (total / maxMonthTotal) * 160 : 160;
                      return `${x},${y}`;
                    })
                    .join(' ')}
                  fill="none"
                  stroke="#6366f1"
                  strokeWidth={1.5}
                  opacity={0.6}
                />
              )}
            </svg>
            {/* Legend */}
            <div className="flex flex-wrap gap-3 mt-3 justify-center">
              {BUCKET_LABELS.map((bucket) => (
                <span key={bucket} className="flex items-center gap-1 text-xs text-gray-600">
                  <span
                    className="inline-block w-3 h-3 rounded-sm"
                    style={{ backgroundColor: BUCKET_COLORS[bucket].bar }}
                  />
                  {BUCKET_DISPLAY[bucket]}
                </span>
              ))}
              <span className="flex items-center gap-1 text-xs text-gray-600">
                <span className="inline-block w-3 h-1 rounded-sm bg-indigo-500 opacity-70" />
                Total trend
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Invoice drilldown panel */}
      {activeBucket !== null && (
        <DrilldownPanel bucket={activeBucket} onClose={handleCloseDrilldown} />
      )}
    </div>
  );
}
