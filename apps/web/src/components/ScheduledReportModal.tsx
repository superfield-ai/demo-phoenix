/**
 * @file ScheduledReportModal
 *
 * Modal for configuring a CFO scheduled report delivery (issue #18).
 *
 * Allows the CFO to set:
 *   - frequency: weekly | monthly
 *   - format:    pdf | csv
 *   - recipient_email
 *
 * On submit, POSTs to /api/cfo/scheduled-reports.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/18
 */

import React, { useState } from 'react';
import { X, Bell } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ScheduledReport {
  id: string;
  frequency: 'weekly' | 'monthly';
  format: 'pdf' | 'csv';
  recipient_email: string;
  created_at: string;
}

interface ScheduledReportModalProps {
  onClose: () => void;
  onCreated: (report: ScheduledReport) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function ScheduledReportModal({
  onClose,
  onCreated,
}: ScheduledReportModalProps): React.ReactElement {
  const [frequency, setFrequency] = useState<'weekly' | 'monthly'>('weekly');
  const [format, setFormat] = useState<'pdf' | 'csv'>('csv');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!recipientEmail || !recipientEmail.includes('@')) {
      setError('Please enter a valid email address.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/cfo/scheduled-reports', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frequency, format, recipient_email: recipientEmail }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }

      const data = (await res.json()) as { report: ScheduledReport };
      onCreated(data.report);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create scheduled report.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="schedule-report-modal-title"
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 relative">
        {/* Close button */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close scheduled report dialog"
          className="absolute top-4 right-4 text-zinc-400 hover:text-zinc-600 transition-colors"
        >
          <X size={18} />
        </button>

        {/* Header */}
        <div className="flex items-center gap-2 mb-5">
          <Bell size={18} className="text-indigo-500" />
          <h2 id="schedule-report-modal-title" className="text-base font-semibold text-zinc-900">
            Schedule Recurring Report
          </h2>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Frequency */}
          <div>
            <label
              htmlFor="sr-frequency"
              className="block text-xs font-medium text-zinc-600 mb-1.5"
            >
              Frequency
            </label>
            <select
              id="sr-frequency"
              value={frequency}
              onChange={(e) => setFrequency(e.target.value as 'weekly' | 'monthly')}
              className="w-full text-sm border border-zinc-200 rounded-lg px-3 py-2 bg-white text-zinc-700 focus:outline-none focus:ring-2 focus:ring-indigo-300"
            >
              <option value="weekly">Weekly (every Monday)</option>
              <option value="monthly">Monthly (1st of month)</option>
            </select>
          </div>

          {/* Format */}
          <div>
            <label htmlFor="sr-format" className="block text-xs font-medium text-zinc-600 mb-1.5">
              Format
            </label>
            <select
              id="sr-format"
              value={format}
              onChange={(e) => setFormat(e.target.value as 'pdf' | 'csv')}
              className="w-full text-sm border border-zinc-200 rounded-lg px-3 py-2 bg-white text-zinc-700 focus:outline-none focus:ring-2 focus:ring-indigo-300"
            >
              <option value="csv">CSV</option>
              <option value="pdf">PDF</option>
            </select>
          </div>

          {/* Recipient email */}
          <div>
            <label htmlFor="sr-email" className="block text-xs font-medium text-zinc-600 mb-1.5">
              Recipient email
            </label>
            <input
              id="sr-email"
              type="email"
              value={recipientEmail}
              onChange={(e) => setRecipientEmail(e.target.value)}
              placeholder="cfo@example.com"
              className="w-full text-sm border border-zinc-200 rounded-lg px-3 py-2 bg-white text-zinc-700 focus:outline-none focus:ring-2 focus:ring-indigo-300 placeholder-zinc-400"
              required
            />
          </div>

          {/* Error */}
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-zinc-600 border border-zinc-200 rounded-lg hover:bg-zinc-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {submitting ? 'Saving…' : 'Save schedule'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
