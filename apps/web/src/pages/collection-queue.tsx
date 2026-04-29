/**
 * @file collection-queue.tsx
 *
 * Collections Agent case queue page (issue #49).
 *
 * Shows all CollectionCases assigned to the logged-in agent, sorted by
 * escalation level and days overdue. Clicking a row opens the case detail page.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/49
 */

import React, { useCallback, useEffect, useState } from 'react';
import { SkeletonRows } from '../components/Skeleton';
import { ContextualEmptyState } from '../components/ContextualEmptyState';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CollectionCaseStatus = 'open' | 'resolved' | 'escalated' | 'written_off';

export interface CollectionCaseRow {
  id: string;
  invoice_id: string;
  agent_id: string | null;
  status: CollectionCaseStatus;
  escalation_level: number;
  resolution_type: string | null;
  opened_at: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  invoice_amount: number;
  invoice_currency: string;
  invoice_due_date: string | null;
  invoice_status: string;
  days_overdue: number;
  customer_name: string;
  customer_id: string;
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<CollectionCaseStatus, { bg: string; text: string; label: string }> = {
  open: { bg: 'bg-blue-100', text: 'text-blue-800', label: 'Open' },
  escalated: { bg: 'bg-red-100', text: 'text-red-800', label: 'Escalated' },
  resolved: { bg: 'bg-green-100', text: 'text-green-800', label: 'Resolved' },
  written_off: { bg: 'bg-zinc-100', text: 'text-zinc-600', label: 'Written Off' },
};

function StatusBadge({ status }: { status: CollectionCaseStatus }) {
  const styles = STATUS_STYLES[status] ?? {
    bg: 'bg-zinc-100',
    text: 'text-zinc-600',
    label: status,
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${styles.bg} ${styles.text}`}
      data-testid="case-status-badge"
    >
      {styles.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Case row
// ---------------------------------------------------------------------------

function formatAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

interface CaseRowProps {
  caseRow: CollectionCaseRow;
  onSelect: (id: string) => void;
}

function CaseRow({ caseRow, onSelect }: CaseRowProps) {
  const content = (
    <>
      {/* Mobile layout */}
      <div className="flex md:hidden w-full items-start gap-3 py-1">
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-1">
            <p className="font-semibold text-sm text-zinc-900 truncate">{caseRow.customer_name}</p>
            <StatusBadge status={caseRow.status} />
          </div>
          <div className="flex items-center gap-3 mt-1">
            <span className="text-xs text-zinc-500">
              {formatAmount(caseRow.invoice_amount, caseRow.invoice_currency)}
            </span>
            <span className="text-xs text-zinc-500">{caseRow.days_overdue}d overdue</span>
            {caseRow.escalation_level > 0 && (
              <span className="text-xs font-semibold text-red-600">
                Level {caseRow.escalation_level}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Desktop layout */}
      <div className="hidden md:flex w-full items-center gap-4">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm text-zinc-900 truncate">{caseRow.customer_name}</p>
          <p className="text-xs text-zinc-500 truncate">
            Invoice #{caseRow.invoice_id.slice(0, 8)}
          </p>
        </div>
        <div className="w-28 text-right shrink-0">
          <p className="text-sm font-medium text-zinc-700">
            {formatAmount(caseRow.invoice_amount, caseRow.invoice_currency)}
          </p>
        </div>
        <div className="w-24 text-center shrink-0">
          <p className="text-xs text-zinc-400 uppercase tracking-wide">Overdue</p>
          <p className="text-sm font-medium text-zinc-700">{caseRow.days_overdue}d</p>
        </div>
        <div className="w-24 text-center shrink-0">
          <p className="text-xs text-zinc-400 uppercase tracking-wide">Escalation</p>
          <p className="text-sm font-medium text-zinc-700">Level {caseRow.escalation_level}</p>
        </div>
        <div className="w-28 text-center shrink-0">
          <StatusBadge status={caseRow.status} />
        </div>
      </div>
    </>
  );

  return (
    <button
      type="button"
      onClick={() => onSelect(caseRow.id)}
      className="w-full block px-4 py-3 border-b border-zinc-100 hover:bg-zinc-50 transition-colors text-left min-h-[44px]"
      aria-label={`Open case for ${caseRow.customer_name}`}
      data-testid={`case-row-${caseRow.id}`}
    >
      {content}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

type StatusFilter = 'active' | 'all';

export function CollectionQueuePage({
  onSelectCase,
}: {
  onSelectCase?: (id: string) => void;
} = {}) {
  const [cases, setCases] = useState<CollectionCaseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');

  const fetchCases = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const statusParam =
        statusFilter === 'active'
          ? 'status=open,escalated'
          : 'status=open,escalated,resolved,written_off';
      const res = await fetch(`/api/collection-cases?${statusParam}`, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { cases: CollectionCaseRow[] };
      setCases(data.cases);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load case queue');
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void fetchCases();
  }, [fetchCases]);

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Header */}
      <div className="px-6 py-4 border-b border-zinc-200">
        <h1 className="text-xl font-bold text-zinc-900">Case Queue</h1>
        <p className="text-sm text-zinc-500 mt-0.5">
          CollectionCases assigned to you — sorted by escalation and days overdue
        </p>
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-1 px-6 pt-3 border-b border-zinc-200">
        {(['active', 'all'] as StatusFilter[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setStatusFilter(tab)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
              statusFilter === tab
                ? 'bg-white border border-b-white border-zinc-200 text-indigo-700 -mb-px'
                : 'text-zinc-500 hover:text-zinc-700'
            }`}
            data-testid={`tab-${tab}`}
          >
            {tab === 'active'
              ? `Active (${cases.filter((c) => c.status === 'open' || c.status === 'escalated').length})`
              : `All (${cases.length})`}
          </button>
        ))}
      </div>

      {/* Column headers — hidden on mobile */}
      {!loading && cases.length > 0 && (
        <div className="hidden md:flex items-center gap-4 px-4 py-2 bg-zinc-50 border-b border-zinc-200 text-xs font-medium text-zinc-500 uppercase tracking-wide">
          <div className="flex-1">Customer</div>
          <div className="w-28 text-right shrink-0">Amount</div>
          <div className="w-24 text-center shrink-0">Overdue</div>
          <div className="w-24 text-center shrink-0">Escalation</div>
          <div className="w-28 text-center shrink-0">Status</div>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && <SkeletonRows count={1} />}

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {!loading && error && <div className="px-6 py-8 text-center text-red-500">{error}</div>}
        {!loading && !error && cases.length === 0 && (
          <ContextualEmptyState
            message="No cases assigned to you"
            detail="New cases will appear here when the dunning engine assigns them."
            testId="collection-queue-empty-state"
          />
        )}
        {!loading && !error && cases.length > 0 && (
          <div>
            {cases.map((c) => (
              <CaseRow key={c.id} caseRow={c} onSelect={onSelectCase ?? (() => {})} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
