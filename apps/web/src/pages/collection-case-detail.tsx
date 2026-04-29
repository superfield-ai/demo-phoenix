/**
 * @file collection-case-detail.tsx
 *
 * Collections Agent case detail page (issue #49).
 *
 * Shows:
 *   - Invoice info and customer info
 *   - Payment history (amounts + received_at dates)
 *   - Contact log chronology (prior contact attempts)
 *   - Dunning timeline panel (DunningActions for the invoice)
 *   - Form to log a new contact attempt
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/49
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Phone, Mail, Globe, Plus } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContactType = 'call' | 'email' | 'portal';

export interface ContactLog {
  id: string;
  collection_case_id: string;
  agent_id: string;
  contact_type: ContactType;
  outcome: string;
  notes: string | null;
  contacted_at: string;
  created_at: string;
}

export interface CaseDetail {
  id: string;
  invoice_id: string;
  agent_id: string | null;
  status: string;
  escalation_level: number;
  resolution_type: string | null;
  opened_at: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  invoice: {
    id: string;
    customer_id: string;
    amount: number;
    currency: string;
    due_date: string | null;
    status: string;
    issued_at: string | null;
    created_at: string;
  };
  customer: {
    id: string;
    company_name: string;
    segment: string | null;
  };
  payments: {
    id: string;
    amount: number;
    method: string | null;
    received_at: string | null;
  }[];
  contact_logs: ContactLog[];
  dunning_actions: {
    id: string;
    action_type: string;
    scheduled_at: string | null;
    sent_at: string | null;
    response: string | null;
    created_at: string;
  }[];
  payment_plans: PaymentPlanSummary[];
}

export interface PaymentPlanSummary {
  id: string;
  collection_case_id: string;
  total_amount: number;
  installment_count: number;
  installment_amount: number;
  next_due_date: string | null;
  status: 'current' | 'breached' | 'completed' | 'cancelled';
  created_at: string;
  updated_at: string;
}

export interface PaymentPlanInstallment {
  installment_number: number;
  due_date: string;
  amount: number;
  status: 'paid' | 'unpaid';
  paid_amount: number;
}

export interface PaymentPlanDetail extends PaymentPlanSummary {
  collection_case: {
    id: string;
    invoice_id: string;
    agent_id: string | null;
    status: string;
    resolution_type: string | null;
  };
  invoice: {
    id: string;
    customer_id: string;
    amount: number;
    currency: string;
    due_date: string | null;
    status: string;
    issued_at: string | null;
    created_at: string;
    updated_at: string;
  };
  customer: {
    id: string;
    company_name: string;
    segment: string | null;
  };
  installments: PaymentPlanInstallment[];
  payment_total: number;
  paid_installment_count: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

const DUNNING_ACTION_LABELS: Record<string, string> = {
  reminder_d1: 'D+1 Friendly Reminder',
  second_notice_d7: 'D+7 Second Notice',
  firm_notice_d14: 'D+14 Firm Notice',
  collection_d30: 'D+30 Collection Referral',
};

function dunningActionLabel(actionType: string): string {
  return DUNNING_ACTION_LABELS[actionType] ?? actionType;
}

const CONTACT_TYPE_ICONS: Record<ContactType, React.ReactNode> = {
  call: <Phone size={14} />,
  email: <Mail size={14} />,
  portal: <Globe size={14} />,
};

const PAYMENT_PLAN_STATUS_STYLES: Record<
  PaymentPlanSummary['status'],
  { bg: string; text: string; label: string }
> = {
  current: { bg: 'bg-amber-100', text: 'text-amber-800', label: 'Current' },
  breached: { bg: 'bg-red-100', text: 'text-red-800', label: 'Breached' },
  completed: { bg: 'bg-green-100', text: 'text-green-800', label: 'Completed' },
  cancelled: { bg: 'bg-zinc-100', text: 'text-zinc-600', label: 'Cancelled' },
};

function PaymentPlanStatusBadge({ status }: { status: PaymentPlanSummary['status'] }) {
  const styles = PAYMENT_PLAN_STATUS_STYLES[status];
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${styles.bg} ${styles.text}`}
    >
      {styles.label}
    </span>
  );
}

interface PaymentPlanFormProps {
  caseId: string;
  onCreated: (plan: PaymentPlanDetail) => void;
}

function PaymentPlanForm({ caseId, onCreated }: PaymentPlanFormProps) {
  const [totalAmount, setTotalAmount] = useState('');
  const [installmentCount, setInstallmentCount] = useState('3');
  const [firstDueDate, setFirstDueDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    const amount = Number(totalAmount);
    const count = Number(installmentCount);

    try {
      const res = await fetch(`/api/collection-cases/${caseId}/payment-plans`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          total_amount: amount,
          installment_count: count,
          first_due_date: firstDueDate,
        }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const plan = (await res.json()) as PaymentPlanDetail;
      onCreated(plan);
      setTotalAmount('');
      setInstallmentCount('3');
      setFirstDueDate('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create payment plan');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 space-y-4"
      onSubmit={handleSubmit}
      data-testid="payment-plan-form"
    >
      <div>
        <h3 className="text-sm font-semibold text-zinc-900">Propose Payment Plan</h3>
        <p className="text-xs text-zinc-500 mt-0.5">
          Configure the total amount, installment count, and first due date.
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <label className="block">
          <span className="block text-xs font-medium text-zinc-600 mb-1">Total amount</span>
          <input
            type="number"
            min="0.01"
            step="0.01"
            value={totalAmount}
            onChange={(e) => setTotalAmount(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-zinc-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            placeholder="2500.00"
            data-testid="payment-plan-total-amount"
          />
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-zinc-600 mb-1">Installments</span>
          <input
            type="number"
            min="1"
            step="1"
            value={installmentCount}
            onChange={(e) => setInstallmentCount(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-zinc-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            data-testid="payment-plan-installment-count"
          />
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-zinc-600 mb-1">First due date</span>
          <input
            type="date"
            value={firstDueDate}
            onChange={(e) => setFirstDueDate(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-zinc-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            data-testid="payment-plan-first-due-date"
          />
        </label>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
      <button
        type="submit"
        disabled={submitting}
        className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors min-h-[44px]"
        data-testid="payment-plan-submit-btn"
      >
        {submitting ? 'Saving…' : 'Create payment plan'}
      </button>
    </form>
  );
}

interface PaymentPlanPanelProps {
  caseId: string;
  paymentPlans: PaymentPlanSummary[];
  onPlanCreated: (plan: PaymentPlanDetail) => void;
}

function PaymentPlanPanel({ caseId, paymentPlans, onPlanCreated }: PaymentPlanPanelProps) {
  const currentPlan = paymentPlans.find((plan) => plan.status === 'current') ?? null;
  const displayedPlan = currentPlan ?? paymentPlans[0] ?? null;
  const canCreateNewPlan = currentPlan === null;
  const [planDetail, setPlanDetail] = useState<PaymentPlanDetail | null>(null);
  const [loading, setLoading] = useState(Boolean(displayedPlan));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!displayedPlan) {
      setPlanDetail(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/payment-plans/${displayedPlan.id}`, { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<PaymentPlanDetail>;
      })
      .then((plan) => {
        if (!cancelled) {
          setPlanDetail(plan);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message ?? 'Failed to load payment plan');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [displayedPlan?.id]);

  if (!displayedPlan) {
    return (
      <div
        className="space-y-4 rounded-xl border border-zinc-200 bg-white p-4"
        data-testid="payment-plan-panel"
      >
        <div>
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide mb-2">
            Payment Plan
          </h2>
          <p className="text-sm text-zinc-500">
            No active payment plan is configured for this case yet.
          </p>
        </div>
        <PaymentPlanForm caseId={caseId} onCreated={onPlanCreated} />
      </div>
    );
  }

  return (
    <section
      className="space-y-4 rounded-xl border border-zinc-200 bg-white p-4"
      data-testid="payment-plan-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide mb-1">
            Payment Plan
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <PaymentPlanStatusBadge status={displayedPlan.status} />
            <span className="text-sm text-zinc-500">
              Next due {planDetail?.next_due_date ? formatDate(planDetail.next_due_date) : '—'}
            </span>
          </div>
        </div>
        <div className="text-right">
          <p className="text-xs uppercase tracking-wide text-zinc-400">Payment total</p>
          <p className="text-sm font-semibold text-zinc-900">
            {formatAmount(planDetail?.payment_total ?? 0, detailCurrencyPlaceholder)}
          </p>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-zinc-500">Loading installment schedule…</p>
      ) : error ? (
        <p className="text-sm text-red-500">{error}</p>
      ) : planDetail ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div className="rounded-lg bg-zinc-50 border border-zinc-100 p-3">
              <p className="text-xs uppercase tracking-wide text-zinc-400">Total amount</p>
              <p className="font-semibold text-zinc-900">
                {formatAmount(planDetail.total_amount, planDetail.invoice.currency)}
              </p>
            </div>
            <div className="rounded-lg bg-zinc-50 border border-zinc-100 p-3">
              <p className="text-xs uppercase tracking-wide text-zinc-400">Installments</p>
              <p className="font-semibold text-zinc-900">{planDetail.installment_count}</p>
            </div>
            <div className="rounded-lg bg-zinc-50 border border-zinc-100 p-3">
              <p className="text-xs uppercase tracking-wide text-zinc-400">Per installment</p>
              <p className="font-semibold text-zinc-900">
                {formatAmount(planDetail.installment_amount, planDetail.invoice.currency)}
              </p>
            </div>
            <div className="rounded-lg bg-zinc-50 border border-zinc-100 p-3">
              <p className="text-xs uppercase tracking-wide text-zinc-400">Paid / total</p>
              <p className="font-semibold text-zinc-900">
                {formatAmount(planDetail.payment_total, planDetail.invoice.currency)} /{' '}
                {formatAmount(planDetail.total_amount, planDetail.invoice.currency)}
              </p>
            </div>
          </div>

          <div
            className="overflow-hidden rounded-lg border border-zinc-200"
            data-testid="payment-plan-schedule"
          >
            <table className="min-w-full divide-y divide-zinc-200 text-sm">
              <thead className="bg-zinc-50 text-zinc-500 uppercase tracking-wide text-xs">
                <tr>
                  <th className="px-3 py-2 text-left">#</th>
                  <th className="px-3 py-2 text-left">Due date</th>
                  <th className="px-3 py-2 text-left">Amount</th>
                  <th className="px-3 py-2 text-left">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {planDetail.installments.map((installment) => (
                  <tr key={installment.installment_number}>
                    <td className="px-3 py-2 text-zinc-600">{installment.installment_number}</td>
                    <td className="px-3 py-2 text-zinc-700">{formatDate(installment.due_date)}</td>
                    <td className="px-3 py-2 text-zinc-700">
                      {formatAmount(installment.amount, planDetail.invoice.currency)}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                          installment.status === 'paid'
                            ? 'bg-green-100 text-green-800'
                            : 'bg-amber-100 text-amber-800'
                        }`}
                      >
                        {installment.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {canCreateNewPlan && <PaymentPlanForm caseId={caseId} onCreated={onPlanCreated} />}
    </section>
  );
}

const detailCurrencyPlaceholder = 'USD';

// ---------------------------------------------------------------------------
// Contact log form
// ---------------------------------------------------------------------------

interface ContactLogFormProps {
  caseId: string;
  onSuccess: (log: ContactLog) => void;
}

function ContactLogForm({ caseId, onSuccess }: ContactLogFormProps) {
  const [contactType, setContactType] = useState<ContactType>('call');
  const [outcome, setOutcome] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!outcome.trim()) {
      setError('Outcome is required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/collection-cases/${caseId}/contacts`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact_type: contactType,
          outcome: outcome.trim(),
          notes: notes.trim() || null,
        }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const log = (await res.json()) as ContactLog;
      setOutcome('');
      setNotes('');
      setShowForm(false);
      onSuccess(log);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to log contact attempt');
    } finally {
      setSubmitting(false);
    }
  }

  if (!showForm) {
    return (
      <button
        type="button"
        onClick={() => setShowForm(true)}
        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors min-h-[44px]"
        data-testid="log-contact-btn"
      >
        <Plus size={16} />
        Log Contact Attempt
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="border border-zinc-200 rounded-xl p-4 bg-zinc-50 space-y-4"
      data-testid="contact-log-form"
    >
      <h3 className="text-sm font-semibold text-zinc-900">Log Contact Attempt</h3>

      {/* Contact type */}
      <div>
        <label className="block text-xs font-medium text-zinc-600 mb-1.5">Contact Type</label>
        <div className="flex gap-2">
          {(['call', 'email', 'portal'] as ContactType[]).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setContactType(type)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors min-h-[44px] ${
                contactType === type
                  ? 'bg-indigo-100 text-indigo-700 ring-1 ring-indigo-400'
                  : 'bg-white text-zinc-600 border border-zinc-200 hover:bg-zinc-100'
              }`}
              data-testid={`contact-type-${type}`}
            >
              {CONTACT_TYPE_ICONS[type]}
              {type.charAt(0).toUpperCase() + type.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Outcome */}
      <div>
        <label className="block text-xs font-medium text-zinc-600 mb-1.5" htmlFor="outcome">
          Outcome <span className="text-red-500">*</span>
        </label>
        <input
          id="outcome"
          type="text"
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          placeholder="e.g. Left voicemail, Payment promised by Friday"
          className="w-full px-3 py-2 rounded-lg border border-zinc-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          data-testid="contact-outcome-input"
        />
      </div>

      {/* Notes */}
      <div>
        <label className="block text-xs font-medium text-zinc-600 mb-1.5" htmlFor="notes">
          Notes
        </label>
        <textarea
          id="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional — additional context"
          rows={3}
          className="w-full px-3 py-2 rounded-lg border border-zinc-200 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500"
          data-testid="contact-notes-input"
        />
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors min-h-[44px]"
          data-testid="contact-submit-btn"
        >
          {submitting ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => {
            setShowForm(false);
            setError(null);
          }}
          className="px-4 py-2 rounded-lg bg-zinc-100 text-zinc-600 text-sm font-medium hover:bg-zinc-200 transition-colors min-h-[44px]"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

interface CollectionCaseDetailPageProps {
  caseId: string;
  onBack: () => void;
}

export function CollectionCaseDetailPage({ caseId, onBack }: CollectionCaseDetailPageProps) {
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/collection-cases/${caseId}`, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as CaseDetail;
      setDetail(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load case detail');
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    void fetchDetail();
  }, [fetchDetail]);

  function handleNewContactLog(log: ContactLog) {
    setDetail((prev) => {
      if (!prev) return prev;
      return { ...prev, contact_logs: [...prev.contact_logs, log] };
    });
  }

  function handleNewPaymentPlan(_plan: PaymentPlanDetail) {
    void fetchDetail();
  }

  if (loading) {
    return (
      <div className="flex flex-col h-full bg-white">
        <div className="px-4 py-3 border-b border-zinc-200">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-2 text-sm text-zinc-500 hover:text-zinc-700 transition-colors min-h-[44px]"
          >
            <ArrowLeft size={16} />
            Back to queue
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
        </div>
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="flex flex-col h-full bg-white">
        <div className="px-4 py-3 border-b border-zinc-200">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-2 text-sm text-zinc-500 hover:text-zinc-700 transition-colors min-h-[44px]"
          >
            <ArrowLeft size={16} />
            Back to queue
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <p className="text-red-500">{error ?? 'Case not found'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-white overflow-hidden" data-testid="case-detail">
      {/* Back button */}
      <div className="px-4 py-3 border-b border-zinc-200 shrink-0">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-2 text-sm text-zinc-500 hover:text-zinc-700 transition-colors min-h-[44px]"
        >
          <ArrowLeft size={16} />
          Back to queue
        </button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6 md:px-6">
        {/* Case header */}
        <div>
          <h1 className="text-xl font-bold text-zinc-900">{detail.customer.company_name}</h1>
          <div className="flex flex-wrap items-center gap-3 mt-1 text-sm text-zinc-500">
            <span>Case #{caseId.slice(0, 8)}</span>
            <span>
              Status: <span className="font-medium text-zinc-700 capitalize">{detail.status}</span>
            </span>
            <span>Escalation Level {detail.escalation_level}</span>
            <span>Opened {formatDate(detail.opened_at)}</span>
          </div>
        </div>

        {/* Invoice info */}
        <section>
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide mb-3">
            Invoice
          </h2>
          <div className="rounded-xl border border-zinc-200 p-4 bg-zinc-50 grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-xs text-zinc-400 mb-0.5">Amount</p>
              <p className="text-sm font-semibold text-zinc-900">
                {formatAmount(detail.invoice.amount, detail.invoice.currency)}
              </p>
            </div>
            <div>
              <p className="text-xs text-zinc-400 mb-0.5">Status</p>
              <p className="text-sm font-medium text-zinc-700 capitalize">
                {detail.invoice.status.replace('_', ' ')}
              </p>
            </div>
            <div>
              <p className="text-xs text-zinc-400 mb-0.5">Due Date</p>
              <p className="text-sm font-medium text-zinc-700">
                {formatDate(detail.invoice.due_date)}
              </p>
            </div>
            <div>
              <p className="text-xs text-zinc-400 mb-0.5">Invoice ID</p>
              <p className="text-xs font-mono text-zinc-500 truncate">{detail.invoice.id}</p>
            </div>
          </div>
        </section>

        {/* Customer info */}
        <section>
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide mb-3">
            Customer
          </h2>
          <div className="rounded-xl border border-zinc-200 p-4 bg-zinc-50 grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-zinc-400 mb-0.5">Company</p>
              <p className="text-sm font-semibold text-zinc-900">{detail.customer.company_name}</p>
            </div>
            {detail.customer.segment && (
              <div>
                <p className="text-xs text-zinc-400 mb-0.5">Segment</p>
                <p className="text-sm font-medium text-zinc-700">{detail.customer.segment}</p>
              </div>
            )}
          </div>
        </section>

        {/* Payment history */}
        <section>
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide mb-3">
            Payment History
          </h2>
          {detail.payments.length === 0 ? (
            <p className="text-sm text-zinc-400 italic">No payments recorded.</p>
          ) : (
            <div className="rounded-xl border border-zinc-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium text-zinc-500 uppercase tracking-wide">
                      Amount
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-zinc-500 uppercase tracking-wide">
                      Method
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-zinc-500 uppercase tracking-wide">
                      Received At
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {detail.payments.map((payment) => (
                    <tr key={payment.id}>
                      <td className="px-4 py-3 font-medium text-zinc-900">
                        {formatAmount(payment.amount, detail.invoice.currency)}
                      </td>
                      <td className="px-4 py-3 text-zinc-600">{payment.method ?? '—'}</td>
                      <td className="px-4 py-3 text-zinc-600">{formatDate(payment.received_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Payment plan */}
        <PaymentPlanPanel
          caseId={caseId}
          paymentPlans={detail.payment_plans}
          onPlanCreated={handleNewPaymentPlan}
        />

        {/* Contact log */}
        <section>
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide mb-3">
            Contact Log
          </h2>
          <div data-testid="contact-log" className="space-y-3 mb-4">
            {detail.contact_logs.length === 0 ? (
              <p className="text-sm text-zinc-400 italic">No contact attempts logged yet.</p>
            ) : (
              detail.contact_logs.map((log) => (
                <div
                  key={log.id}
                  className="flex gap-3 p-3 rounded-xl border border-zinc-200 bg-zinc-50"
                  data-testid={`contact-log-entry-${log.id}`}
                >
                  <div className="mt-0.5 text-zinc-400 shrink-0">
                    {CONTACT_TYPE_ICONS[log.contact_type]}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-xs font-semibold text-zinc-700 capitalize">
                        {log.contact_type}
                      </span>
                      <span className="text-xs text-zinc-400">
                        {formatDateTime(log.contacted_at)}
                      </span>
                    </div>
                    <p className="text-sm text-zinc-800 font-medium">{log.outcome}</p>
                    {log.notes && (
                      <p className="text-xs text-zinc-500 mt-0.5 whitespace-pre-wrap">
                        {log.notes}
                      </p>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
          <ContactLogForm caseId={caseId} onSuccess={handleNewContactLog} />
        </section>

        {/* Dunning timeline */}
        <section data-testid="dunning-timeline">
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide mb-3">
            Dunning Timeline
          </h2>
          {detail.dunning_actions.length === 0 ? (
            <p className="text-sm text-zinc-400 italic">No dunning actions on record.</p>
          ) : (
            <div data-testid="dunning-action-list" className="space-y-2">
              {detail.dunning_actions.map((action) => (
                <div
                  key={action.id}
                  className="flex items-start gap-3 p-3 rounded-xl border border-zinc-200 bg-zinc-50"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-zinc-800">
                      {dunningActionLabel(action.action_type)}
                    </p>
                    <div className="flex flex-wrap gap-3 mt-1 text-xs text-zinc-500">
                      {action.scheduled_at && (
                        <span>Scheduled: {formatDate(action.scheduled_at)}</span>
                      )}
                      {action.sent_at && <span>Sent: {formatDate(action.sent_at)}</span>}
                    </div>
                    {action.response && (
                      <p className="text-xs text-zinc-500 mt-0.5">{action.response}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
