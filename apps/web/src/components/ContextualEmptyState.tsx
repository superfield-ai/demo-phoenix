/**
 * @file ContextualEmptyState
 *
 * Contextual empty state component used across all data surfaces (issue #19).
 *
 * Every empty state rendered by the app must use this component with a
 * surface-specific message. Generic fallbacks like "No data" are prohibited.
 *
 * Usage:
 *   <ContextualEmptyState
 *     message="No qualified leads yet — KYC checks are running for 3 prospects"
 *     detail="Leads will appear here once scoring completes."
 *   />
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/19
 */

import React from 'react';

interface ContextualEmptyStateProps {
  /** Primary message — must be surface-specific and meaningful. */
  message: string;
  /** Optional supporting detail rendered beneath the primary message. */
  detail?: string;
  /** data-testid for test assertions (defaults to "contextual-empty-state"). */
  testId?: string;
}

export function ContextualEmptyState({
  message,
  detail,
  testId = 'contextual-empty-state',
}: ContextualEmptyStateProps) {
  return (
    <div
      data-testid={testId}
      className="flex flex-col items-center justify-center py-16 px-8 text-center"
    >
      <div className="w-12 h-12 rounded-full bg-zinc-100 flex items-center justify-center mb-4">
        <svg
          className="w-6 h-6 text-zinc-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
          />
        </svg>
      </div>
      <p className="text-sm font-medium text-zinc-700">{message}</p>
      {detail && <p className="text-xs text-zinc-500 mt-1 max-w-sm">{detail}</p>}
    </div>
  );
}
