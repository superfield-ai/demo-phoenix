/**
 * @file InvoicePanel
 *
 * Invoice creation and payment recording panel (issue #47).
 *
 * Renders:
 *   - A list of recent invoices (filtered by status or customer).
 *   - A form to create a new invoice (finance_controller only).
 *   - A drilldown view for a selected invoice showing payment history and a
 *     form to record a new payment (finance_controller only).
 *
 * Role-gated: cfo and finance_controller can view; only finance_controller
 * can create invoices or record payments.
 *
 * Canonical docs: docs/prd.md §4.3
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/47
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { SkeletonRows } from './Skeleton';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type InvoiceStatus =
  | 'draft'
  | 'sent'
  | 'partial_paid'
  | 'overdue'
  | 'in_collection'
  | 'paid'
  | 'settled'
  | 'written_off';

interface Invoice {
  id: string;
  customer_id: string;
  customer_name: string;
  amount: number;
  currency: string;
  due_date: string | null;
  status: InvoiceStatus;
  issued_at: string | null;
  created_at: string;
  updated_at: string;
}

interface Payment {
  id: string;
  invoice_id: string;
  amount: number;
  method: string | null;
  received_at: string;
  recorded_by: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  partial_paid: 'Partial',
  overdue: 'Overdue',
  in_collection: 'In Collection',
  paid: 'Paid',
  settled: 'Settled',
  written_off: 'Written Off',
};

const STATUS_COLORS: Record<InvoiceStatus, string> = {
  draft: 'bg-gray-100 text-gray-700',
  sent: 'bg-blue-100 text-blue-700',
  partial_paid: 'bg-yellow-100 text-yellow-700',
  overdue: 'bg-orange-100 text-orange-700',
  in_collection: 'bg-red-100 text-red-700',
  paid: 'bg-green-100 text-green-700',
  settled: 'bg-emerald-100 text-emerald-700',
  written_off: 'bg-gray-200 text-gray-500',
};

function fmt(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface CreateInvoiceFormProps {
  onCreated: (invoice: Invoice) => void;
}

function CreateInvoiceForm({ onCreated }: CreateInvoiceFormProps) {
  const [customerId, setCustomerId] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [dueDate, setDueDate] = useState('');
  const [send, setSend] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsedAmount = parseFloat(amount);
    if (!customerId.trim()) {
      setError('Customer ID is required.');
      return;
    }
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      setError('Amount must be a positive number.');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/invoices', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_id: customerId.trim(),
          amount: parsedAmount,
          currency,
          due_date: dueDate || null,
          send,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError((data as { error?: string }).error ?? `Request failed (${res.status})`);
        return;
      }

      const invoice = (await res.json()) as Invoice;
      onCreated(invoice);
      // Reset form
      setCustomerId('');
      setAmount('');
      setDueDate('');
      setSend(false);
    } catch {
      setError('Network error — please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-gray-200 bg-white p-6 space-y-4"
      data-testid="invoice-create-form"
    >
      <h3 className="text-base font-semibold text-gray-900">Create Invoice</h3>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="inv-customer-id">
            Customer ID
          </label>
          <input
            id="inv-customer-id"
            type="text"
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            placeholder="e.g. cust_abc123"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="inv-amount">
            Amount
          </label>
          <input
            id="inv-amount"
            type="number"
            min="0.01"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="1000.00"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="inv-currency">
            Currency
          </label>
          <select
            id="inv-currency"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
          >
            <option value="USD">USD</option>
            <option value="EUR">EUR</option>
            <option value="GBP">GBP</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="inv-due-date">
            Due Date
          </label>
          <input
            id="inv-due-date"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <input
          id="inv-send"
          type="checkbox"
          checked={send}
          onChange={(e) => setSend(e.target.checked)}
          className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-400"
        />
        <label htmlFor="inv-send" className="text-sm text-gray-700">
          Send immediately (transitions to &quot;Sent&quot; status)
        </label>
      </div>

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          data-testid="invoice-submit-btn"
        >
          {submitting ? 'Creating…' : 'Create Invoice'}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// RecordPaymentForm
// ---------------------------------------------------------------------------

interface RecordPaymentFormProps {
  invoiceId: string;
  onRecorded: (payment: Payment) => void;
}

function RecordPaymentForm({ invoiceId, onRecorded }: RecordPaymentFormProps) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      setError('Amount must be a positive number.');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/invoices/${invoiceId}/payments`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: parsedAmount,
          method: method || null,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError((data as { error?: string }).error ?? `Request failed (${res.status})`);
        return;
      }

      const payment = (await res.json()) as Payment;
      onRecorded(payment);
      setAmount('');
      setMethod('');
    } catch {
      setError('Network error — please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-lg border border-gray-200 bg-gray-50 p-4 space-y-3"
      data-testid="payment-record-form"
    >
      <h4 className="text-sm font-semibold text-gray-800">Record Payment</h4>

      {error && (
        <div className="rounded bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      <div className="flex gap-3">
        <div className="flex-1">
          <label className="block text-xs font-medium text-gray-600 mb-1" htmlFor="pay-amount">
            Amount
          </label>
          <input
            id="pay-amount"
            type="number"
            min="0.01"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="500.00"
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
            required
          />
        </div>

        <div className="flex-1">
          <label className="block text-xs font-medium text-gray-600 mb-1" htmlFor="pay-method">
            Method
          </label>
          <select
            id="pay-method"
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
          >
            <option value="">— Select —</option>
            <option value="bank_transfer">Bank Transfer</option>
            <option value="credit_card">Credit Card</option>
            <option value="check">Check</option>
            <option value="cash">Cash</option>
          </select>
        </div>
      </div>

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50 transition-colors"
          data-testid="payment-submit-btn"
        >
          {submitting ? 'Recording…' : 'Record Payment'}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// InvoiceDetail
// ---------------------------------------------------------------------------

interface InvoiceDetailProps {
  invoice: Invoice;
  canWrite: boolean;
  onBack: () => void;
  onPaymentRecorded: (inv: Invoice) => void;
}

function InvoiceDetail({
  invoice: initialInvoice,
  canWrite,
  onBack,
  onPaymentRecorded,
}: InvoiceDetailProps) {
  const [invoice, setInvoice] = useState(initialInvoice);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loadingPayments, setLoadingPayments] = useState(true);

  const loadPayments = useCallback(async () => {
    setLoadingPayments(true);
    try {
      const res = await fetch(`/api/invoices/${invoice.id}/payments`, { credentials: 'include' });
      if (res.ok) {
        const data = (await res.json()) as { payments: Payment[] };
        setPayments(data.payments);
      }
    } finally {
      setLoadingPayments(false);
    }
  }, [invoice.id]);

  useEffect(() => {
    loadPayments();
  }, [loadPayments]);

  async function handlePaymentRecorded(payment: Payment) {
    // Refresh the invoice to get updated status.
    const res = await fetch(`/api/invoices/${invoice.id}`, { credentials: 'include' });
    if (res.ok) {
      const updated = (await res.json()) as Invoice;
      setInvoice(updated);
      onPaymentRecorded(updated);
    }
    setPayments((prev) => [payment, ...prev]);
  }

  const TERMINAL = new Set(['paid', 'settled', 'written_off']);
  const isTerminal = TERMINAL.has(invoice.status);

  return (
    <div className="space-y-6" data-testid="invoice-detail">
      <button
        onClick={onBack}
        className="text-sm text-indigo-600 hover:underline flex items-center gap-1"
      >
        ← Back to invoices
      </button>

      <div className="rounded-xl border border-gray-200 bg-white p-6 space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">{invoice.customer_name}</h3>
            <p className="text-sm text-gray-500 mt-0.5">Invoice #{invoice.id.slice(0, 8)}</p>
          </div>
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[invoice.status]}`}
          >
            {STATUS_LABELS[invoice.status]}
          </span>
        </div>

        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <dt className="text-gray-500">Amount</dt>
            <dd className="font-semibold text-gray-900">{fmt(invoice.amount, invoice.currency)}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Due date</dt>
            <dd className="font-semibold text-gray-900">{fmtDate(invoice.due_date)}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Issued</dt>
            <dd className="font-semibold text-gray-900">{fmtDate(invoice.issued_at)}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Created</dt>
            <dd className="font-semibold text-gray-900">{fmtDate(invoice.created_at)}</dd>
          </div>
        </dl>
      </div>

      {/* Payment recording form — only for finance_controller and non-terminal invoices */}
      {canWrite && !isTerminal && (
        <RecordPaymentForm invoiceId={invoice.id} onRecorded={handlePaymentRecorded} />
      )}

      {/* Payment history */}
      <div className="rounded-xl border border-gray-200 bg-white">
        <div className="px-6 py-4 border-b border-gray-100">
          <h4 className="text-sm font-semibold text-gray-800">Payment History</h4>
        </div>

        {loadingPayments ? (
          <div className="px-6 py-4">
            <SkeletonRows count={3} />
          </div>
        ) : payments.length === 0 ? (
          <div className="px-6 py-8 text-center text-sm text-gray-400">
            No payments recorded yet.
          </div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {payments.map((pay) => (
              <li key={pay.id} className="flex items-center justify-between px-6 py-3">
                <div className="text-sm">
                  <span className="font-medium text-gray-900">{fmt(pay.amount)}</span>
                  {pay.method && (
                    <span className="ml-2 text-gray-500 capitalize">
                      {pay.method.replace(/_/g, ' ')}
                    </span>
                  )}
                </div>
                <span className="text-xs text-gray-400">{fmtDate(pay.received_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main InvoicePanel
// ---------------------------------------------------------------------------

export function InvoicePanel() {
  const { user } = useAuth();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [statusFilter, setStatusFilter] = useState<InvoiceStatus | ''>('');

  const canWrite = user?.role === 'finance_controller' || user?.isSuperadmin === true;
  const canRead =
    user?.role === 'finance_controller' ||
    user?.role === 'cfo' ||
    user?.isCfo === true ||
    user?.isSuperadmin === true;

  const loadInvoices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      const res = await fetch(`/api/invoices${params.size ? `?${params}` : ''}`, {
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError((data as { error?: string }).error ?? `Error ${res.status}`);
        return;
      }
      const data = (await res.json()) as { invoices: Invoice[] };
      setInvoices(data.invoices);
    } catch {
      setError('Network error — please try again.');
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    if (canRead) loadInvoices();
  }, [canRead, loadInvoices]);

  if (!canRead) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-sm text-gray-400">
        Invoice data is restricted to CFO and Finance Controller roles.
      </div>
    );
  }

  if (selectedInvoice) {
    return (
      <InvoiceDetail
        invoice={selectedInvoice}
        canWrite={canWrite}
        onBack={() => setSelectedInvoice(null)}
        onPaymentRecorded={(updated) => {
          setInvoices((prev) => prev.map((inv) => (inv.id === updated.id ? updated : inv)));
          setSelectedInvoice(updated);
        }}
      />
    );
  }

  return (
    <div className="space-y-6" data-testid="invoice-panel">
      {/* Create invoice form — finance_controller only */}
      {canWrite && (
        <CreateInvoiceForm
          onCreated={(inv) => {
            setInvoices((prev) => [inv, ...prev]);
          }}
        />
      )}

      {/* Invoice list */}
      <div className="rounded-xl border border-gray-200 bg-white">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-800">Invoices</h3>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as InvoiceStatus | '')}
            className="rounded-lg border border-gray-300 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-400"
            aria-label="Filter by status"
          >
            <option value="">All statuses</option>
            {(Object.keys(STATUS_LABELS) as InvoiceStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>

        {error && (
          <div className="px-6 py-4 text-sm text-red-700 bg-red-50 border-b border-red-100">
            {error}
          </div>
        )}

        {loading ? (
          <div className="px-6 py-4">
            <SkeletonRows count={5} />
          </div>
        ) : invoices.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-gray-400">No invoices found.</div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {invoices.map((inv) => (
              <li key={inv.id}>
                <button
                  onClick={() => setSelectedInvoice(inv)}
                  className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-gray-50 transition-colors"
                  data-testid={`invoice-row-${inv.id}`}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {inv.customer_name}
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      Due {fmtDate(inv.due_date)} · #{inv.id.slice(0, 8)}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 ml-4 shrink-0">
                    <span className="text-sm font-semibold text-gray-900">
                      {fmt(inv.amount, inv.currency)}
                    </span>
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[inv.status]}`}
                    >
                      {STATUS_LABELS[inv.status]}
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
