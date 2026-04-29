/**
 * @file pages/cfo-dashboard
 *
 * CFO dashboard page — Phase 2 P2-1 (issue #12), P2-4 AR aging (issue #16).
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
 */

import React from 'react';
import { CfoSummaryBar } from '../components/CfoSummaryBar';
import { TierTrendChart } from '../components/TierTrendChart';
import { ArAgingChart } from '../components/ArAgingChart';

export function CfoDashboardPage() {
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

        {/* Section: Collection recovery */}
        <section
          id="section-collection-recovery"
          aria-labelledby="section-collection-recovery-heading"
        >
          <h2
            id="section-collection-recovery-heading"
            className="text-lg font-semibold text-gray-800 mb-4"
          >
            Collection Recovery (90d)
          </h2>
          <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-gray-400">
            Collection recovery chart — coming in P2-5
          </div>
        </section>

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
