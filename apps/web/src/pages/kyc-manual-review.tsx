/**
 * @file kyc-manual-review.tsx
 *
 * Manual KYC review queue page (issue #52).
 *
 * Accessible to authorized reviewers (any role except sales_rep).
 * Lists prospects currently in kyc_manual_review stage with failure reason,
 * days since flag, and actions to verify or reject each prospect.
 *
 * Canonical docs: docs/prd.md §4.2
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/52
 */

import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle, XCircle, RefreshCw, AlertTriangle } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ManualReviewProspect {
  prospect_id: string;
  company_name: string;
  industry: string | null;
  kyc_failure_reason: string | null;
  kyc_checked_at: string | null;
  days_since_flag: number;
  kyc_record_id: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortDate(iso: string | null): string {
  if (!iso) return 'N/A';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ---------------------------------------------------------------------------
// Row component
// ---------------------------------------------------------------------------

function ReviewRow({
  prospect,
  onAction,
}: {
  prospect: ManualReviewProspect;
  onAction: (prospectId: string, action: 'verify' | 'reject') => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  const handleAction = async (action: 'verify' | 'reject') => {
    setBusy(true);
    try {
      await onAction(prospect.prospect_id, action);
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr className="border-b border-zinc-100 hover:bg-zinc-50">
      <td className="px-4 py-3 text-sm font-medium text-zinc-900">{prospect.company_name}</td>
      <td className="px-4 py-3 text-sm text-zinc-500">{prospect.industry ?? 'N/A'}</td>
      <td className="px-4 py-3 text-sm text-zinc-500">
        <span className="inline-flex items-center gap-1 text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full text-xs font-medium">
          <AlertTriangle size={11} />
          {prospect.kyc_failure_reason ?? 'failed'}
        </span>
      </td>
      <td className="px-4 py-3 text-sm text-zinc-500">
        {prospect.days_since_flag === 0 ? 'Today' : `${prospect.days_since_flag}d`}
      </td>
      <td className="px-4 py-3 text-sm text-zinc-500">{shortDate(prospect.kyc_checked_at)}</td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => handleAction('verify')}
            data-testid={`verify-${prospect.prospect_id}`}
            className="flex items-center gap-1 text-xs font-medium text-green-700 hover:text-green-800 bg-green-50 hover:bg-green-100 px-2.5 py-1 rounded-lg transition-colors disabled:opacity-50"
          >
            <CheckCircle size={12} />
            Verify
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => handleAction('reject')}
            data-testid={`reject-${prospect.prospect_id}`}
            className="flex items-center gap-1 text-xs font-medium text-red-700 hover:text-red-800 bg-red-50 hover:bg-red-100 px-2.5 py-1 rounded-lg transition-colors disabled:opacity-50"
          >
            <XCircle size={12} />
            Reject
          </button>
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export function KycManualReviewPage() {
  const [prospects, setProspects] = useState<ManualReviewProspect[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/kyc/manual-review', { credentials: 'include' });
      if (res.status === 403) {
        setError('You do not have permission to access the manual review queue.');
        return;
      }
      if (!res.ok) {
        setError('Failed to load manual review queue.');
        return;
      }
      const data = await res.json();
      setProspects((data as { prospects: ManualReviewProspect[] }).prospects ?? []);
    } catch {
      setError('Failed to load manual review queue.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAction = useCallback(
    async (prospectId: string, action: 'verify' | 'reject') => {
      setActionError(null);
      const res = await fetch(`/api/kyc/${prospectId}/review`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setActionError((body as { error?: string }).error ?? 'Action failed');
        return;
      }
      // Reload the queue after action.
      await load();
    },
    [load],
  );

  return (
    <div className="px-4 md:px-8 py-6 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-zinc-900">KYC Manual Review Queue</h1>
          <p className="text-sm text-zinc-500 mt-0.5">
            Prospects flagged for manual KYC review — verify or reject each prospect.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="flex items-center gap-2 text-sm font-medium text-zinc-600 hover:text-zinc-800 bg-zinc-100 hover:bg-zinc-200 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {actionError && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">
          {actionError}
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
        </div>
      )}

      {!loading && error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">
          {error}
        </div>
      )}

      {!loading && !error && prospects.length === 0 && (
        <div className="text-center py-16 text-zinc-400 text-sm">
          No prospects are currently pending manual KYC review.
        </div>
      )}

      {!loading && !error && prospects.length > 0 && (
        <div className="bg-white border border-zinc-200 rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50">
                <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-500 uppercase tracking-wide">
                  Company
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-500 uppercase tracking-wide">
                  Industry
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-500 uppercase tracking-wide">
                  KYC Result
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-500 uppercase tracking-wide">
                  Days Flagged
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-500 uppercase tracking-wide">
                  Last Check
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-500 uppercase tracking-wide">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {prospects.map((p) => (
                <ReviewRow key={p.prospect_id} prospect={p} onAction={handleAction} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
