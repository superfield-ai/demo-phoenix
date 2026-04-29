/**
 * @file pages/cfo-dashboard
 *
 * CFO dashboard page — Phase 2 P2-1 (issue #12), P2-4 AR aging (issue #16),
 * invoice creation and payment recording (issue #47).
 *
 * Renders the executive summary bar at the top and placeholder sections for
 * each chart. Each section has a stable id so the summary bar tiles can
 * scroll to them.
 *
 * Accessible only to authenticated users with role 'cfo' or 'finance_controller'.
 *
 * Canonical docs: docs/prd.md
 * Issues:
 *   https://github.com/superfield-ai/demo-phoenix/issues/12
 *   https://github.com/superfield-ai/demo-phoenix/issues/16
 *   https://github.com/superfield-ai/demo-phoenix/issues/47
 */

import React from 'react';
import { useAuth } from '../context/AuthContext';
import { CfoSummaryBar } from '../components/CfoSummaryBar';
import { TierTrendChart } from '../components/TierTrendChart';
import { ArAgingChart } from '../components/ArAgingChart';
import { CollectionsPerformancePanel } from '../components/CollectionsPerformancePanel';
import { InvoicePanel } from '../components/InvoicePanel';
import { WriteOffApprovalsPanel } from '../components/WriteOffApprovalsPanel';

export function CfoDashboardPage() {
  const { user } = useAuth();
  const canViewWriteOffApprovals = user?.role === 'finance_controller' || user?.isSuperadmin;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Sticky executive summary bar */}
      <CfoSummaryBar />

      {/* Main content with chart section anchors */}
      <main className="max-w-7xl mx-auto px-6 py-8 space-y-12">
        <h1 className="text-2xl font-bold text-gray-900">CFO Dashboard</h1>

        {/* Section: Lead score tier trend (issue #15) */}
        <section id="section-tier-trend" aria-labelledby="section-tier-trend-heading">
          <h2 id="section-tier-trend-heading" className="text-lg font-semibold text-gray-800 mb-4">
            Lead Score Tier Trend
          </h2>
          <TierTrendChart />
        </section>

        {/* Section: Pipeline by tier */}
        <section id="section-pipeline" aria-labelledby="section-pipeline-heading">
          <h2 id="section-pipeline-heading" className="text-lg font-semibold text-gray-800 mb-4">
            Pipeline by Tier
          </h2>
          <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-gray-400">
            Pipeline chart — coming in P2-2
          </div>
        </section>

        {/* Section: Weighted close rate */}
        <section id="section-close-rate" aria-labelledby="section-close-rate-heading">
          <h2 id="section-close-rate-heading" className="text-lg font-semibold text-gray-800 mb-4">
            Weighted Close Rate
          </h2>
          <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-gray-400">
            Close rate chart — coming in P2-3
          </div>
        </section>

        {/* Section: AR aging */}
        <section id="section-ar-aging" aria-labelledby="section-ar-aging-heading">
          <h2 id="section-ar-aging-heading" className="text-lg font-semibold text-gray-800 mb-4">
            AR Aging
          </h2>
          <ArAgingChart />
        </section>

        {/* Section: Collection recovery + performance panel */}
        <section
          id="section-collection-recovery"
          aria-labelledby="section-collection-recovery-heading"
        >
          <h2
            id="section-collection-recovery-heading"
            className="text-lg font-semibold text-gray-800 mb-4"
          >
            Collections Performance
          </h2>
          <CollectionsPerformancePanel />
        </section>

        {/* Section: Invoices — create and payment recording (issue #47) */}
        <section id="section-invoices" aria-labelledby="section-invoices-heading">
          <h2 id="section-invoices-heading" className="text-lg font-semibold text-gray-800 mb-4">
            Invoices
          </h2>
          <InvoicePanel />
        </section>

        {/* Section: Write-off approvals */}
        {canViewWriteOffApprovals && (
          <section
            id="section-write-off-approvals"
            aria-labelledby="section-write-off-approvals-heading"
          >
            <h2
              id="section-write-off-approvals-heading"
              className="text-lg font-semibold text-gray-800 mb-4"
            >
              Write-Off Approvals
            </h2>
            <WriteOffApprovalsPanel />
          </section>
        )}

        {/* Section: Score model */}
        <section id="section-score-model" aria-labelledby="section-score-model-heading">
          <h2 id="section-score-model-heading" className="text-lg font-semibold text-gray-800 mb-4">
            Active Score Model
          </h2>
          <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-gray-400">
            Score model details — coming in a future phase
          </div>
        </section>
      </main>
    </div>
  );
}
