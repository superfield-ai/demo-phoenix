/**
 * @file WriteOffApprovalsPanel
 *
 * Finance Controller queue for settlement proposals that require approval.
 * Shows pending, approved, and rejected write-off requests and lets the
 * Finance Controller approve or reject pending items.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/51
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';

type Tab = 'pending' | 'approved' | 'rejected';

interface WriteOffApproval {
  id: string;
  collection_case_id: string;
  invoice_id: string;
  customer_id: string;
  customer_name: string;
  invoice_amount: number;
  proposed_by: string;
  reviewed_by: string | null;
  settlement_amount: number;
  implied_write_off_amount: number;
  status: 'pending_approval' | 'approved' | 'rejected';
  notes: string | null;
  review_notes: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface QueueResponse {
  requests: WriteOffApproval[];
  threshold: number;
}

const FINANCE_ROLES = new Set(['finance_controller']);

function fmt(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(amount);
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function statusLabel(status: Tab): string {
  if (status === 'pending') return 'Pending';
  if (status === 'approved') return 'Approved';
  return 'Rejected';
}

export function WriteOffApprovalsPanel() {
  const { user } = useAuth();
  const isFinanceController =
    user?.isSuperadmin === true ||
    (user?.role !== undefined && user.role !== null && FINANCE_ROLES.has(user.role));

  const [activeTab, setActiveTab] = useState<Tab>('pending');
  const [requests, setRequests] = useState<WriteOffApproval[]>([]);
  const [threshold, setThreshold] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notesById, setNotesById] = useState<Record<string, string>>({});
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const status = activeTab === 'pending' ? 'pending' : activeTab;
      const res = await fetch(`/api/write-off-approvals?status=${status}&limit=50`, {
        credentials: 'include',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as QueueResponse;
      setRequests(data.requests ?? []);
      setThreshold(Number.isFinite(data.threshold) ? data.threshold : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load write-off approvals');
    } finally {
      setLoading(false);
    }
  }, [activeTab]);

  useEffect(() => {
    if (!isFinanceController) {
      setLoading(false);
      return;
    }
    void fetchData();
  }, [fetchData, isFinanceController]);

  const updateNotes = useCallback((id: string, value: string) => {
    setNotesById((prev) => ({ ...prev, [id]: value }));
  }, []);

  const submitDecision = useCallback(
    async (id: string, decision: 'approved' | 'rejected') => {
      setActionInProgress(id);
      setActionError(null);
      try {
        const res = await fetch(`/api/write-off-approvals/${id}`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            decision,
            notes: notesById[id]?.trim() || null,
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        setNotesById((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        await fetchData();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Failed to update approval');
      } finally {
        setActionInProgress(null);
      }
    },
    [fetchData, notesById],
  );

  if (!isFinanceController) return null;

  return (
    <section className="space-y-4" data-testid="write-off-approvals-panel">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Write-Off Approvals</h2>
          <p className="text-sm text-gray-500">
            Settlement proposals above the threshold require Finance Controller review.
          </p>
        </div>
        {threshold !== null && Number.isFinite(threshold) && (
          <span className="text-xs font-medium text-gray-500">Threshold: {fmt(threshold)}</span>
        )}
      </div>

      <div className="flex gap-1 border-b border-zinc-200">
        {(['pending', 'approved', 'rejected'] as Tab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === tab
                ? 'border-emerald-500 text-emerald-700'
                : 'border-transparent text-zinc-500 hover:text-zinc-700 hover:border-zinc-300'
            }`}
          >
            {statusLabel(tab)}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {actionError && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          {actionError}
        </div>
      )}

      <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-24 text-zinc-400 text-sm">
            Loading approvals...
          </div>
        ) : requests.length === 0 ? (
          <div className="flex items-center justify-center h-24 text-zinc-400 text-sm">
            No {statusLabel(activeTab).toLowerCase()} requests found.
          </div>
        ) : (
          <div className="divide-y divide-zinc-100">
            {requests.map((request) => {
              const notesValue = notesById[request.id] ?? '';
              return (
                <div key={request.id} className="p-4 space-y-3">
                  <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-xs font-medium text-zinc-600">
                          {request.status.replace('_', ' ')}
                        </span>
                        <span className="font-mono text-xs text-zinc-400 truncate">
                          {request.id}
                        </span>
                      </div>
                      <p className="text-sm font-medium text-zinc-900">{request.customer_name}</p>
                      <p className="text-xs text-zinc-500">
                        Case {request.collection_case_id.slice(0, 8)} · Invoice{' '}
                        {fmt(request.invoice_amount)} · Settlement {fmt(request.settlement_amount)}{' '}
                        · Write-off {fmt(request.implied_write_off_amount)}
                      </p>
                      <p className="text-xs text-zinc-500">
                        Proposed by {request.proposed_by} · {fmtDate(request.created_at)}
                      </p>
                      {request.notes && (
                        <p className="text-xs text-zinc-500 whitespace-pre-wrap">{request.notes}</p>
                      )}
                      {request.review_notes && (
                        <p className="text-xs text-zinc-500 whitespace-pre-wrap">
                          Review: {request.review_notes}
                        </p>
                      )}
                    </div>

                    {activeTab === 'pending' && (
                      <div className="flex flex-col gap-2 md:w-80">
                        <textarea
                          value={notesValue}
                          onChange={(e) => updateNotes(request.id, e.target.value)}
                          rows={2}
                          placeholder="Optional review notes"
                          className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-300"
                        />
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void submitDecision(request.id, 'approved')}
                            disabled={actionInProgress === request.id}
                            className="px-3 py-2 rounded-lg bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 disabled:opacity-50 transition-colors"
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            onClick={() => void submitDecision(request.id, 'rejected')}
                            disabled={actionInProgress === request.id}
                            className="px-3 py-2 rounded-lg border border-red-200 text-red-600 text-xs font-medium hover:bg-red-50 disabled:opacity-50 transition-colors"
                          >
                            Reject
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                  {request.reviewed_by && (
                    <p className="text-xs text-zinc-400">
                      Reviewed by {request.reviewed_by}
                      {request.reviewed_at ? ` · ${fmtDate(request.reviewed_at)}` : ''}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
