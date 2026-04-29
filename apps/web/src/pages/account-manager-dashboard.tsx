/**
 * @file account-manager-dashboard.tsx
 *
 * Account Manager customer health dashboard (issue #55).
 *
 * Default landing view for the account_manager role. Shows assigned customers
 * sorted by health score ascending (most at-risk first), with:
 *   - Health score (or "—" when null)
 *   - Trend indicator: up / down / stable
 *   - Alert badge when score < warning threshold (0.70)
 *   - Alert age: days open without a logged intervention
 *
 * Clicking a customer row opens a detail panel showing the current score,
 * contributing signals with source labels, and a 30-day score trend sparkline.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/55
 */

import React, { useCallback, useEffect, useState } from 'react';
import { SkeletonRows } from '../components/Skeleton';
import { ContextualEmptyState } from '../components/ContextualEmptyState';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HealthTrend = 'up' | 'down' | 'stable';

export interface CustomerHealthRow {
  id: string;
  company_name: string;
  segment: string | null;
  health_score: number | null;
  trend: HealthTrend;
  has_alert: boolean;
  alert_days: number | null;
}

export interface HealthSignal {
  id: string;
  source_label: string;
  contribution: number;
  recorded_at: string;
}

export interface CustomerHealthDetail extends CustomerHealthRow {
  signals: HealthSignal[];
  score_history: Array<{ recorded_at: string; score: number }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEALTH_ALERT_THRESHOLD = 0.7;

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function formatScore(score: number | null): string {
  if (score === null) return '—';
  return `${Math.round(score * 100)}`;
}

function scoreColor(score: number | null): string {
  if (score === null) return 'text-zinc-400';
  if (score < HEALTH_ALERT_THRESHOLD) return 'text-red-600 font-semibold';
  if (score < 0.85) return 'text-amber-600 font-semibold';
  return 'text-green-600 font-semibold';
}

// ---------------------------------------------------------------------------
// Alert badge
// ---------------------------------------------------------------------------

function AlertBadge({ alertDays }: { alertDays: number | null }) {
  const label = alertDays !== null && alertDays > 0 ? `${alertDays}d` : 'New';
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700"
      data-testid="health-alert-badge"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-red-500 inline-block" />
      Alert {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Trend indicator
// ---------------------------------------------------------------------------

function TrendIcon({ trend }: { trend: HealthTrend }) {
  if (trend === 'up') {
    return (
      <span
        className="text-green-500 text-sm font-bold"
        aria-label="Trend: improving"
        data-testid="trend-up"
      >
        ↑
      </span>
    );
  }
  if (trend === 'down') {
    return (
      <span
        className="text-red-500 text-sm font-bold"
        aria-label="Trend: declining"
        data-testid="trend-down"
      >
        ↓
      </span>
    );
  }
  return (
    <span className="text-zinc-400 text-sm" aria-label="Trend: stable" data-testid="trend-stable">
      →
    </span>
  );
}

// ---------------------------------------------------------------------------
// Sparkline (SVG mini-chart)
// ---------------------------------------------------------------------------

function Sparkline({ history }: { history: Array<{ recorded_at: string; score: number }> }) {
  if (history.length < 2) {
    return <div className="text-xs text-zinc-400 italic">No history</div>;
  }

  const W = 160;
  const H = 40;
  const scores = history.map((h) => h.score);
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);
  const range = maxScore - minScore || 0.01;

  const points = scores.map((s, i) => {
    const x = (i / (scores.length - 1)) * W;
    const y = H - ((s - minScore) / range) * (H - 4) - 2;
    return `${x},${y}`;
  });

  const polyline = points.join(' ');

  // Colour based on the latest score.
  const latest = scores[scores.length - 1];
  const stroke =
    latest < HEALTH_ALERT_THRESHOLD ? '#ef4444' : latest < 0.85 ? '#f59e0b' : '#22c55e';

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      aria-label="30-day health score trend"
      data-testid="health-sparkline"
    >
      <polyline
        points={polyline}
        fill="none"
        stroke={stroke}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Customer row
// ---------------------------------------------------------------------------

interface CustomerRowProps {
  customer: CustomerHealthRow;
  onSelect: (id: string) => void;
  isSelected: boolean;
}

function CustomerRow({ customer, onSelect, isSelected }: CustomerRowProps) {
  const content = (
    <>
      {/* Mobile layout */}
      <div className="flex md:hidden w-full items-start gap-3 py-1">
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-1">
            <p className="font-semibold text-sm text-zinc-900 truncate">{customer.company_name}</p>
            {customer.has_alert && <AlertBadge alertDays={customer.alert_days} />}
          </div>
          <div className="flex items-center gap-3 mt-1">
            <span className={`text-sm ${scoreColor(customer.health_score)}`}>
              {formatScore(customer.health_score)}
            </span>
            <TrendIcon trend={customer.trend} />
            {customer.segment && <span className="text-xs text-zinc-500">{customer.segment}</span>}
          </div>
        </div>
      </div>

      {/* Desktop layout */}
      <div className="hidden md:flex w-full items-center gap-4">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm text-zinc-900 truncate">{customer.company_name}</p>
          {customer.segment && <p className="text-xs text-zinc-500 truncate">{customer.segment}</p>}
        </div>
        <div className="w-20 text-center shrink-0">
          <p className="text-xs text-zinc-400 uppercase tracking-wide">Score</p>
          <p className={`text-sm ${scoreColor(customer.health_score)}`}>
            {formatScore(customer.health_score)}
          </p>
        </div>
        <div className="w-16 text-center shrink-0">
          <p className="text-xs text-zinc-400 uppercase tracking-wide">Trend</p>
          <TrendIcon trend={customer.trend} />
        </div>
        <div className="w-32 text-center shrink-0">
          {customer.has_alert ? (
            <AlertBadge alertDays={customer.alert_days} />
          ) : (
            <span className="text-xs text-zinc-400">—</span>
          )}
        </div>
      </div>
    </>
  );

  return (
    <button
      type="button"
      onClick={() => onSelect(customer.id)}
      className={`w-full block px-4 py-3 border-b border-zinc-100 hover:bg-zinc-50 transition-colors text-left min-h-[44px] ${
        isSelected ? 'bg-indigo-50 border-l-2 border-l-indigo-500' : ''
      }`}
      aria-label={`View health details for ${customer.company_name}`}
      data-testid={`customer-row-${customer.id}`}
    >
      {content}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

function DetailPanel({ detail, onClose }: { detail: CustomerHealthDetail; onClose: () => void }) {
  return (
    <div
      className="flex flex-col h-full bg-white border-l border-zinc-200 w-full md:w-96 shrink-0"
      data-testid="customer-detail-panel"
    >
      {/* Header */}
      <div className="px-6 py-4 border-b border-zinc-200 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-zinc-900">{detail.company_name}</h2>
          {detail.segment && <p className="text-sm text-zinc-500">{detail.segment}</p>}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-zinc-400 hover:text-zinc-700 transition-colors p-1"
          aria-label="Close detail panel"
          data-testid="detail-panel-close"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
        {/* Score + alert */}
        <div>
          <p className="text-xs text-zinc-400 uppercase tracking-wide mb-1">Current Health Score</p>
          <div className="flex items-center gap-3">
            <span
              className={`text-3xl font-bold ${scoreColor(detail.health_score)}`}
              data-testid="detail-health-score"
            >
              {formatScore(detail.health_score)}
            </span>
            <TrendIcon trend={detail.trend} />
          </div>
          {detail.has_alert && (
            <div className="mt-2" data-testid="detail-alert-age">
              <AlertBadge alertDays={detail.alert_days} />
              {detail.alert_days !== null && detail.alert_days > 0 && (
                <p className="text-xs text-red-600 mt-1">
                  {detail.alert_days} day{detail.alert_days !== 1 ? 's' : ''} without a logged
                  intervention
                </p>
              )}
            </div>
          )}
        </div>

        {/* Sparkline */}
        {detail.score_history.length > 0 && (
          <div>
            <p className="text-xs text-zinc-400 uppercase tracking-wide mb-2">30-Day Trend</p>
            <Sparkline history={detail.score_history} />
          </div>
        )}

        {/* Signals */}
        <div>
          <p className="text-xs text-zinc-400 uppercase tracking-wide mb-2">Contributing Signals</p>
          {detail.signals.length === 0 ? (
            <p className="text-sm text-zinc-400 italic">No signal data available</p>
          ) : (
            <ul className="space-y-2" data-testid="signal-list">
              {detail.signals.map((sig) => (
                <li key={sig.id} className="flex items-center justify-between gap-2">
                  <span
                    className="text-sm text-zinc-700 capitalize"
                    data-testid={`signal-label-${sig.source_label}`}
                  >
                    {sig.source_label.replace(/_/g, ' ')}
                  </span>
                  <span
                    className={`text-sm font-semibold tabular-nums ${
                      sig.contribution < 0 ? 'text-red-600' : 'text-green-600'
                    }`}
                    data-testid={`signal-contribution-${sig.source_label}`}
                  >
                    {sig.contribution > 0 ? '+' : ''}
                    {(sig.contribution * 100).toFixed(0)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export function AccountManagerDashboardPage() {
  const [customers, setCustomers] = useState<CustomerHealthRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CustomerHealthDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const fetchCustomers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/account-manager/customers', { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { customers: CustomerHealthRow[] };
      setCustomers(data.customers);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load customers');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchCustomers();
  }, [fetchCustomers]);

  const handleSelectCustomer = useCallback(async (id: string) => {
    setSelectedId(id);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/account-manager/customers/${id}`, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as CustomerHealthDetail;
      setDetail(data);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : 'Failed to load customer detail');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const alertCount = customers.filter((c) => c.has_alert).length;

  return (
    <div
      className="flex flex-col md:flex-row h-full bg-white"
      data-testid="account-manager-dashboard"
    >
      {/* Customer list panel */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-zinc-200">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h1 className="text-xl font-bold text-zinc-900">Customer Health</h1>
              <p className="text-sm text-zinc-500 mt-0.5">
                Assigned customers — sorted by health score
              </p>
            </div>
            {alertCount > 0 && (
              <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-semibold bg-red-100 text-red-700">
                {alertCount} at risk
              </span>
            )}
          </div>
        </div>

        {/* Column headers — desktop only */}
        {!loading && customers.length > 0 && (
          <div className="hidden md:flex items-center gap-4 px-4 py-2 bg-zinc-50 border-b border-zinc-200 text-xs font-medium text-zinc-500 uppercase tracking-wide">
            <div className="flex-1">Customer</div>
            <div className="w-20 text-center shrink-0">Score</div>
            <div className="w-16 text-center shrink-0">Trend</div>
            <div className="w-32 text-center shrink-0">Alert</div>
          </div>
        )}

        {/* Loading skeleton */}
        {loading && <SkeletonRows count={1} />}

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {!loading && error && <div className="px-6 py-8 text-center text-red-500">{error}</div>}
          {!loading && !error && customers.length === 0 && (
            <ContextualEmptyState
              message="No customers assigned to you"
              detail="Customers will appear here once your account manager profile is configured."
              testId="account-manager-empty-state"
            />
          )}
          {!loading && !error && customers.length > 0 && (
            <div>
              {customers.map((c) => (
                <CustomerRow
                  key={c.id}
                  customer={c}
                  onSelect={handleSelectCustomer}
                  isSelected={selectedId === c.id}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Detail panel (shown when a customer is selected) */}
      {selectedId && (
        <div className="flex flex-col h-full border-l border-zinc-200 w-full md:w-96 shrink-0 overflow-hidden">
          {detailLoading && (
            <div className="flex items-center justify-center h-full">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-600" />
            </div>
          )}
          {!detailLoading && detailError && (
            <div className="px-6 py-8 text-center text-red-500">{detailError}</div>
          )}
          {!detailLoading && !detailError && detail && (
            <DetailPanel
              detail={detail}
              onClose={() => {
                setSelectedId(null);
                setDetail(null);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
